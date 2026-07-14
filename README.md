# BroSDK MCP Bridge Extension

BroSDK MCP Bridge is a Manifest V3 browser extension that publishes browser
state to the BroSDK MCP bridge. It exposes tabs, windows, tab groups, bookmarks,
history, active-tab state, and CDP target mappings so MCP tools can coordinate
browser context with page automation.

## Protocol

The extension connects to BroSDK's internal bridge host:

```text
http://mcp.brosdk.internal
```

BroSDK Browser resolves this host to the active MCP bridge address. The
extension does not scan ports and does not expose a user-editable server URL.

See [docs/protocol.md](docs/protocol.md) for the HTTP and WebSocket protocol.

## Build

Install dependencies, then build the unpacked extension:

```bash
npm install
npm run build
```

The build output is written to `dist/`. Load that directory as an unpacked
extension in a Chromium-compatible browser.

## Check

Run syntax checks before packaging or publishing changes:

```bash
npm run check
npm test
```

## Runtime Behavior

The background service worker prefers a WebSocket connection to
`/extension/ws`. State snapshots, commands, and command results use the socket
when it is open. If the WebSocket is unavailable, the extension falls back to the
HTTP long-poll command loop.

When the socket closes or command polling fails, the extension waits 2 seconds
and reconnects to `http://mcp.brosdk.internal`. After reconnecting, it sends a
fresh `hello` message and publishes a full browser state snapshot.

A periodic alarm wakes the service worker once per minute to verify the
connection and publish a fresh snapshot.

The extension uses `chrome.debugger.getTargets()` to map `chrome.tabs` tab IDs to
CDP target IDs. It does not attach to pages; page automation remains in the MCP
server's CDP connection.

## Permissions

- `tabs`, `tabGroups`: read and mutate the browser UI model.
- `bookmarks`, `history`: serve MCP bookmark and history commands.
- `debugger`: read debugger targets for `tabId <-> targetId` mapping.
- `storage`: keep a browser ID for diagnostics.
- `alarms`: periodically wake the service worker for reconnect and state sync.
- `host_permissions`: send bridge snapshots and command results to
  `http://mcp.brosdk.internal`.
