const fs = require('node:fs');
const path = require('node:path');

const storeFile = path.join(__dirname, '..', 'data', 'users.json');

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function writeAll(users) {
  fs.mkdirSync(path.dirname(storeFile), { recursive: true });
  const temporaryFile = `${storeFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(users, null, 2));
  fs.renameSync(temporaryFile, storeFile);
}

function blankUser(phoneNumber) {
  return {
    phoneNumber,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    renewal: { stage: 'idle', collected: {}, askedFor: null, callSessionId: null },
    transcript: []
  };
}

function getUser(phoneNumber) {
  return readAll()[phoneNumber] || blankUser(phoneNumber);
}

// The renewal object is merged a level deeper than the rest so a caller can
// update one collected answer without resupplying the whole packet.
function updateUser(phoneNumber, changes) {
  const users = readAll();
  const current = users[phoneNumber] || blankUser(phoneNumber);
  const updated = {
    ...current,
    ...changes,
    renewal: {
      ...current.renewal,
      ...(changes.renewal || {}),
      collected: { ...current.renewal.collected, ...(changes.renewal?.collected || {}) }
    },
    updatedAt: new Date().toISOString()
  };
  users[phoneNumber] = updated;
  writeAll(users);
  return updated;
}

function appendTurn(phoneNumber, role, text) {
  const user = getUser(phoneNumber);
  const transcript = [...user.transcript, { role, text, at: new Date().toISOString() }].slice(-40);
  return updateUser(phoneNumber, { transcript });
}

function allUsers() {
  return Object.values(readAll());
}

module.exports = { getUser, updateUser, appendTurn, allUsers };
