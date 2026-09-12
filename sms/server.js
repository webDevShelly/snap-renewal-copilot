require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { WebSocketServer } = require('ws');
const OpenAI = require('openai');
const twilio = require('twilio');
const store = require('./lib/store');
const intake = require('./lib/intake');
const renewal = require('./lib/renewal');
const callSessions = require('./lib/callSession');
const createVoiceRoutes = require('./routes/voice');
const reminders = require('./lib/reminders');

const app = express();
const port = Number(process.env.PORT || 3000);
const dataFile = path.join(__dirname, 'data', 'messages.json');
const isProduction = process.env.NODE_ENV === 'production';

app.set('trust proxy', true);
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false }));

function safelyMatches(value, expected) {
  const actualBuffer = Buffer.from(value || '');
  const expectedBuffer = Buffer.from(expected || '');
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function protectDashboard(req, res, next) {
  const username = process.env.DASHBOARD_USERNAME;
  const password = process.env.DASHBOARD_PASSWORD;
  if (!username || !password) return next();
  const authorization = req.get('authorization') || '';
  const [scheme, encoded] = authorization.split(' ');
  const [providedUsername, providedPassword] = scheme === 'Basic' && encoded
    ? Buffer.from(encoded, 'base64').toString('utf8').split(':')
    : [];
  if (safelyMatches(providedUsername, username) && safelyMatches(providedPassword, password)) return next();
  res.set('WWW-Authenticate', 'Basic realm="Benefit Bridge SMS"');
  return res.status(401).send('Authentication required.');
}

// Webhook routes below remain outside this middleware so Twilio can reach them.
app.use('/api', protectDashboard);
app.get('/', protectDashboard, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/styles.css', protectDashboard, (req, res) => res.sendFile(path.join(__dirname, 'public', 'styles.css')));
app.get('/app.js', protectDashboard, (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.js')));

function readMessages() {
  try {
    return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function writeMessages(messages) {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  const temporaryFile = `${dataFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(messages, null, 2));
  fs.renameSync(temporaryFile, dataFile);
}

function saveMessage(message) {
  const messages = readMessages();
  const existingIndex = messages.findIndex((item) => item.sid === message.sid);
  if (existingIndex >= 0) messages[existingIndex] = { ...messages[existingIndex], ...message };
  else messages.unshift(message);
  writeMessages(messages.slice(0, 500));
  return message;
}

function configured() {
  if (process.env.SMS_PROVIDER === 'vonage') {
    return Boolean(process.env.VONAGE_API_KEY && process.env.VONAGE_API_SECRET && process.env.VONAGE_SENDER);
  }
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      (process.env.TWILIO_AUTH_TOKEN ||
        (process.env.TWILIO_API_KEY_SID && process.env.TWILIO_API_KEY_SECRET)) &&
      (process.env.TWILIO_PHONE_NUMBER || process.env.TWILIO_MESSAGING_SERVICE_SID)
  );
}

function sender() {
  return process.env.SMS_PROVIDER === 'vonage'
    ? process.env.VONAGE_SENDER
    : process.env.TWILIO_PHONE_NUMBER || 'Messaging Service';
}

function client() {
  if (process.env.TWILIO_AUTH_TOKEN) {
    return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  if (process.env.TWILIO_API_KEY_SID && process.env.TWILIO_API_KEY_SECRET) {
    return twilio(process.env.TWILIO_API_KEY_SID, process.env.TWILIO_API_KEY_SECRET, {
      accountSid: process.env.TWILIO_ACCOUNT_SID
    });
  }
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

async function sendVonageSms({ to, body }) {
  const authorization = Buffer.from(`${process.env.VONAGE_API_KEY}:${process.env.VONAGE_API_SECRET}`).toString('base64');
  const payload = new URLSearchParams({
    from: process.env.VONAGE_SENDER,
    to: to.replace(/^\+/, ''),
    text: body
  });
  const response = await fetch('https://rest.nexmo.com/sms/json', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${authorization}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: payload
  });
  const result = await response.json();
  const message = result.messages?.[0];
  if (!response.ok || !message || String(message.status) !== '0') {
    const detail = message?.['error-text'] || result['error-code-label'] || 'Vonage rejected the message.';
    const error = new Error(detail);
    error.code = message?.status || result['error-code'] || response.status;
    throw error;
  }
  return {
    sid: message['message-id'],
    direction: 'outbound',
    from: process.env.VONAGE_SENDER,
    to,
    body,
    status: 'accepted',
    createdAt: new Date().toISOString(),
    provider: 'vonage'
  };
}

function validatePhoneNumber(phoneNumber) {
  return /^\+[1-9]\d{6,14}$/.test(phoneNumber);
}

function publicUrl(route) {
  const baseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/$/, '');
  return baseUrl ? `${baseUrl}${route}` : undefined;
}

function conversationFor(phoneNumber) {
  return readMessages()
    .filter((message) => message.from === phoneNumber || message.to === phoneNumber)
    .filter((message) => message.body && (message.direction === 'inbound' || message.aiGenerated))
    .slice(0, 12)
    .reverse()
    .map((message) => ({
      role: message.direction === 'inbound' ? 'user' : 'assistant',
      content: message.body
    }));
}

async function generateAssistantReply(phoneNumber) {
  if (!process.env.OPENAI_API_KEY) return null;
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await openai.responses.create({
    model: process.env.OPENAI_MODEL || 'gpt-5',
    instructions: process.env.SMS_ASSISTANT_INSTRUCTIONS || 'You are a helpful SMS assistant. Keep replies under 300 characters.',
    input: conversationFor(phoneNumber),
    max_output_tokens: 160
  });
  const reply = response.output_text.trim();
  return reply ? reply.slice(0, 600) : 'I’m sorry, I could not generate a reply. Please try again.';
}

function webhookValidation() {
  // Local tests are intentionally allowed without a Twilio signature. Production requests must validate.
  return twilio.webhook({ validate: isProduction });
}

app.get('/api/health', (req, res) => {
  res.json({ configured: configured(), sender: sender(), provider: process.env.SMS_PROVIDER || 'twilio' });
});

app.get('/api/messages', (req, res) => {
  res.json(readMessages());
});

app.post('/api/messages', async (req, res) => {
  if (!configured()) {
    return res.status(503).json({ error: 'Twilio is not configured. Fill in .env first.' });
  }

  const to = String(req.body.to || '').trim();
  const body = String(req.body.body || '').trim();
  if (!validatePhoneNumber(to)) {
    return res.status(400).json({ error: 'Use an E.164 destination number, such as +15551234567.' });
  }
  if (!body || body.length > 1600) {
    return res.status(400).json({ error: 'Message text must be between 1 and 1600 characters.' });
  }

  try {
    if (process.env.SMS_PROVIDER === 'vonage') {
      const saved = saveMessage(await sendVonageSms({ to, body }));
      return res.status(201).json(saved);
    }
    const options = {
      to,
      body,
      statusCallback: publicUrl('/webhooks/status')
    };
    if (process.env.TWILIO_MESSAGING_SERVICE_SID) {
      options.messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
    } else {
      options.from = process.env.TWILIO_PHONE_NUMBER;
    }
    const message = await client().messages.create(options);
    const saved = saveMessage({
      sid: message.sid,
      direction: 'outbound',
      from: message.from || sender(),
      to: message.to,
      body: message.body,
      status: message.status,
      createdAt: new Date().toISOString(),
      errorCode: message.errorCode || null
    });
    res.status(201).json(saved);
  } catch (error) {
    console.error('Unable to send SMS:', error.message);
    res.status(502).json({
      error: error.message || 'Twilio rejected the message.',
      code: error.code || null,
      provider: process.env.SMS_PROVIDER || 'twilio'
    });
  }
});

app.post('/webhooks/incoming', webhookValidation(), async (req, res) => {
  const inboundMessage = {
    sid: req.body.MessageSid,
    direction: 'inbound',
    from: req.body.From,
    to: req.body.To,
    body: req.body.Body || '',
    status: 'received',
    createdAt: new Date().toISOString(),
    mediaCount: Number(req.body.NumMedia || 0)
  };
  saveMessage(inboundMessage);

  const response = new twilio.twiml.MessagingResponse();
  try {
    const reply = await generateAssistantReply(inboundMessage.from);
    if (reply) {
      response.message(reply);
      saveMessage({
        sid: `ai-reply-${inboundMessage.sid}`,
        direction: 'outbound',
        from: inboundMessage.to,
        to: inboundMessage.from,
        body: reply,
        status: 'queued',
        createdAt: new Date().toISOString(),
        aiGenerated: true
      });
    }
  } catch (error) {
    console.error('Unable to generate SMS assistant reply:', error.message);
  }
  res.type('text/xml').send(response.toString());
});

app.post('/webhooks/status', webhookValidation(), (req, res) => {
  saveMessage({
    sid: req.body.MessageSid,
    direction: 'outbound',
    from: req.body.From,
    to: req.body.To,
    body: req.body.Body || '',
    status: req.body.MessageStatus || 'unknown',
    updatedAt: new Date().toISOString(),
    errorCode: req.body.ErrorCode || null
  });
  res.sendStatus(204);
});

function toE164(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits ? `+${digits}` : '';
}

// Vonage posts inbound SMS with its own field names and ignores an inline reply
// body, so the assistant answer has to go back out over the send API.
async function handleVonageInbound(req, res) {
  const payload = { ...req.query, ...req.body };
  // Vonage sends the legacy SMS API shape (msisdn/messageId) or the Messages API
  // shape (from/message_uuid), and the Messages API may wrap the party in an object.
  const party = (value) => (value && typeof value === 'object' ? value.number || value.id : value);
  const from = toE164(party(payload.msisdn ?? payload.from));
  const to = toE164(party(payload.to));
  const text = payload.text ?? payload.message?.content?.text ?? '';
  const sid = payload.messageId || payload.message_uuid || crypto.randomUUID();
  if (!from && !text) return res.sendStatus(200);

  saveMessage({
    sid,
    direction: 'inbound',
    from,
    to,
    body: text,
    status: 'received',
    createdAt: new Date().toISOString(),
    provider: 'vonage'
  });

  // Vonage retries the delivery unless it sees a prompt 200, so acknowledge first.
  res.sendStatus(200);

  if (!from) {
    console.error('Inbound Vonage SMS had no sender, so no reply was sent:', JSON.stringify(payload));
    return;
  }
  try {
    const reply = await intake.handleInboundText(from, text, {
      onReady: async (user) => {
        try {
          await voiceRoutes.startRenewalCall(user);
        } catch (error) {
          console.error('Could not start the renewal call:', error.message);
          await sendSms(from, 'I could not reach the benefits office just now. I will keep your answers and you can reply CALL to try again.');
        }
      }
    });
    if (!reply) return;
    store.appendTurn(from, 'assistant', reply);
    saveMessage({ ...(await sendVonageSms({ to: from, body: reply })), aiGenerated: true });
  } catch (error) {
    console.error('Unable to reply to inbound Vonage SMS:', error.message);
  }
}

app.all('/webhooks/vonage/inbound', handleVonageInbound);

app.all('/webhooks/vonage/status', (req, res) => {
  const payload = { ...req.query, ...req.body };
  const party = (value) => (value && typeof value === 'object' ? value.number || value.id : value);
  const errorCode = payload['err-code'];
  saveMessage({
    sid: payload.messageId || payload.message_uuid,
    direction: 'outbound',
    to: toE164(party(payload.msisdn ?? payload.to)),
    status: payload.status || 'unknown',
    updatedAt: new Date().toISOString(),
    errorCode: errorCode && errorCode !== '0' ? errorCode : null
  });
  res.sendStatus(200);
});

// Outbound helper shared by the intake agent and the call bridge.
async function sendSms(to, body) {
  return saveMessage(await sendVonageSms({ to, body }));
}

const voiceRoutes = createVoiceRoutes({ publicUrl, sendSms });
app.use('/voice', voiceRoutes.router);

// Called by the Trigger.dev schedule, so it carries its own bearer token rather
// than sitting behind the dashboard's basic auth.
app.post('/tasks/renewal-reminder', async (req, res) => {
  const expected = process.env.OUTREACH_TOKEN;
  if (!expected) return res.status(503).json({ error: 'OUTREACH_TOKEN is not set.' });
  const provided = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!safelyMatches(provided, expected)) return res.status(401).json({ error: 'Bad or missing token.' });

  try {
    const summary = await reminders.sweep({
      sendSms,
      dryRun: req.body?.dryRun === true,
      windowDays: Number(req.body?.windowDays) || undefined
    });
    console.log(`Renewal reminder sweep: ${summary.matched} of ${summary.considered} users texted.`);
    res.json(summary);
  } catch (error) {
    console.error('Renewal reminder sweep failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/renewals', (req, res) => {
  res.json(store.allUsers().map((user) => ({
    phoneNumber: user.phoneNumber,
    stage: user.renewal.stage,
    progress: renewal.progress(user.renewal.collected),
    collected: user.renewal.collected,
    updatedAt: user.updatedAt
  })));
});

app.get('/api/calls', (req, res) => res.json(callSessions.list()));

app.get('/api/nudges', (req, res) => {
  res.json(Object.entries(NUDGES).map(([token, nudge]) => ({
    token,
    headline: nudge.headline,
    url: publicUrl(`/n/${token}`) || `/n/${token}`
  })));
});

app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && 'body' in error) {
    return res.status(400).json({ error: 'Invalid JSON request body.' });
  }
  next(error);
});

const server = http.createServer(app);
const voiceSockets = new WebSocketServer({ noServer: true });

// Vonage dials a websocket leg into the conversation; that audio feeds the hold detector.
server.on('upgrade', (request, socket, head) => {
  const { pathname, searchParams } = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (pathname !== '/voice/socket') return socket.destroy();
  voiceSockets.handleUpgrade(request, socket, head, (websocket) => {
    voiceRoutes.handleSocket(websocket, searchParams.get('session'));
  });
});

server.listen(port, () => {
  console.log(`SMS dashboard listening on http://localhost:${port}`);
  if (!configured()) console.log('SMS is not configured yet. Copy .env.example to .env and add your credentials.');
});

module.exports = { app, server, validatePhoneNumber, configured, toE164 };
