const crypto = require('node:crypto');
const { HoldDetector } = require('./holdDetector');

// Sessions live in memory: a call that outlives a restart is not recoverable
// anyway, since the PSTN legs die with the process.
const sessions = new Map();

const STATES = ['dialing', 'holding', 'human-detected', 'bridging', 'connected', 'ended', 'failed'];

function create({ phoneNumber, officeNumber, collected }) {
  const id = crypto.randomUUID();
  const session = {
    id,
    phoneNumber,
    officeNumber,
    collected,
    conversationName: `renewal-${id}`,
    officeCallUuid: null,
    listenerCallUuid: null,
    userCallUuid: null,
    state: 'dialing',
    detector: new HoldDetector(),
    events: [],
    createdAt: new Date().toISOString()
  };
  sessions.set(id, session);
  return session;
}

function get(id) {
  return sessions.get(id);
}

function setState(id, state, detail) {
  const session = sessions.get(id);
  if (!session) return null;
  if (!STATES.includes(state)) throw new Error(`Unknown call state: ${state}`);
  session.state = state;
  session.events.push({ state, detail: detail || null, at: new Date().toISOString() });
  return session;
}

function list() {
  return [...sessions.values()].map(({ detector, ...rest }) => rest);
}

function remove(id) {
  sessions.delete(id);
}

module.exports = { create, get, setState, list, remove, STATES };
