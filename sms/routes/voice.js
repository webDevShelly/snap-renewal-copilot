const express = require('express');
const voice = require('../lib/voice');
const sessions = require('../lib/callSession');

// Statuses that mean this attempt is over and nobody is on the line.
const DEAD_STATUSES = ['failed', 'rejected', 'unanswered', 'busy', 'timeout', 'cancelled'];

const RETRY_DEFAULTS = {
  maxAttempts: Number(process.env.CALL_MAX_ATTEMPTS || 5),
  delayMs: Number(process.env.CALL_RETRY_DELAY_MS || 60000),
  // Give up on one attempt after this long on hold and start a fresh one; a
  // queue that never produces a person is usually a queue that closed.
  holdTimeoutMs: Number(process.env.CALL_HOLD_TIMEOUT_MS || 900000)
};

/**
 * The hold-for-me bridge.
 *
 * Three legs meet in one Vonage conversation:
 *   office   - the PSTN call to the benefits office
 *   listener - a muted websocket leg that streams the mix to the hold detector
 *   user     - dialed only once a human is detected, so the user never holds
 *
 * If the office never answers, drops, or holds past the timeout, the attempt is
 * retried on a backoff until maxAttempts. The user is told what is happening
 * rather than left in silence.
 */
module.exports = function voiceRoutes({ publicUrl, sendSms, retry = {} } = {}) {
  const router = express.Router();
  const config = { ...RETRY_DEFAULTS, ...retry };

  async function notify(session, message) {
    if (!sendSms) return;
    await sendSms(session.phoneNumber, message)
      .catch((error) => console.error('Could not text the user:', error.message));
  }

  function clearTimers(session) {
    for (const key of ['hold', 'retry']) {
      if (session.timers[key]) {
        clearTimeout(session.timers[key]);
        session.timers[key] = null;
      }
    }
  }

  function settled(session) {
    return ['human-detected', 'bridging', 'connected', 'ended'].includes(session.state);
  }

  /** Places the office leg and the muted listener leg, with a fresh detector. */
  async function placeOfficeLegs(session) {
    const { HoldDetector } = require('../lib/holdDetector');
    session.detector = new HoldDetector();
    session.attempts += 1;

    const office = await voice.createCall({
      to: [{ type: 'phone', number: session.officeNumber.replace(/^\+/, '') }],
      from: voice.sender(),
      answer_url: [publicUrl(`/voice/answer?session=${session.id}&leg=office`)],
      answer_method: 'GET',
      event_url: [publicUrl(`/voice/events?session=${session.id}&leg=office`)]
    });
    session.officeCallUuid = office.uuid;

    const listener = await voice.createCall({
      to: [{
        type: 'websocket',
        uri: `${publicUrl('/voice/socket').replace(/^http/, 'ws')}?session=${session.id}`,
        'content-type': 'audio/l16;rate=16000'
      }],
      from: voice.sender(),
      answer_url: [publicUrl(`/voice/answer?session=${session.id}&leg=listener`)],
      answer_method: 'GET',
      event_url: [publicUrl(`/voice/events?session=${session.id}&leg=listener`)]
    });
    session.listenerCallUuid = listener.uuid;

    sessions.setState(session.id, 'holding', `attempt ${session.attempts} of ${config.maxAttempts}`);

    clearTimers(session);
    if (config.holdTimeoutMs > 0) {
      session.timers.hold = setTimeout(() => {
        if (settled(session)) return;
        if (session.officeCallUuid) voice.hangUp(session.officeCallUuid).catch(() => {});
        if (session.listenerCallUuid) voice.hangUp(session.listenerCallUuid).catch(() => {});
        scheduleRetry(session, 'still on hold after the timeout');
      }, config.holdTimeoutMs);
      // A pending retry must never hold the process open.
      session.timers.hold.unref?.();
    }
    return session;
  }

  function giveUp(session, reason) {
    clearTimers(session);
    sessions.setState(session.id, 'failed', reason);
    return notify(
      session,
      `I tried the benefits office ${session.attempts} times and could not get through (${reason}). Your answers are saved. Reply CALL when you want me to try again.`
    );
  }

  /** Queues another attempt, or gives up once the budget is spent. */
  async function scheduleRetry(session, reason) {
    if (settled(session) || session.state === 'failed') return session;
    clearTimers(session);

    if (session.attempts >= config.maxAttempts) {
      await giveUp(session, reason);
      return session;
    }

    sessions.setState(session.id, 'retrying', reason);
    // Only on the first retry, so a long queue does not become a stream of texts.
    if (session.attempts === 1) {
      await notify(session, 'The benefits office did not pick up. I will keep trying and text you the moment someone answers. You do not need to do anything.');
    }

    // Back off a little further each attempt.
    const delay = config.delayMs * session.attempts;
    session.timers.retry = setTimeout(() => {
      placeOfficeLegs(session).catch(async (error) => {
        console.error('Retry could not be placed:', error.message);
        await scheduleRetry(session, `could not redial: ${error.message}`);
      });
    }, delay);
    session.timers.retry.unref?.();
    return session;
  }

  async function startRenewalCall(user) {
    if (!publicUrl('/')) throw new Error('PUBLIC_BASE_URL must be set before the copilot can place calls.');
    if (!voice.voiceConfigured()) throw new Error('Voice is not configured: set VONAGE_APPLICATION_ID and the private key.');
    const officeNumber = process.env.SNAP_OFFICE_NUMBER;
    if (!officeNumber) throw new Error('SNAP_OFFICE_NUMBER is not set.');

    const session = sessions.create({
      phoneNumber: user.phoneNumber,
      officeNumber,
      collected: user.renewal.collected
    });
    return placeOfficeLegs(session);
  }

  /** Dials the user in and steps the copilot out of the way. */
  async function bridgeUserIn(session, reason) {
    if (!['holding', 'retrying', 'human-detected'].includes(session.state)) return session;
    clearTimers(session);
    sessions.setState(session.id, 'human-detected', reason);

    try {
      const user = await voice.createCall({
        to: [{ type: 'phone', number: session.phoneNumber.replace(/^\+/, '') }],
        from: voice.sender(),
        answer_url: [publicUrl(`/voice/answer?session=${session.id}&leg=user`)],
        answer_method: 'GET',
        event_url: [publicUrl(`/voice/events?session=${session.id}&leg=user`)]
      });
      session.userCallUuid = user.uuid;
      sessions.setState(session.id, 'bridging', `user=${user.uuid}`);
      await notify(session, 'A caseworker just picked up. Answer your phone now, I am connecting you.');
    } catch (error) {
      sessions.setState(session.id, 'failed', `could not dial user: ${error.message}`);
      throw error;
    }

    if (session.listenerCallUuid) voice.hangUp(session.listenerCallUuid).catch(() => {});
    return session;
  }

  router.get('/answer', (req, res) => {
    const session = sessions.get(req.query.session);
    if (!session) return res.json([{ action: 'talk', text: 'This renewal session has expired. Goodbye.' }]);
    const conversation = { action: 'conversation', name: session.conversationName };

    if (req.query.leg === 'office') {
      return res.json([{ ...conversation, startOnEnter: true, endOnExit: false }]);
    }
    if (req.query.leg === 'listener') {
      return res.json([{ ...conversation, startOnEnter: false, endOnExit: false, canSpeak: [] }]);
    }
    if (req.query.leg === 'user') {
      return res.json([
        { action: 'talk', text: 'Connecting you to the benefits office now.', language: 'en-US' },
        { ...conversation, startOnEnter: true, endOnExit: true }
      ]);
    }
    return res.json([{ action: 'talk', text: 'Goodbye.' }]);
  });

  router.post('/events', async (req, res) => {
    const session = sessions.get(req.query.session);
    const { status, uuid } = req.body || {};
    res.sendStatus(204);
    if (!session || !status) return;

    session.events.push({ state: `${req.query.leg}:${status}`, detail: uuid || null, at: new Date().toISOString() });

    if (req.query.leg === 'user') {
      if (status === 'answered') sessions.setState(session.id, 'connected', 'user answered');
      return;
    }
    if (req.query.leg !== 'office' || settled(session)) return;

    if (DEAD_STATUSES.includes(status)) {
      await scheduleRetry(session, `office ${status}`);
      return;
    }
    // Answered then hung up before a person reached us: the line dropped.
    if (status === 'completed') {
      await scheduleRetry(session, 'the office line dropped before a person came on');
    }
  });

  // Escape hatch: energy alone cannot always tell an IVR from a person, so a
  // human watching the dashboard can force the bridge.
  router.post('/sessions/:id/human', async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'No such call session.' });
    try {
      await bridgeUserIn(session, 'confirmed manually');
      res.json({ id: session.id, state: session.state });
    } catch (error) {
      res.status(502).json({ error: error.message });
    }
  });

  router.post('/sessions/:id/cancel', async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'No such call session.' });
    clearTimers(session);
    for (const uuid of [session.officeCallUuid, session.listenerCallUuid]) {
      if (uuid) voice.hangUp(uuid).catch(() => {});
    }
    sessions.setState(session.id, 'ended', 'cancelled');
    res.json({ id: session.id, state: session.state });
  });

  router.get('/sessions', (req, res) => res.json(sessions.list()));

  /** Wired to the websocket upgrade in server.js. */
  function handleSocket(socket, sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return socket.close();

    socket.on('message', async (data, isBinary) => {
      if (!isBinary || session.state !== 'holding') return;
      if (!session.detector.push(Buffer.from(data))) return;
      try {
        await bridgeUserIn(session, 'hold detector heard a person');
      } catch (error) {
        console.error('Could not bridge the user in:', error.message);
      }
    });
    socket.on('error', (error) => console.error('Voice socket error:', error.message));
  }

  return { router, startRenewalCall, bridgeUserIn, scheduleRetry, handleSocket, config };
};
