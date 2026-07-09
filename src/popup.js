const DEFAULT_MCP_BASE_URL = '__DEFAULT_MCP_BASE_URL__';

document.getElementById('options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

refresh();

async function refresh() {
  let baseUrl = DEFAULT_MCP_BASE_URL;
  try {
    const status = await chrome.runtime.sendMessage({ type: 'getStatus' });
    if (status.ok && status.baseUrl) baseUrl = status.baseUrl;
  } catch {
    // Fall back to the build-time default below.
  }

  try {
    const response = await fetch(`${baseUrl}/extension/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const health = await response.json();
    render(baseUrl, health);
  } catch {
    document.getElementById('message').textContent = baseUrl;
    document.getElementById('status').textContent = 'offline';
  }
}

function render(baseUrl, health) {
  document.getElementById('message').textContent = baseUrl;
  document.getElementById('tabs').textContent = String(health.tabs ?? 0);
  document.getElementById('windows').textContent = String(health.windows ?? 0);
  document.getElementById('groups').textContent = String(health.groups ?? 0);

  const status = document.getElementById('status');
  status.textContent = health.connected ? 'online' : 'seen';
  status.classList.toggle('ok', Boolean(health.connected));
}
