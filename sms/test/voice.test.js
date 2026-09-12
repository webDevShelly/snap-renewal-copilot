const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

const voice = require('../lib/voice');
const callSessions = require('../lib/callSession');
const createVoiceRoutes = require('../routes/voice');

// Stub the Vonage Voice API so nothing dials out during tests.
const placed = [];
voice.createCall = async (payload) => {
  placed.push(payload);
  return { uuid: `uuid-${placed.length}` };
};
voice.hangUp = async () => ({});
voice.voiceConfigured = () => true;
voice.sender = () => ({ type: 'phone', number: '17077376070' });

const BASE = 'https://example.test';
const sent = [];
const routes = createVoiceRoutes({
  publicUrl: (route) => `${BASE}${route}`,
  sendSms: async (to, body) => { sent.push({ to, body }); return {}; }
});

function serve() {
  const app = express();
  app.use(express.json());
  app.use('/voice', routes.router);
  return app.listen(0);
}

async function get(server, path) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
  return response.json();
}

test('places an office leg and a listener leg, and never dials the user yet', async () => {
  placed.length = 0;
  process.env.SNAP_OFFICE_NUMBER = '+15558675309';
  const session = await routes.startRenewalCall({
    phoneNumber: '+15550001111',
    renewal: { collected: { fullName: 'Maria Gomez' } }
  });

  assert.equal(placed.length, 2, 'exactly two legs at the start');
  assert.equal(placed[0].to[0].number, '15558675309', 'first leg is the office');
  assert.equal(placed[1].to[0].type, 'websocket', 'second leg listens');
  assert.match(placed[1].to[0].uri, /^wss:\/\//, 'websocket uri is upgraded from https');
  assert.equal(session.state, 'holding');
  assert.equal(sent.length, 0, 'the user is not texted or dialed while on hold');
});

test('serves a distinct NCCO per leg', async () => {
  const session = callSessions.get(callSessions.list().at(-1).id);
  const server = serve();
  try {
    const office = await get(server, `/voice/answer?session=${session.id}&leg=office`);
    assert.equal(office[0].action, 'conversation');
    assert.equal(office[0].startOnEnter, true);

    const listener = await get(server, `/voice/answer?session=${session.id}&leg=listener`);
    assert.deepEqual(listener[0].canSpeak, [], 'the listener is muted');
    assert.equal(listener[0].startOnEnter, false);

    const user = await get(server, `/voice/answer?session=${session.id}&leg=user`);
    assert.equal(user[0].action, 'talk');
    assert.equal(user[1].action, 'conversation');
    assert.equal(user[1].name, office[0].name, 'all legs meet in one conversation');
  } finally {
    server.close();
  }
});

test('detecting a human dials the user and texts them', async () => {
  placed.length = 0;
  sent.length = 0;
  const session = callSessions.get(callSessions.list().at(-1).id);

  await routes.bridgeUserIn(session, 'test');

  assert.equal(placed.length, 1, 'one new leg');
  assert.equal(placed[0].to[0].number, '15550001111', 'it dials the user');
  assert.equal(session.state, 'bridging');
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /picked up/i);
});

test('bridging twice does not dial the user again', async () => {
  placed.length = 0;
  const session = callSessions.get(callSessions.list().at(-1).id);
  await routes.bridgeUserIn(session, 'duplicate');
  assert.equal(placed.length, 0, 'already bridged, so nothing new is placed');
});
