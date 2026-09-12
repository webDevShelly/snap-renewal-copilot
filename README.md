# SNAP Renewal Copilot

An agent that keeps a household's SNAP recertification from falling through the cracks. It
reads the household's local knowledge base, texts them one next step at a time, and writes
what it learns back to their file. Built on the OpenAI Agents SDK.

## What it does

- Wakes up on a scheduled **renewal sweep** or when the household **texts back**.
- Reads plain markdown files on disk: `case.md`, `documents.md`, `notices/`, and a shared
  `snap-basics.md` reference. No database, no vector store.
- Talks to the household **only** through a `send_text_message` tool. Anything else it says is
  an internal note for the operator log.
- Records what it learns with `save_note` (append-only memory) and `update_document` (edit the
  checklist), so the next run starts from the truth.
- A **tool input guardrail** on the text tool blocks dollar amounts, eligibility verdicts,
  credential requests, and over-long texts. The model receives the rejection reason and
  rephrases; the household never sees the blocked draft.

## Run it

```bash
npm install
cp .env.example .env.local        # add OPENAI_API_KEY

npm run chat -- --sweep           # terminal: the agent makes first contact, then you reply as Maria
npm run dev                       # web demo at http://localhost:3000
npm run sweep                     # renewal sweep for every household under data/users (cron this)
npm run reset                     # clear Maria's thread, session, and notes; restore seed docs
npm test                          # no-key smoke test that drives the agent with a scripted model
```

In the chat, `/sweep` re-runs the sweep and `exit` quits.

## Demo script

1. `npm run reset && npm run chat -- --sweep`. The agent reads Maria's case file, sees the
   October 6 interview and the unsubmitted form, and texts her the first step.
2. Reply `I submitted the form in the app last night`. The agent updates `documents.md`, saves a
   note, and asks for the missing pay stubs.
3. Reply `how much will I get?`. Any draft with a dollar figure is blocked by the guardrail; the
   agent points her to the amount on her notice instead.
4. Open the web UI: Maria's phone on the left, her knowledge base on the right, `notes.md`
   growing as she talks.

## Layout

```
data/
  shared/snap-basics.md            program reference the agent may cite (read-only)
  users/maria-demo/
    profile.md                     name, phone, language, consent
    case.md                        dates, status, what happens if nothing is done
    documents.md                   checklist the agent updates
    notices/…                      what HRA actually mailed
    notes.md                       agent memory (runtime, gitignored)
    messages.jsonl                 every text in and out (runtime, gitignored)
    session.json                   Agents SDK conversation history (runtime, gitignored)
src/lib/
  agent.ts                         Agent, tools, guardrail, runTurn()
  kb.ts                            KnowledgeBase: list / read / search / write / appendNote
  sms.ts                           SmsTransport (console or Twilio) and MessageLog
  session.ts                       FileSession implementing the SDK's Session interface
scripts/
  chat.ts  sweep.ts  reset.ts  smoke.ts
src/app/
  page.tsx                         phone thread + knowledge base viewer
  api/agent/run                    POST { message } or { event: "renewal_sweep" }
  api/thread                       GET the thread and documents
  api/sms/inbound                  Twilio inbound webhook
```

## How the OpenAI pieces fit

- `Agent` with function `tool`s defined by zod schemas, run with `run(agent, input, { context, session })`.
- The run **context** carries the household, knowledge base, SMS transport, and message log into every tool.
- `FileSession` implements the SDK `Session` interface, so `run()` loads and persists each household's history automatically.
- `defineToolInputGuardrail` enforces the texting rules at the tool boundary, not just in the prompt.
- Model: the SDK default. Override with `OPENAI_DEFAULT_MODEL`.

## Real SMS

Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER` and outbound texts go
over Twilio. Point the number's inbound messaging webhook at `POST /api/sms/inbound`; the
household is matched by the phone in `profile.md`. Set `DEMO_PHONE` to route every household's
texts to your own number during a demo. Add Twilio signature validation before exposing that
route publicly.

## Safety boundary

The copilot never submits, signs, or promises to submit a recertification; never states
eligibility; never quotes a benefit amount; never asks for a password, PIN, EBT number, or SSN.
There is no integration with ACCESS HRA. All household data in this repo is synthetic.
