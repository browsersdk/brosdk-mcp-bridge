const DEFAULT_MCP_BASE_URL = '__DEFAULT_MCP_BASE_URL__';

const statusEl = document.getElementById('status');
const refreshButton = document.getElementById('refresh');
const connectionDot = document.getElementById('connectionDot');
const connectionText = document.getElementById('connectionText');
const serverUrlEl = document.getElementById('serverUrl');
const browserIdEl = document.getElementById('browserId');
const tabsEl = document.getElementById('tabs');
const windowsEl = document.getElementById('windows');
const groupsEl = document.getElementById('groups');
const lastSeenEl = document.getElementById('lastSeen');

load();

refreshButton.addEventListener('click', async () => {
  setStatus('Reconnecting...', '');
  const response = await sendMessage({ type: 'reconnect' });
  if (!response.ok) {
    setStatus(response.error ?? 'Reconnect failed.', 'error');
    return;
  }
  setStatus(`Using ${response.baseUrl}`, 'ok');
  await refreshConnectionStatus(response.baseUrl);
});

async function load() {
  const response = await sendMessage({ type: 'getStatus' });
  if (response.ok) {
    setStatus(`Current bridge: ${response.baseUrl}`, '');
    await refreshConnectionStatus(response.baseUrl, response.browserId);
  } else {
    setStatus(response.error ?? 'Could not read background status.', 'error');
    await refreshConnectionStatus(DEFAULT_MCP_BASE_URL);
  }
}

function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function setStatus(text, className) {
  statusEl.textContent = text;
  statusEl.className = className;
}

async function refreshConnectionStatus(baseUrl, browserId) {
  const normalizedBaseUrl = String(baseUrl || DEFAULT_MCP_BASE_URL).replace(/\/$/, '');
  setConnectionState('checking', 'Checking...');
  serverUrlEl.textContent = normalizedBaseUrl;
  if (browserId) browserIdEl.textContent = browserId;

  try {
    const response = await fetch(`${normalizedBaseUrl}/extension/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const health = await response.json();
    renderHealth(health, normalizedBaseUrl, browserId);
  } catch (error) {
    setConnectionState('offline', 'Offline');
    tabsEl.textContent = '-';
    windowsEl.textContent = '-';
    groupsEl.textContent = '-';
    lastSeenEl.textContent = error instanceof Error ? error.message : String(error);
  }
}

function renderHealth(health, baseUrl, browserId) {
  const connected = Boolean(health.connected);
  setConnectionState(connected ? 'online' : 'seen', connected ? 'Connected' : 'Server reachable');
  serverUrlEl.textContent = baseUrl;
  browserIdEl.textContent = health.browserId ?? browserId ?? '-';
  tabsEl.textContent = String(health.tabs ?? 0);
  windowsEl.textContent = String(health.windows ?? 0);
  groupsEl.textContent = String(health.groups ?? 0);
  lastSeenEl.textContent = formatLastSeen(health);
}

function setConnectionState(state, text) {
  connectionText.textContent = text;
  connectionDot.className = 'dot';
  connectionText.className = '';
  if (state === 'online' || state === 'seen') {
    connectionDot.classList.add('ok');
    connectionText.className = 'ok';
  } else if (state === 'offline') {
    connectionDot.classList.add('error');
    connectionText.className = 'error';
  }
}

function formatLastSeen(health) {
  if (typeof health.ageMs === 'number') {
    if (health.ageMs < 1000) return 'just now';
    return `${Math.round(health.ageMs / 1000)}s ago`;
  }
  if (typeof health.lastSeenAt === 'number') {
    return new Date(health.lastSeenAt).toLocaleString();
  }
  return '-';
}
