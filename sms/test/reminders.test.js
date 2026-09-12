const os = require('node:os');
const fsSetup = require('node:fs');
process.env.DATA_DIR = fsSetup.mkdtempSync(require('node:path').join(os.tmpdir(), 'bb-reminders-'));

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const store = require('../lib/store');
const reminders = require('../lib/reminders');

const FILE = store.storePath();
const NOW = new Date('2026-10-10T12:00:00Z');
const PREFIX = '+1555REM';

function clear() {
  if (!fs.existsSync(FILE)) return;
  const users = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  for (const key of Object.keys(users)) if (key.startsWith(PREFIX)) delete users[key];
  fs.writeFileSync(FILE, JSON.stringify(users, null, 2));
}

function seed(suffix, renewalFields) {
  const phoneNumber = `${PREFIX}${suffix}`;
  store.updateUser(phoneNumber, { phoneNumber, renewal: { stage: 'idle', ...renewalFields } });
  return phoneNumber;
}

test.beforeEach(clear);
test.after(clear);

test('picks up a renewal inside the window and skips one far out', () => {
  const soon = seed('01', { dueDate: '2026-10-25' });
  seed('02', { dueDate: '2026-12-30' });

  const matched = reminders.due({ now: NOW }).map((user) => user.phoneNumber);
  assert.deepEqual(matched, [soon]);
});

test('does not text someone who opted out or is mid-intake', () => {
  seed('03', { dueDate: '2026-10-20', stage: 'stopped' });
  seed('04', { dueDate: '2026-10-20', stage: 'collecting' });
  seed('05', { dueDate: '2026-10-20', stage: 'calling' });

  assert.equal(reminders.due({ now: NOW }).length, 0);
});

test('respects the quiet period so nobody is texted twice in a week', () => {
  seed('06', { dueDate: '2026-10-20', lastRemindedAt: '2026-10-08T12:00:00Z' });
  assert.equal(reminders.due({ now: NOW }).length, 0, 'texted two days ago');

  clear();
  const old = seed('07', { dueDate: '2026-10-20', lastRemindedAt: '2026-09-20T12:00:00Z' });
  assert.deepEqual(reminders.due({ now: NOW }).map((u) => u.phoneNumber), [old], 'texted three weeks ago');
});

test('names the expenses it wants confirmed', () => {
  const phoneNumber = seed('08', {
    dueDate: '2026-10-25',
    collected: { fullName: 'Maria Gomez' },
    expenses: { rent: 1200, utilities: 180 }
  });
  const message = reminders.buildMessage(store.getUser(phoneNumber), NOW);

  assert.match(message, /Hi Maria/);
  assert.match(message, /due October 25, in 15 days/);
  assert.match(message, /\$1,200 rent and \$180 utilities/);
  assert.match(message, /Reply YES/);
});

test('falls back to a plain nudge when no expenses are on file', () => {
  const phoneNumber = seed('09', { dueDate: '2026-10-25' });
  const message = reminders.buildMessage(store.getUser(phoneNumber), NOW);

  assert.match(message, /Reply RENEW/);
  assert.doesNotMatch(message, /still paying/);
});

test('a dry run reports who would be texted without sending or marking them', async () => {
  const phoneNumber = seed('10', { dueDate: '2026-10-20' });
  let sends = 0;

  const summary = await reminders.sweep({ sendSms: async () => { sends += 1; }, now: NOW, dryRun: true });

  assert.equal(sends, 0, 'nothing was sent');
  assert.equal(summary.matched, 1);
  assert.equal(store.getUser(phoneNumber).renewal.lastRemindedAt, undefined, 'not marked as reminded');
});

test('a real sweep sends once and marks the user so the next run skips them', async () => {
  const phoneNumber = seed('11', { dueDate: '2026-10-20' });
  const sent = [];

  await reminders.sweep({ sendSms: async (to, body) => sent.push({ to, body }), now: NOW });
  assert.equal(sent.length, 1);
  assert.equal(store.getUser(phoneNumber).renewal.stage, 'confirming');

  const second = await reminders.sweep({ sendSms: async () => sent.push({}), now: NOW });
  assert.equal(second.matched, 0, 'the quiet period blocks an immediate second run');
  assert.equal(sent.length, 1);
});
