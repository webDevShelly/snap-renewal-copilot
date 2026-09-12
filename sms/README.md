# Benefit Bridge SMS

A small Twilio SMS inbox and composer. It sends texts through the Twilio Programmable Messaging API, receives inbound messages at a webhook, and records the latest 500 messages in `data/messages.json` (which is intentionally ignored by Git).

## Run it

1. Install dependencies: `npm install`
2. Create your private configuration: `cp .env.example .env`
3. Add your Twilio Account SID, Auth Token, and either a sending phone number or Messaging Service SID.
4. Start the app: `npm run dev`
5. Open `http://localhost:3000`.

## Make inbound SMS work

Twilio must reach the app over a public HTTPS URL. Deploy this service or use a development tunnel, then set `PUBLIC_BASE_URL` to that URL. In your Twilio phone number’s Messaging settings, set **A message comes in** to:

`https://your-public-url/webhooks/incoming` using `POST`.

Set `NODE_ENV=production` when deployed. That enables Twilio signature validation on both webhooks. Set `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD` to enable built-in browser authentication for the dashboard and its API; its send endpoint can create billable messages.

For U.S. application-to-person SMS, make sure your Twilio account/sender registration and opt-in process meet Twilio and carrier requirements before messaging customers.

## Vonage hackathon sending

Set `SMS_PROVIDER=vonage` and fill in `VONAGE_API_KEY`, `VONAGE_API_SECRET`, and `VONAGE_SENDER` in `.env` to send custom outbound messages through Vonage. Its free trial sends only to the account's registered or verified test numbers and appends a demo label. This starter continues to use Twilio for inbound webhooks; receiving messages through Vonage requires a paid Vonage virtual number and public webhook configuration.

## Optional: AI replies

To make incoming texts receive an automatic conversational reply, add `OPENAI_API_KEY` to `.env` and restart the app. The app sends the most recent conversation with that phone number to the OpenAI Responses API and replies through the incoming message's TwiML response. Customize `SMS_ASSISTANT_INSTRUCTIONS` to define the assistant's role and boundaries.

The OpenAI key is separate from a ChatGPT subscription. Keep it private and configure API billing/limits in the OpenAI Platform. This feature needs a paid (upgraded) Twilio account to deliver arbitrary AI-generated SMS replies; Twilio trial accounts only allow its preset templates.

## Renewal call pipeline

The pain point this solves is not the renewal form, it is the hold music. The
copilot gathers the packet over SMS, then calls the office, waits through the
hold itself, and only rings the user once a person is actually on the line.

```
User <--SMS--> Vonage <--> intake agent --> per-user knowledge base
                                  |
                                  v  (packet complete + user replies CALL)
                          office leg  ----\
                          listener leg ----+--> one Vonage conversation
                          user leg     ----/    (user dialed in last)
```

### The flow

1. **Collect.** `lib/intake.js` walks the user through `lib/renewal.js`'s seven
   fields, one text at a time. Answers are normalized ("there are 3 of us" to
   `3`, "$2,400 a month" to `2400`), and anything unparseable is re-asked rather
   than stored, so the packet never carries a value a caseworker would reject.
   `STATUS`, `RESTART`, `HELP`, and `STOP` work at any point.
2. **Consent.** Nothing is dialed until the user replies `CALL`.
3. **Hold.** Two legs are placed: the office, and a muted websocket leg that
   streams the conversation audio to the hold detector. The user's phone stays
   quiet through all of this.
4. **Detect.** `lib/holdDetector.js` watches for the transition that means a
   pickup: hold music stopping, a silence gap longer than music produces, then
   sustained speech.
5. **Bridge.** The user is dialed into the same conversation and texted "answer
   your phone now". The listener leg is dropped.

### Setup

Voice needs a Vonage *Application* (JWT auth), which is separate from the
api_key/api_secret the SMS side uses:

```bash
VONAGE_APPLICATION_ID=...
VONAGE_PRIVATE_KEY_PATH=./vonage-private.key
SNAP_OFFICE_NUMBER=+15551234567
```

`PUBLIC_BASE_URL` must be an HTTPS address Vonage can reach; the websocket leg
is derived from it. Run `npm test` to exercise the intake state machine, the
detector, and the bridge orchestration without placing a call.

### Known limits

- **Hold detection is energy-based, so it cannot tell an IVR prompt from a
  person.** A `minCallMs` window skips the opening menus, but a long mid-call
  prompt can still trip it. `POST /voice/sessions/:id/human` forces the bridge
  when a person is watching, and is the reliable path for a demo.
- Vonage trial accounts only reach whitelisted numbers; failures show as
  error code `29`.
- Call sessions live in memory and do not survive a restart.

## Scheduled renewal reminders

A Trigger.dev schedule (`trigger/renewalReminder.ts`, in the repo root) nudges
people before their renewal is due, and asks them to confirm the recurring costs
that drive their deductions:

> Hi Maria — this is Benefit Bridge. Your SNAP renewal is due September 24, in 12
> days. Quick check: are you still paying $1,200 rent, $180 utilities and $400
> childcare each month? Reply YES if nothing changed, or tell me what is different.

The schedule does not send anything itself. It POSTs to `/tasks/renewal-reminder`
on this service, which owns the knowledge base and the Vonage credentials, so
there is only one place that knows how to text someone. The endpoint takes a
bearer token (`OUTREACH_TOKEN`), not the dashboard's basic auth.

`YES` confirms and closes the loop, anything else is kept verbatim as a
correction for the caseworker, and `RENEW` jumps straight into collection.

### Who gets texted

`lib/reminders.js` deliberately skips people it would be rude or pointless to
text: anyone who replied `STOP`, anyone already mid-intake or on a call, anyone
whose renewal is further out than `windowDays` (21 by default), and anyone
texted in the last 7 days. That quiet period is what stops a daily cron from
becoming a daily nag.

### Running it

```bash
node scripts/seed-demo-user.js +15551234567   # give the sweep someone to find
npm start
```

Dry-run the sweep without sending anything:

```bash
curl -s -X POST localhost:3000/tasks/renewal-reminder \
  -H "Authorization: Bearer $OUTREACH_TOKEN" \
  -H 'Content-Type: application/json' -d '{"dryRun":true}'
```

The schedule itself needs a Trigger.dev account: set `TRIGGER_PROJECT_REF` from
your project settings, plus `SMS_SERVICE_URL` and `OUTREACH_TOKEN` as
environment variables in the Trigger.dev dashboard, then `npm run trigger:dev`
to test or `npm run trigger:deploy` to schedule it for real.
