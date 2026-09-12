const list = document.querySelector('#message-list');
const template = document.querySelector('#message-template');
const form = document.querySelector('#composer');
const note = document.querySelector('#form-message');
const connection = document.querySelector('#connection');
const body = document.querySelector('#body');

function displayDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 'Unknown time' : date.toLocaleString();
}

function render(messages) {
  list.replaceChildren();
  if (!messages.length) {
    list.innerHTML = '<p class="empty">No messages yet. Incoming texts will appear here.</p>';
    return;
  }
  messages.forEach((message) => {
    const fragment = template.content.cloneNode(true);
    const incoming = message.direction === 'inbound';
    fragment.querySelector('.message').classList.add(incoming ? 'incoming' : 'outgoing');
    fragment.querySelector('.direction').textContent = incoming ? 'Received' : 'Sent';
    fragment.querySelector('.status').textContent = message.status || 'unknown';
    fragment.querySelector('time').textContent = displayDate(message.updatedAt || message.createdAt);
    fragment.querySelector('.route').textContent = incoming ? `From ${message.from}` : `To ${message.to}`;
    fragment.querySelector('.message-body').textContent = message.body || '(No text content)';
    list.append(fragment);
  });
}

async function loadMessages() {
  try {
    const response = await fetch('/api/messages');
    if (!response.ok) throw new Error();
    render(await response.json());
  } catch {
    list.innerHTML = '<p class="empty error">Could not load messages. Is the server running?</p>';
  }
}

async function loadHealth() {
  try {
    const response = await fetch('/api/health');
    const health = await response.json();
    connection.textContent = health.configured ? `Ready · ${health.sender || 'Messaging Service'}` : 'Setup required';
    connection.classList.toggle('ready', health.configured);
  } catch {
    connection.textContent = 'Offline';
  }
}

body.addEventListener('input', () => { document.querySelector('#count').textContent = `${body.value.length} / 1600`; });
document.querySelector('#refresh').addEventListener('click', loadMessages);
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  note.textContent = 'Sending…';
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const response = await fetch('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: form.to.value, body: form.body.value }) });
    const result = await response.json();
    const provider = result.provider ? `${result.provider[0].toUpperCase()}${result.provider.slice(1)}` : 'SMS provider';
    if (!response.ok) throw new Error(result.code ? `${result.error} (${provider} error ${result.code})` : result.error);
    note.textContent = 'Text sent.';
    form.reset();
    document.querySelector('#count').textContent = '0 / 1600';
    loadMessages();
  } catch (error) {
    note.textContent = error.message || 'Unable to send the text.';
  } finally {
    submit.disabled = false;
  }
});

loadHealth();
loadMessages();
setInterval(loadMessages, 10000);
