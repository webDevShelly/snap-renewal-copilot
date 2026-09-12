const store = require('./store');
const renewal = require('./renewal');

// Light normalizers. Anything unparseable is echoed back as a re-ask rather than
// stored, so the packet never carries a value a caseworker would reject.
const NORMALIZERS = {
  householdSize(text) {
    const match = text.match(/\d+/);
    if (!match) return { error: 'Please reply with a number, like 3.' };
    const size = Number(match[0]);
    if (size < 1 || size > 30) return { error: 'Please reply with a household size between 1 and 30.' };
    return { value: String(size) };
  },
  monthlyIncome(text) {
    if (/^\s*(none|0|no income)\s*$/i.test(text)) return { value: '0' };
    const match = text.replace(/,/g, '').match(/\d+(\.\d+)?/);
    if (!match) return { error: 'Please reply with a dollar amount, like 2400, or NONE.' };
    return { value: String(Math.round(Number(match[0]))) };
  },
  dateOfBirth(text) {
    const match = text.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
    if (!match) return { error: 'Please reply in MM/DD/YYYY format, like 04/12/1984.' };
    const [, month, day, year] = match;
    const fullYear = year.length === 2 ? `19${year}` : year;
    return { value: `${month.padStart(2, '0')}/${day.padStart(2, '0')}/${fullYear}` };
  },
  addressChanged(text) {
    if (/^\s*y(es)?\b/i.test(text)) return { value: 'YES' };
    if (/^\s*n(o)?\b/i.test(text)) return { value: 'NO' };
    return { error: 'Please reply YES or NO.' };
  },
  employer(text) {
    return { value: /^\s*none\b/i.test(text) ? 'NONE' : text.trim() };
  },
  caseNumber(text) {
    const match = text.match(/[A-Za-z0-9-]{4,}/);
    return match ? { value: match[0].toUpperCase() } : { error: 'Please reply with your case number.' };
  }
};

function normalize(fieldId, text) {
  const normalizer = NORMALIZERS[fieldId];
  if (normalizer) return normalizer(text);
  const trimmed = text.trim();
  return trimmed ? { value: trimmed } : { error: 'Sorry, I did not catch that.' };
}

function ask(field, prefix) {
  return prefix ? `${prefix}\n\n${field.question}` : field.question;
}

const HELP = 'Reply RENEW to start your SNAP renewal, STATUS to see what is left, or STOP to opt out.';

/**
 * Drives the SMS side of a renewal. Returns the text to send back; the caller
 * decides how to deliver it. `onReady` fires once the packet is complete and the
 * user has agreed to the call, so voice work stays out of this module.
 */
async function handleInboundText(phoneNumber, incomingText, { onReady } = {}) {
  const text = String(incomingText || '').trim();
  const user = store.getUser(phoneNumber);
  const { stage, collected, askedFor } = user.renewal;

  store.appendTurn(phoneNumber, 'user', text);

  if (/^\s*stop\b/i.test(text)) {
    store.updateUser(phoneNumber, { renewal: { stage: 'stopped', askedFor: null } });
    return 'You are opted out and will not get more texts. Reply RENEW any time to start again.';
  }
  if (/^\s*(help|\?)\s*$/i.test(text)) return HELP;

  if (/^\s*status\b/i.test(text)) {
    const { answered, total } = renewal.progress(collected);
    const next = renewal.nextField(collected);
    return next
      ? `You have answered ${answered} of ${total}. Next up: ${next.question}`
      : `All ${total} answers are in. Reply CALL and I will phone the office and hold for you.`;
  }

  if (/^\s*(restart|start over)\b/i.test(text)) {
    store.updateUser(phoneNumber, { renewal: { stage: 'collecting', collected: {}, askedFor: null } });
    const first = renewal.RENEWAL_FIELDS[0];
    store.updateUser(phoneNumber, { renewal: { askedFor: first.id } });
    return ask(first, 'Starting fresh.');
  }

  if (stage === 'idle' || stage === 'stopped') {
    if (!/^\s*(renew|renewal|start|hi|hello|yes)\b/i.test(text)) {
      return `Hi, this is Benefit Bridge. ${HELP}`;
    }
    const first = renewal.nextField(collected) || renewal.RENEWAL_FIELDS[0];
    store.updateUser(phoneNumber, { renewal: { stage: 'collecting', askedFor: first.id } });
    return ask(first, 'I can get your SNAP renewal together, then call the office and wait on hold for you. A few quick questions.');
  }

  if (stage === 'collecting') {
    const field = renewal.RENEWAL_FIELDS.find((item) => item.id === askedFor) || renewal.nextField(collected);
    if (!field) return 'Everything is collected. Reply CALL when you are ready for me to phone the office.';

    const result = normalize(field.id, text);
    if (result.error) return `${result.error}\n\n${field.question}`;

    store.updateUser(phoneNumber, { renewal: { collected: { [field.id]: result.value } } });
    const updated = store.getUser(phoneNumber);
    const next = renewal.nextField(updated.renewal.collected);

    if (next) {
      store.updateUser(phoneNumber, { renewal: { askedFor: next.id } });
      const { answered, total } = renewal.progress(updated.renewal.collected);
      return ask(next, `Got it (${answered}/${total}).`);
    }

    store.updateUser(phoneNumber, { renewal: { stage: 'ready', askedFor: null } });
    return 'That is everything I need. Reply CALL and I will phone the benefits office, sit through the hold music, and ring you the moment a real person picks up.';
  }

  if (stage === 'ready') {
    if (!/^\s*(call|yes|go|ok|okay)\b/i.test(text)) {
      return 'Reply CALL when you are ready and I will phone the office and hold for you.';
    }
    store.updateUser(phoneNumber, { renewal: { stage: 'calling' } });
    if (onReady) await onReady(store.getUser(phoneNumber));
    return 'Calling the benefits office now. You do not need to stay by your phone during the hold. I will ring you the second a person answers.';
  }

  if (stage === 'calling') {
    return 'I am on the line with the office now, waiting for a person. I will ring you as soon as someone picks up.';
  }

  return HELP;
}

module.exports = { handleInboundText, normalize };
