const express = require('express');
const voice = require('../lib/voice');
const sessions = require('../lib/callSession');
const renewal = require('../lib/renewal');
const store = require('../lib/store');

/**
 * The hold-for-me bridge.
 *
 * Three legs meet in one Vonage conversation:
 *   office   - the PSTN call to the benefits office
 *   listener - a muted websocket leg that streams the mix to the hold detector
 *   user     - dialed only once a human is detected, so the user never holds
 */
module.exports = function voiceRoutes({ publicUrl, sendSms }) {
  const router = express.Router();

  function requireBaseUrl() {
    const base = publicUrl('/');
    if (!base) throw new Error('PUBLIC_BASE_URL must be set before the copilot can place calls.');
    return base;
  }

  async function startRenewalCall(user) {
    requireBaseUrl();
    if (!voice.voiceConfigured()) throw new Error('Voice is not configured: set VONAGE_APPLICATION_ID and the private key.');
    const officeNumber = process.env.SNAP_OFFICE_NUMBER;
    if (!officeNumber) throw new Error('SNAP_OFFICE_NUMBER is not set.');

    const session = sessions.create({
      phoneNumber: user.phoneNumber,
      officeNumber,
      collected: user.renewal.collected
    });

    const office = await voice.createCall({
      to: [{ type: 'phone', number: officeNumber.replace(/^\+/, '') }],
      from: voice.sender(),
      answer_url: [publicUrl(`/voice/answer?session=${session.id}&leg=office`)],
      answer_method: 'GET',
      event_url: [publicUrl(`/voice/events?session=${session.id}&leg=office`)]
    });
    session.officeCallUuid = office.uuid;

    // A websocket leg in the same conversation gives the detector the audio.
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

    sessions.setState(session.id, 'holding', `office=${office.uuid}`);
    return session;
  }

  /** Dials the user in and steps the copilot out of the way. */
  async function bridgeUserIn(session, reason) {
    if (!['holding', 'human-detected'].includes(session.state)) return session;
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

      if (sendSms) {
        await sendSms(session.phoneNumber, 'A caseworker just picked up. Answer your phone now, I am connecting you.')
          .catch((error) => console.error('Could not send the pickup text:', error.message));
      }
    } catch (error) {
      sessions.setState(session.id, 'failed', `could not dial user: ${error.message}`);
      throw error;
    }

    // The listener has done its job; drop it so it stops billing and streaming.
    if (session.listenerCallUuid) {
      voice.hangUp(session.listenerCallUuid).catch(() => {});
    }
    return session;
  }

  // Vonage fetches this for each leg to learn what that leg should do.
  router.get('/answer', (req, res) => {
    const session = sessions.get(req.query.session);
    if (!session) return res.json([{ action: 'talk', text: 'This renewal session has expired. Goodbye.' }]);
    const conversation = { action: 'conversation', name: session.conversationName };

    if (req.query.leg === 'office') {
      return res.json([{ ...conversation, startOnEnter: true, endOnExit: false }]);
    }
    if (req.query.leg === 'listener') {
      // Muted, and it must not start or end the conversation.
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

  router.post('/events', (req, res) => {
    const session = sessions.get(req.query.session);
    const { status, uuid } = req.body || {};
    if (session && status) {
      session.events.push({ state: `${req.query.leg}:${status}`, detail: uuid || null, at: new Date().toISOString() });
      if (req.query.leg === 'user' && status === 'answered') sessions.setState(session.id, 'connected', 'user answered');
      if (req.query.leg === 'office' && ['failed', 'rejected', 'unanswered', 'busy'].includes(status)) {
        sessions.setState(session.id, 'failed', `office ${status}`);
      }
      if (req.query.leg === 'office' && status === 'completed' && session.state !== 'connected') {
        sessions.setState(session.id, 'ended', 'office hung up');
      }
    }
    res.sendStatus(204);
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

  return { router, startRenewalCall, bridgeUserIn, handleSocket };
};
