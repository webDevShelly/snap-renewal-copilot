// The packet a caseworker asks for during a SNAP renewal call. Order matters:
// the copilot asks for these one at a time over SMS.
const RENEWAL_FIELDS = [
  { id: 'fullName', question: 'What is your full name, as it appears on your SNAP case?' },
  { id: 'caseNumber', question: 'What is your SNAP case number? It is on any letter from the office.' },
  { id: 'dateOfBirth', question: 'What is your date of birth? (MM/DD/YYYY)' },
  { id: 'householdSize', question: 'How many people live in your household, including you?' },
  { id: 'monthlyIncome', question: 'About how much does your household earn before taxes each month?' },
  { id: 'employer', question: 'Who is your current employer? Reply NONE if you are not working.' },
  { id: 'addressChanged', question: 'Has your address changed since last year? Reply YES or NO.' }
];

const FIELD_IDS = RENEWAL_FIELDS.map((field) => field.id);

function missingFields(collected = {}) {
  return RENEWAL_FIELDS.filter((field) => {
    const value = collected[field.id];
    return value === undefined || value === null || String(value).trim() === '';
  });
}

function isComplete(collected = {}) {
  return missingFields(collected).length === 0;
}

function nextField(collected = {}) {
  return missingFields(collected)[0] || null;
}

function progress(collected = {}) {
  return { answered: FIELD_IDS.length - missingFields(collected).length, total: FIELD_IDS.length };
}

// Read aloud to the caseworker once a human is on the line, and shown in the
// dashboard so a person can sanity-check the packet before the call goes out.
function summarize(collected = {}) {
  return RENEWAL_FIELDS
    .map((field) => `${field.id}: ${collected[field.id] ?? '(missing)'}`)
    .join('\n');
}

module.exports = { RENEWAL_FIELDS, FIELD_IDS, missingFields, isComplete, nextField, progress, summarize };
