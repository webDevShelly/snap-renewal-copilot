const os = require('node:os');
const fsSetup = require('node:fs');
process.env.DATA_DIR = fsSetup.mkdtempSync(require('node:path').join(os.tmpdir(), 'bb-intake-'));

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const intake = require('../lib/intake');
const store = require('../lib/store');
const renewal = require('../lib/renewal');

const PHONE = '+15550001111';

function reset() {
  const file = store.storePath();
  if (!fs.existsSync(file)) return;
  const users = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete users[PHONE];
  fs.writeFileSync(file, JSON.stringify(users, null, 2));
}

test('walks a user through the whole renewal packet and then calls', async (t) => {
  reset();
  t.after(reset);

  let reply = await intake.handleInboundText(PHONE, 'what is this number');
  assert.match(reply, /RENEW/, 'an unrecognized opener should explain the commands');

  reply = await intake.handleInboundText(PHONE, 'RENEW');
  assert.match(reply, /full name/i, 'starts with the first field');

  const answers = {
    fullName: 'Maria Gomez',
    caseNumber: 'snap-48291',
    dateOfBirth: '4/12/1984',
    householdSize: 'there are 3 of us',
    monthlyIncome: '$2,400 a month',
    employer: 'Riverside Diner',
    addressChanged: 'no'
  };
  for (const field of renewal.RENEWAL_FIELDS) {
    reply = await intake.handleInboundText(PHONE, answers[field.id]);
  }

  const collected = store.getUser(PHONE).renewal.collected;
  assert.equal(collected.householdSize, '3', 'pulls a number out of a chatty answer');
  assert.equal(collected.monthlyIncome, '2400', 'strips currency formatting');
  assert.equal(collected.dateOfBirth, '04/12/1984', 'pads the date');
  assert.equal(collected.caseNumber, 'SNAP-48291', 'upcases the case number');
  assert.equal(collected.addressChanged, 'NO');
  assert.ok(renewal.isComplete(collected), 'packet is complete');
  assert.match(reply, /CALL/, 'asks for consent before dialing');

  let called = null;
  reply = await intake.handleInboundText(PHONE, 'CALL', { onReady: (user) => { called = user; } });
  assert.ok(called, 'consent triggers the call');
  assert.equal(called.phoneNumber, PHONE);
  assert.match(reply, /ring you/i);
  assert.equal(store.getUser(PHONE).renewal.stage, 'calling');
});

test('re-asks instead of storing an unparseable answer', async (t) => {
  reset();
  t.after(reset);

  await intake.handleInboundText(PHONE, 'RENEW');
  await intake.handleInboundText(PHONE, 'Maria Gomez');
  await intake.handleInboundText(PHONE, 'SNAP-1');
  const reply = await intake.handleInboundText(PHONE, 'sometime in the eighties');

  assert.match(reply, /MM\/DD\/YYYY/, 'explains the format');
  assert.equal(store.getUser(PHONE).renewal.collected.dateOfBirth, undefined, 'nothing bad was stored');
});

test('rejects a case number with no digits in it', async (t) => {
  reset();
  t.after(reset);

  await intake.handleInboundText(PHONE, 'RENEW');
  await intake.handleInboundText(PHONE, 'Maria Gomez');
  const reply = await intake.handleInboundText(PHONE, 'Maria Gomez');

  assert.match(reply, /does not look like a case number/, 'a name is not a case number');
  assert.equal(store.getUser(PHONE).renewal.collected.caseNumber, undefined, 'nothing bad was stored');
});

test('STATUS reports progress without advancing', async (t) => {
  reset();
  t.after(reset);

  await intake.handleInboundText(PHONE, 'RENEW');
  await intake.handleInboundText(PHONE, 'Maria Gomez');
  const before = store.getUser(PHONE).renewal.askedFor;
  const reply = await intake.handleInboundText(PHONE, 'STATUS');

  assert.match(reply, /1 of 7/);
  assert.equal(store.getUser(PHONE).renewal.askedFor, before, 'the pending question is unchanged');
});

test('STOP opts the user out', async (t) => {
  reset();
  t.after(reset);

  await intake.handleInboundText(PHONE, 'RENEW');
  const reply = await intake.handleInboundText(PHONE, 'STOP');
  assert.match(reply, /opted out/i);
  assert.equal(store.getUser(PHONE).renewal.stage, 'stopped');
});
