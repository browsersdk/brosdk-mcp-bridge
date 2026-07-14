import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const backgroundSource = (await readFile(new URL('../src/background.js', import.meta.url), 'utf8'))
  .replaceAll('__DEFAULT_MCP_BASE_URL__', 'http://mcp.brosdk.internal');

test('state syncs are serialized and a pending request gets a fresh snapshot', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.shutdown());
  let releaseFirstSnapshot;
  let queryCount = 0;
  let activeQueries = 0;
  let maxActiveQueries = 0;

  harness.setWindowsQuery(async () => {
    queryCount += 1;
    activeQueries += 1;
    maxActiveQueries = Math.max(maxActiveQueries, activeQueries);
    if (queryCount === 1) {
      await new Promise((resolve) => {
        releaseFirstSnapshot = resolve;
      });
    }
    activeQueries -= 1;
    return sampleWindows();
  });

  const first = harness.context.syncStateNow();
  await flushMicrotasks();
  const second = harness.context.syncStateNow();
  await flushMicrotasks();

  assert.equal(queryCount, 1);
  releaseFirstSnapshot();
  await Promise.all([first, second]);

  assert.equal(queryCount, 2);
  assert.equal(maxActiveQueries, 1);
});

test('duplicate command ids execute and report only once', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.shutdown());
  let releaseUpdate;
  let updateCount = 0;

  harness.chrome.tabs.update = async () => {
    updateCount += 1;
    await new Promise((resolve) => {
      releaseUpdate = resolve;
    });
    return {};
  };

  const command = {
    id: 'command-1',
    type: 'tabs.activate',
    payload: { tabId: 101 },
  };
  const first = harness.context.handleCommand(command, 'websocket');
  const second = harness.context.handleCommand(command, 'websocket');
  await flushMicrotasks();

  assert.equal(updateCount, 1);
  releaseUpdate();
  await Promise.all([first, second]);

  const results = harness.socket.sent.filter((message) => message.type === 'commandResult');
  assert.equal(results.length, 1);
  assert.equal(results[0].commandId, command.id);
  assert.equal(results[0].ok, true);
});

async function createHarness() {
  let windowsQuery = async () => sampleWindows();
  const socketInstances = [];
  const timers = new Map();
  let nextTimerId = 0;

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor() {
      this.readyState = FakeWebSocket.OPEN;
      this.sent = [];
      this.listeners = new Map();
      socketInstances.push(this);
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    send(raw) {
      this.sent.push(JSON.parse(raw));
    }

    close() {
      this.readyState = FakeWebSocket.CLOSED;
    }
  }

  const chrome = createChromeMock(() => windowsQuery());
  const context = vm.createContext({
    AbortController,
    DOMException,
    URL,
    WebSocket: FakeWebSocket,
    chrome,
    clearTimeout(timerId) {
      timers.delete(timerId);
    },
    console: {
      info() {},
      warn() {},
    },
    crypto: {
      randomUUID: () => 'generated-browser-id',
    },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ command: null }),
      text: async () => '{"ok":true}',
    }),
    setTimeout(callback) {
      const timerId = ++nextTimerId;
      timers.set(timerId, callback);
      return timerId;
    },
  });

  vm.runInContext(backgroundSource, context);
  await flushMicrotasks();

  return {
    chrome,
    context,
    get socket() {
      return socketInstances.at(-1);
    },
    setWindowsQuery(nextQuery) {
      windowsQuery = nextQuery;
    },
    async shutdown() {
      vm.runInContext('polling = false; closeWebSocket();', context);
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
      await flushMicrotasks();
    },
  };
}

function createChromeMock(getWindows) {
  const event = () => ({ addListener() {} });
  return {
    action: { onClicked: event() },
    alarms: {
      create: async () => {},
      get: async () => ({ periodInMinutes: 1 }),
      onAlarm: event(),
    },
    bookmarks: {},
    debugger: {
      getTargets: async () => [],
    },
    history: {},
    runtime: {
      onInstalled: event(),
      onMessage: event(),
      onStartup: event(),
    },
    storage: {
      local: {
        get: async () => ({ browserId: 'browser-1' }),
        set: async () => {},
      },
    },
    tabGroups: {
      onCreated: event(),
      onMoved: event(),
      onRemoved: event(),
      onUpdated: event(),
      query: async () => [],
    },
    tabs: {
      onActivated: event(),
      onAttached: event(),
      onCreated: event(),
      onDetached: event(),
      onMoved: event(),
      onRemoved: event(),
      onUpdated: event(),
      update: async () => ({}),
    },
    windows: {
      getAll: getWindows,
      onCreated: event(),
      onFocusChanged: event(),
      onRemoved: event(),
    },
  };
}

function sampleWindows() {
  return [{
    id: 1,
    focused: true,
    state: 'normal',
    type: 'normal',
    tabs: [{
      id: 101,
      windowId: 1,
      index: 0,
      active: true,
      pinned: false,
      status: 'complete',
      title: 'Example',
      url: 'https://example.com/',
    }],
  }];
}

async function flushMicrotasks() {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}
