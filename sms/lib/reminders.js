const store = require('./store');

const DEFAULT_WINDOW_DAYS = 21;
// Never text the same person about the same renewal twice in this many days.
const QUIET_DAYS = 7;

function daysUntil(isoDate, now = new Date()) {
  const due = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(due.getTime())) return null;
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((due.getTime() - startOfToday) / 86400000);
}

function formatMoney(amount) {
  return `$${Number(amount).toLocaleString('en-US')}`;
}

function formatDueDate(isoDate) {
  const due = new Date(`${isoDate}T00:00:00Z`);
  return due.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/**
 * The recurring costs a SNAP renewal asks about. Confirming these is the whole
 * point of the reminder: they drive the deductions, and they are what changes
 * quietly between renewals.
 */
function describeExpenses(expenses = {}) {
  const parts = Object.entries(expenses)
    .filter(([, amount]) => amount !== undefined && amount !== null && amount !== '')
    .map(([label, amount]) => `${formatMoney(amount)} ${label}`);
  if (!parts.length) return null;
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

function buildMessage(user, now = new Date()) {
  const { dueDate, expenses } = user.renewal;
  const days = daysUntil(dueDate, now);
  const firstName = String(user.renewal.collected?.fullName || '').split(' ')[0];
  const greeting = firstName ? `Hi ${firstName}` : 'Hi';
  const when = days <= 0 ? 'is due now' : `is due ${formatDueDate(dueDate)}, in ${days} day${days === 1 ? '' : 's'}`;
  const summary = describeExpenses(expenses);

  if (!summary) {
    return `${greeting} — this is Benefit Bridge. Your SNAP renewal ${when}. Reply RENEW and I will get it together with you, then call the office and wait on hold for you.`;
  }
  return `${greeting} — this is Benefit Bridge. Your SNAP renewal ${when}. Quick check: are you still paying ${summary} each month? Reply YES if nothing changed, or tell me what is different.`;
}

/** Users worth texting right now. */
function due({ windowDays = DEFAULT_WINDOW_DAYS, now = new Date() } = {}) {
  return store.allUsers().filter((user) => {
    const { dueDate, stage, lastRemindedAt } = user.renewal;
    if (!dueDate || stage === 'stopped') return false;
    // Someone mid-intake or already on a call does not need a nudge.
    if (['collecting', 'ready', 'calling'].includes(stage)) return false;
    const days = daysUntil(dueDate, now);
    if (days === null || days > windowDays) return false;
    if (lastRemindedAt) {
      const since = (now.getTime() - new Date(lastRemindedAt).getTime()) / 86400000;
      if (since < QUIET_DAYS) return false;
    }
    return true;
  });
}

/** Sends the nudge and marks each user so they are not texted again this week. */
async function sweep({ sendSms, windowDays, now = new Date(), dryRun = false } = {}) {
  const recipients = due({ windowDays, now });
  const results = [];

  for (const user of recipients) {
    const message = buildMessage(user, now);
    try {
      if (!dryRun) {
        await sendSms(user.phoneNumber, message);
        store.updateUser(user.phoneNumber, {
          renewal: { stage: 'confirming', lastRemindedAt: now.toISOString() }
        });
      }
      results.push({ phoneNumber: user.phoneNumber, sent: !dryRun, message });
    } catch (error) {
      console.error(`Reminder to ${user.phoneNumber} failed:`, error.message);
      results.push({ phoneNumber: user.phoneNumber, sent: false, error: error.message });
    }
  }
  return { considered: store.allUsers().length, matched: recipients.length, results };
}

module.exports = { due, sweep, buildMessage, describeExpenses, daysUntil, DEFAULT_WINDOW_DAYS, QUIET_DAYS };
