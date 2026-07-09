const DEFAULT_MCP_BASE_URL = '__DEFAULT_MCP_BASE_URL__';
const PROTOCOL_VERSION = '1.0.0';
const CLIENT_NAME = 'brosdk-mcp-bridge';
const CAPABILITIES = ['tabs', 'windows', 'tabGroups', 'bookmarks', 'history'];
const LOG_PREFIX = '[brosdk-mcp-bridge]';
const SYNC_DEBOUNCE_MS = 150;
const RETRY_DELAY_MS = 2000;
const KEEPALIVE_ALARM_NAME = 'brosdk-mcp-bridge-keepalive';
const KEEPALIVE_PERIOD_MINUTES = 1;

let sequence = 0;
let syncTimer = null;
let polling = false;
let browserIdPromise = null;
let mcpBaseUrlPromise = null;
let bridgeSocket = null;
let bridgeSocketBaseUrl = null;
let bridgeSocketReconnectTimer = null;

chrome.runtime.onInstalled.addListener(() => {
  ensureKeepaliveAlarm();
  kickBridge();
});

chrome.runtime.onStartup.addListener(() => {
  ensureKeepaliveAlarm();
  kickBridge();
});

chrome.action.onClicked.addListener(() => {
  kickBridge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM_NAME) return;
  kickBridge();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleRuntimeMessage(message)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  return true;
});

registerLifecycleListeners();
ensureKeepaliveAlarm();
kickBridge();

function ensureKeepaliveAlarm() {
  chrome.alarms.create(KEEPALIVE_ALARM_NAME, {
    delayInMinutes: KEEPALIVE_PERIOD_MINUTES,
    periodInMinutes: KEEPALIVE_PERIOD_MINUTES,
  });
}

function kickBridge() {
  startWebSocket();
  startPolling();
  syncStateNow().catch((error) => {
    console.warn(LOG_PREFIX, 'keepalive sync failed', error);
  });
}

function registerLifecycleListeners() {
  chrome.tabs.onCreated.addListener(scheduleSync);
  chrome.tabs.onUpdated.addListener(scheduleSync);
  chrome.tabs.onRemoved.addListener(scheduleSync);
  chrome.tabs.onActivated.addListener(scheduleSync);
  chrome.tabs.onMoved.addListener(scheduleSync);
  chrome.tabs.onAttached.addListener(scheduleSync);
  chrome.tabs.onDetached.addListener(scheduleSync);

  chrome.windows.onCreated.addListener(scheduleSync);
  chrome.windows.onRemoved.addListener(scheduleSync);
  chrome.windows.onFocusChanged.addListener(scheduleSync);

  if (chrome.tabGroups) {
    chrome.tabGroups.onCreated.addListener(scheduleSync);
    chrome.tabGroups.onUpdated.addListener(scheduleSync);
    chrome.tabGroups.onRemoved.addListener(scheduleSync);
    chrome.tabGroups.onMoved.addListener(scheduleSync);
  }
}

function scheduleSync() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    syncState().catch((error) => {
      console.warn(LOG_PREFIX, 'sync failed', error);
    });
  }, SYNC_DEBOUNCE_MS);
}

async function syncStateNow() {
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  await syncState();
}

async function syncState() {
  const [browserId, tabs, windows, groups, targets] = await Promise.all([
    getBrowserId(),
    chrome.tabs.query({}),
    chrome.windows.getAll({ populate: true }),
    listTabGroups(),
    chrome.debugger.getTargets(),
  ]);

  const targetByTabId = new Map();
  for (const target of targets) {
    if (target.type === 'page' && target.tabId !== undefined) {
      targetByTabId.set(target.tabId, target.id);
    }
  }

  const payload = {
    browserId,
    protocolVersion: PROTOCOL_VERSION,
    sequence: ++sequence,
    timestamp: new Date().toISOString(),
    tabs: tabs
      .filter((tab) => tab.id !== undefined && tab.windowId !== undefined)
      .map((tab) => normalizeTab(tab, targetByTabId.get(tab.id))),
    windows: windows
      .filter((window) => window.id !== undefined)
      .map(normalizeWindow),
    groups: groups.map((group) => normalizeGroup(group, tabs)),
  };

  if (sendWebSocketMessage({ type: 'state', snapshot: payload })) return;
  await postJson('/extension/state', payload);
}

function normalizeTab(tab, targetId) {
  const normalized = {
    tabId: tab.id,
    targetId,
    windowId: tab.windowId,
    index: tab.index ?? 0,
    url: tab.url ?? '',
    title: tab.title ?? '',
    active: Boolean(tab.active),
    pinned: Boolean(tab.pinned),
    hidden: Boolean(tab.hidden),
    status: tab.status === 'loading' ? 'loading' : 'complete',
  };
  if (typeof tab.groupId === 'number' && tab.groupId >= 0) {
    normalized.groupId = tab.groupId;
  }
  return normalized;
}

function normalizeWindow(window) {
  const activeTab = (window.tabs ?? []).find((tab) => tab.active);
  return {
    windowId: window.id,
    type: window.type ?? 'normal',
    focused: Boolean(window.focused),
    state: window.state ?? 'normal',
    tabCount: window.tabs?.length ?? 0,
    activeTabId: activeTab?.id,
    bounds: {
      left: window.left,
      top: window.top,
      width: window.width,
      height: window.height,
      windowState: window.state,
    },
  };
}

function normalizeGroup(group, tabs) {
  return {
    groupId: group.id,
    windowId: group.windowId,
    title: group.title ?? '',
    color: group.color ?? 'grey',
    collapsed: Boolean(group.collapsed),
    tabIds: tabs
      .filter((tab) => tab.groupId === group.id && tab.id !== undefined)
      .map((tab) => tab.id),
  };
}

async function listTabGroups() {
  if (!chrome.tabGroups) return [];
  return chrome.tabGroups.query({});
}

async function startPolling() {
  if (polling) return;
  polling = true;

  while (polling) {
    try {
      if (isWebSocketOpen()) {
        await delay(RETRY_DELAY_MS);
        continue;
      }
      await postJson('/extension/hello', buildHelloPayload(await getBrowserId()));
      const baseUrl = await getMcpBaseUrl();
      const response = await fetch(`${baseUrl}/extension/commands?timeoutMs=25000`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (body.command) {
        await handleCommand(body.command);
      }
    } catch (error) {
      console.warn(LOG_PREFIX, 'command poll failed', error);
      resetMcpBaseUrl();
      await delay(RETRY_DELAY_MS);
    }
  }
}

async function handleCommand(command, transport = 'http') {
  try {
    const result = await executeCommand(command);
    await syncState().catch((error) => {
      console.warn(LOG_PREFIX, 'post-command sync failed', error);
    });
    if (transport === 'websocket' && sendWebSocketMessage({
      type: 'commandResult',
      commandId: command.id,
      ok: true,
      result,
    })) {
      return;
    }
    await postJson(`/extension/commands/${encodeURIComponent(command.id)}/result`, {
      ok: true,
      result,
    });
  } catch (error) {
    if (transport === 'websocket' && sendWebSocketMessage({
      type: 'commandResult',
      commandId: command.id,
      ok: false,
      error: normalizeError(error),
    })) {
      return;
    }
    await postJson(`/extension/commands/${encodeURIComponent(command.id)}/result`, {
      ok: false,
      error: normalizeError(error),
    });
  } finally {
    scheduleSync();
  }
}

async function startWebSocket() {
  if (
    bridgeSocket &&
    (bridgeSocket.readyState === WebSocket.OPEN ||
      bridgeSocket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  clearWebSocketReconnect();

  let baseUrl;
  try {
    baseUrl = await getMcpBaseUrl();
  } catch (error) {
    scheduleWebSocketReconnect();
    return;
  }

  bridgeSocketBaseUrl = baseUrl;
  const wsUrl = websocketUrlForBaseUrl(baseUrl);
  const socket = new WebSocket(wsUrl);
  bridgeSocket = socket;

  socket.addEventListener('open', async () => {
    console.info(LOG_PREFIX, 'websocket connected', wsUrl);
    sendWebSocketMessage({
      type: 'hello',
      ...buildHelloPayload(await getBrowserId()),
    });
    await syncStateNow();
  });

  socket.addEventListener('message', (event) => {
    handleWebSocketMessage(event.data).catch((error) => {
      console.warn(LOG_PREFIX, 'websocket message failed', error);
    });
  });

  socket.addEventListener('close', () => {
    if (bridgeSocket === socket) bridgeSocket = null;
    console.info(LOG_PREFIX, 'websocket disconnected');
    resetMcpBaseUrl();
    scheduleWebSocketReconnect();
  });

  socket.addEventListener('error', () => {
    if (bridgeSocket === socket) {
      try {
        socket.close();
      } catch {
        // Ignore close races.
      }
    }
  });
}

async function handleWebSocketMessage(raw) {
  const message = JSON.parse(String(raw));
  if (message.type === 'command' && message.command) {
    await handleCommand(message.command, 'websocket');
    return;
  }
  if (message.type === 'sync') {
    await syncStateNow();
    return;
  }
  if (message.type === 'hello' || message.type === 'pong' || message.type === 'health') {
    return;
  }
  if (message.type === 'error') {
    console.warn(LOG_PREFIX, 'websocket server error', message.error);
  }
}

function sendWebSocketMessage(message) {
  if (!isWebSocketOpen()) return false;
  bridgeSocket.send(JSON.stringify(message));
  return true;
}

function isWebSocketOpen() {
  return bridgeSocket?.readyState === WebSocket.OPEN;
}

function scheduleWebSocketReconnect() {
  clearWebSocketReconnect();
  bridgeSocketReconnectTimer = setTimeout(() => {
    bridgeSocketReconnectTimer = null;
    startWebSocket().catch((error) => {
      console.warn(LOG_PREFIX, 'websocket reconnect failed', error);
      scheduleWebSocketReconnect();
    });
  }, RETRY_DELAY_MS);
}

function clearWebSocketReconnect() {
  if (bridgeSocketReconnectTimer) {
    clearTimeout(bridgeSocketReconnectTimer);
    bridgeSocketReconnectTimer = null;
  }
}

function closeWebSocket() {
  clearWebSocketReconnect();
  if (bridgeSocket) {
    const socket = bridgeSocket;
    bridgeSocket = null;
    try {
      socket.close();
    } catch {
      // Ignore close races.
    }
  }
}

function websocketUrlForBaseUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/extension/ws';
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function executeCommand(command) {
  const payload = command.payload ?? {};
  switch (command.type) {
    case 'tabs.create': {
      const tab = await chrome.tabs.create({
        url: payload.url ?? 'about:blank',
        active: payload.active !== false,
        ...(typeof payload.windowId === 'number' && { windowId: payload.windowId }),
      });
      return { tabId: tab.id };
    }
    case 'tabs.close':
      await chrome.tabs.remove(payload.tabId);
      return {};
    case 'tabs.activate':
      await chrome.tabs.update(payload.tabId, { active: true });
      return {};
    case 'tabs.duplicate': {
      const tab = await chrome.tabs.duplicate(payload.tabId);
      return { tabId: tab?.id };
    }
    case 'tabs.pin': {
      const tab = await chrome.tabs.update(payload.tabId, { pinned: payload.pinned === true });
      return { tabId: tab?.id ?? payload.tabId };
    }
    case 'tabs.move': {
      const moved = await chrome.tabs.move(payload.tabId, {
        ...(typeof payload.windowId === 'number' && { windowId: payload.windowId }),
        index: typeof payload.index === 'number' ? payload.index : -1,
      });
      const tab = Array.isArray(moved) ? moved[0] : moved;
      return { tabId: tab?.id ?? payload.tabId };
    }
    case 'windows.create': {
      const window = await chrome.windows.create({ focused: true });
      return { windowId: window.id };
    }
    case 'windows.close':
      await chrome.windows.remove(payload.windowId);
      return {};
    case 'windows.activate':
      await chrome.windows.update(payload.windowId, { focused: true });
      return {};
    case 'windows.setVisibility':
      await chrome.windows.update(payload.windowId, {
        state: payload.visible ? 'normal' : 'minimized',
        focused: payload.visible ? payload.activate !== false : false,
      });
      return {};
    case 'tabGroups.create': {
      const groupId = await chrome.tabs.group({ tabIds: payload.tabIds });
      if (payload.title !== undefined) {
        await chrome.tabGroups.update(groupId, { title: payload.title });
      }
      return { groupId };
    }
    case 'tabGroups.add': {
      const groupId = await chrome.tabs.group({
        tabIds: payload.tabIds,
        groupId: payload.groupId,
      });
      return { groupId };
    }
    case 'tabGroups.update': {
      await chrome.tabGroups.update(payload.groupId, {
        ...(payload.title !== undefined && { title: payload.title }),
        ...(payload.color !== undefined && { color: payload.color }),
        ...(payload.collapsed !== undefined && { collapsed: payload.collapsed }),
      });
      return { groupId: payload.groupId };
    }
    case 'tabGroups.ungroup':
      await chrome.tabs.ungroup(payload.tabIds);
      return {};
    case 'tabGroups.close':
      if (Array.isArray(payload.tabIds) && payload.tabIds.length > 0) {
        await chrome.tabs.remove(payload.tabIds);
      }
      return {};
    case 'bookmarks.list': {
      const roots = payload.folderId === undefined
        ? await chrome.bookmarks.getTree()
        : await chrome.bookmarks.getSubTree(payload.folderId);
      return { nodes: flattenBookmarks(roots).map(normalizeBookmark) };
    }
    case 'bookmarks.search': {
      const results = await chrome.bookmarks.search(payload.query ?? '');
      return {
        results: results
          .slice(0, typeof payload.maxResults === 'number' ? payload.maxResults : results.length)
          .map(normalizeBookmark),
      };
    }
    case 'bookmarks.create': {
      const node = await chrome.bookmarks.create({
        title: payload.title ?? '',
        ...(payload.url !== undefined && { url: payload.url }),
        ...(payload.parentId !== undefined && { parentId: payload.parentId }),
        ...(typeof payload.index === 'number' && { index: payload.index }),
      });
      return { node: normalizeBookmark(node) };
    }
    case 'bookmarks.update': {
      const node = await chrome.bookmarks.update(payload.id, {
        ...(payload.title !== undefined && { title: payload.title }),
        ...(payload.url !== undefined && { url: payload.url }),
      });
      return { node: normalizeBookmark(node) };
    }
    case 'bookmarks.move': {
      const node = await chrome.bookmarks.move(payload.id, {
        ...(payload.parentId !== undefined && { parentId: payload.parentId }),
        ...(typeof payload.index === 'number' && { index: payload.index }),
      });
      return { node: normalizeBookmark(node) };
    }
    case 'bookmarks.remove':
      await chrome.bookmarks.removeTree(payload.id);
      return {};
    case 'history.search': {
      const entries = await chrome.history.search({
        text: payload.query ?? '',
        maxResults: typeof payload.maxResults === 'number' ? payload.maxResults : 100,
        ...(typeof payload.startTime === 'number' && { startTime: payload.startTime }),
        ...(typeof payload.endTime === 'number' && { endTime: payload.endTime }),
      });
      return { entries: entries.map(normalizeHistoryEntry) };
    }
    case 'history.recent': {
      const entries = await chrome.history.search({
        text: '',
        maxResults: typeof payload.maxResults === 'number' ? payload.maxResults : 25,
      });
      return { entries: entries.map(normalizeHistoryEntry) };
    }
    case 'history.deleteUrl':
      await chrome.history.deleteUrl({ url: payload.url });
      return {};
    case 'history.deleteRange':
      await chrome.history.deleteRange({
        startTime: payload.startTime,
        endTime: payload.endTime,
      });
      return {};
    default:
      throw new Error(`Unknown command type: ${command.type}`);
  }
}

function flattenBookmarks(nodes) {
  const flattened = [];
  for (const node of nodes) {
    flattened.push(node);
    if (Array.isArray(node.children)) {
      flattened.push(...flattenBookmarks(node.children));
    }
  }
  return flattened;
}

function normalizeBookmark(node) {
  return {
    id: node.id,
    ...(node.parentId !== undefined && { parentId: node.parentId }),
    ...(node.index !== undefined && { index: node.index }),
    title: node.title ?? '',
    ...(node.url !== undefined && { url: node.url }),
    type: node.url === undefined ? 'folder' : 'url',
    dateAdded: node.dateAdded ?? 0,
    ...(node.dateLastUsed !== undefined && { dateLastUsed: node.dateLastUsed }),
  };
}

function normalizeHistoryEntry(entry) {
  return {
    id: entry.id,
    url: entry.url ?? '',
    title: entry.title ?? '',
    lastVisitTime: entry.lastVisitTime ?? 0,
    visitCount: entry.visitCount ?? 0,
    typedCount: entry.typedCount ?? 0,
  };
}

async function postJson(path, payload) {
  const baseUrl = await getMcpBaseUrl();
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function handleRuntimeMessage(message) {
  if (!message || typeof message !== 'object') {
    return { ok: false, error: 'Invalid message.' };
  }

  if (message.type === 'getStatus') {
    const baseUrl = await getMcpBaseUrl();
    return {
      ok: true,
      baseUrl,
      browserId: await getBrowserId(),
    };
  }

  if (message.type === 'reconnect') {
    resetMcpBaseUrl();
    closeWebSocket();
    startWebSocket();
    const baseUrl = await getMcpBaseUrl();
    await postJson('/extension/hello', buildHelloPayload(await getBrowserId()));
    await syncState();
    return { ok: true, baseUrl };
  }

  return { ok: false, error: `Unknown message type: ${message.type}` };
}

function resetMcpBaseUrl() {
  mcpBaseUrlPromise = null;
}

async function getMcpBaseUrl() {
  if (!mcpBaseUrlPromise) {
    mcpBaseUrlPromise = Promise.resolve(DEFAULT_MCP_BASE_URL);
  }
  return mcpBaseUrlPromise;
}

async function getBrowserId() {
  if (!browserIdPromise) {
    browserIdPromise = chrome.storage.local.get('browserId').then(async ({ browserId }) => {
      if (typeof browserId === 'string') return browserId;
      const next = crypto.randomUUID();
      await chrome.storage.local.set({ browserId: next });
      return next;
    });
  }
  return browserIdPromise;
}

function buildHelloPayload(browserId) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    browserId,
    client: CLIENT_NAME,
    capabilities: CAPABILITIES,
  };
}

function normalizeError(error) {
  return {
    code: 'COMMAND_FAILED',
    message: error instanceof Error ? error.message : String(error),
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
