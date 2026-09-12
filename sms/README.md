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
