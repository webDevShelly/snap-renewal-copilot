const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const API_BASE = 'https://api.nexmo.com/v1/calls';

function privateKey() {
  const keyPath = process.env.VONAGE_PRIVATE_KEY_PATH || './vonage-private.key';
  return fs.readFileSync(path.isAbsolute(keyPath) ? keyPath : path.join(__dirname, '..', keyPath), 'utf8');
}

// The Voice API authenticates with a short-lived RS256 JWT, not the api_key and
// api_secret pair the SMS side uses.
function token() {
  return jwt.sign(
    {
      application_id: process.env.VONAGE_APPLICATION_ID,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      jti: crypto.randomUUID()
    },
    privateKey(),
    { algorithm: 'RS256' }
  );
}

function voiceConfigured() {
  if (!process.env.VONAGE_APPLICATION_ID) return false;
  try {
    return Boolean(privateKey());
  } catch {
    return false;
  }
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(body.title || body.error_title || `Vonage Voice API returned ${response.status}`);
    error.status = response.status;
    error.detail = body.detail || text;
    throw error;
  }
  return body;
}

function createCall(payload) {
  return request(API_BASE, { method: 'POST', body: JSON.stringify(payload) });
}

function hangUp(callUuid) {
  return request(`${API_BASE}/${callUuid}`, { method: 'PUT', body: JSON.stringify({ action: 'hangup' }) });
}

function sender() {
  return { type: 'phone', number: String(process.env.VONAGE_SENDER || '').replace(/^\+/, '') };
}

module.exports = { token, voiceConfigured, createCall, hangUp, sender };
