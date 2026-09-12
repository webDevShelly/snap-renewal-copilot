const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

const voice = require('../lib/voice');
const callSessions = require('../lib/callSession');
const createVoiceRoutes = require('../routes/voice');

const placed = [];
const texts = [];
voice.createCall = async (payload) => { placed.push(payload); return { uuid: `uuid-${placed.length}` }; };
voice.hangUp = async () => ({});
voice.voiceConfigured = () => true;
voice.sender = () => ({ type: 'phone', number: '17077376070' });

process.env.SNAP_OFFICE_NUMBER = '+15558675309';

const routes = createVoiceRoutes({
  publicUrl: (route) => `https://example.test${route}`,
  sendSms: async (to, body) => { texts.push(body); },
  retry: { maxAttempts: 3, delayMs: 10, holdTimeoutMs: 0 }
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const phoneLegs = () => placed.filter((p) => p.to[0].type === 'phone');

async function freshSession() {
  placed.length = 0;
  texts.length = 0;
  return routes.startRenewalCall({ phoneNumber: '+15550001111', renewal: { collected: {} } });
}

test('an unanswered office retries instead of stopping', async () => {
  const session = await freshSession();
  assert.equal(session.attempts, 1);

  await routes.scheduleRetry(session, 'office unanswered');
  assert.equal(session.state, 'retrying');
  await wait(60);

  assert.equal(session.attempts, 2, 'a second attempt went out');
  assert.equal(session.state, 'holding');
  assert.equal(placed.length, 4, 'office + listener, twice');
});

test('the user is told once, not once per retry', async () => {
  const session = await freshSession();

  await routes.scheduleRetry(session, 'office unanswered');
  await wait(60);
  await routes.scheduleRetry(session, 'office unanswered again');
  await wait(80);

  const keepTrying = texts.filter((body) => /keep trying/i.test(body));
  assert.equal(keepTrying.length, 1, 'one reassurance text, not a stream of them');
});

test('it gives up after maxAttempts and says so', async () => {
  const session = await freshSession();

  for (let i = 0; i < 5; i += 1) {
    await routes.scheduleRetry(session, 'office unanswered');
    await wait(60);
  }

  assert.equal(session.state, 'failed');
  assert.equal(session.attempts, 3, 'stopped at maxAttempts');
  const giveUp = texts.find((body) => /could not get through/i.test(body));
  assert.ok(giveUp, 'the user is told it stopped');
  assert.match(giveUp, /Reply CALL/, 'and how to try again');
});

test('a dropped line counts as a failed attempt and redials', async () => {
  const session = await freshSession();
  const before = phoneLegs().length;

  // Vonage reports the office leg completing before anyone reached us.
  await routes.scheduleRetry(session, 'the office line dropped before a person came on');
  await wait(60);

  assert.ok(phoneLegs().length > before, 'it dialed the office again');
  assert.equal(session.state, 'holding');
});

test('once a person is on the line, a late office event does not redial', async () => {
  const session = await freshSession();
  await routes.bridgeUserIn(session, 'detector heard a person');
  assert.equal(session.state, 'bridging');

  const after = placed.length;
  await routes.scheduleRetry(session, 'office completed');
  await wait(40);

  assert.equal(placed.length, after, 'nothing further was dialed');
  assert.equal(session.state, 'bridging', 'the bridged call is left alone');
});

test('cancelling stops the retries', async () => {
  const session = await freshSession();
  const app = express();
  app.use(express.json());
  app.use('/voice', routes.router);
  const server = app.listen(0);

  try {
    await routes.scheduleRetry(session, 'office unanswered');
    const response = await fetch(`http://127.0.0.1:${server.address().port}/voice/sessions/${session.id}/cancel`, { method: 'POST' });
    assert.equal(response.status, 200);

    const after = placed.length;
    await wait(60);
    assert.equal(placed.length, after, 'the queued retry never fired');
    assert.equal(session.state, 'ended');
  } finally {
    server.close();
  }
});

test('a hold that never produces a person times out into a retry', async () => {
  const timed = createVoiceRoutes({
    publicUrl: (route) => `https://example.test${route}`,
    sendSms: async () => {},
    retry: { maxAttempts: 3, delayMs: 10, holdTimeoutMs: 30 }
  });
  placed.length = 0;

  const session = await timed.startRenewalCall({ phoneNumber: '+15550002222', renewal: { collected: {} } });
  assert.equal(session.attempts, 1);

  await wait(120);
  assert.ok(session.attempts >= 2, `timed out and redialed (attempts=${session.attempts})`);
});

test.after(() => {
  for (const session of callSessions.list()) callSessions.remove(session.id);
});
