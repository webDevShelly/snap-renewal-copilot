// Seeds one user with an upcoming renewal so the reminder sweep has something to find.
//   node scripts/seed-demo-user.js +15551234567 [daysUntilDue]
require('dotenv').config();
const store = require('../lib/store');

const phoneNumber = process.argv[2];
const daysUntilDue = Number(process.argv[3] || 12);

if (!/^\+[1-9]\d{6,14}$/.test(phoneNumber || '')) {
  console.error('Usage: node scripts/seed-demo-user.js +15551234567 [daysUntilDue]');
  process.exit(1);
}

const dueDate = new Date(Date.now() + daysUntilDue * 86400000).toISOString().slice(0, 10);
store.updateUser(phoneNumber, {
  phoneNumber,
  renewal: {
    stage: 'idle',
    dueDate,
    collected: { fullName: 'Maria Gomez' },
    expenses: { rent: 1200, utilities: 180, childcare: 400 }
  }
});

console.log(`Seeded ${phoneNumber} with a renewal due ${dueDate}.`);
console.log('Dry-run the sweep with:');
console.log(`  curl -s -X POST localhost:${process.env.PORT || 3000}/tasks/renewal-reminder -H "Authorization: Bearer $OUTREACH_TOKEN" -H 'Content-Type: application/json' -d '{"dryRun":true}'`);
