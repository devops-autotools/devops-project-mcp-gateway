# CLAUDE.md - MCP Gateway Project Guide

## Build & Run Commands
- Build project: `npm run build`
- Start Gateway: `npm start`
- Development mode: `npm run dev`
- Docker Build & Run: `docker compose up -d --build`
- Check Logs: `docker compose logs -f`

## Project Context
This project is a custom **MCP Gateway** that aggregates multiple MCP servers (SSE or Stdio) and exposes them as a single endpoint for AI agents like **Hermes**.

The gateway supports two downstream protocols:
- **Streamable HTTP** (MCP `2025-11-25`) — used by Hermes via `mcp.client.streamable_http`. All requests (initialize, tools/list, tool calls) are sent as POST to `/sse?apiKey=...`.
- **Legacy SSE** (MCP `2024-11-05`) — GET `/sse` opens an SSE stream, POST `/messages?sessionId=...` sends RPC messages.

### Downstream: Hybrid `/sse` Endpoint (`src/index.ts`)
- **POST + `initialize`**: Fast-path, returns hardcoded `protocolVersion: 2025-11-25` immediately.
- **POST + other methods** (e.g. `tools/list`, `call_tool`): Creates a temporary `Server` + `MCPAggregator`, dispatches the request via a mock transport, and returns the response as JSON. Timeout is 30s.
- **GET**: Opens a legacy SSE stream via `SSEServerTransport`.

> **Critical**: The mock transport in the POST handler uses `set onmessage` (lowercase) to capture the MCP SDK's message handler. If this ever reverts to `onMessage` (capital M), the SDK will silently skip the setter and every non-initialize request will hang for 30s then return 504.

### Upstream: Ceph Backend (`src/upstream.ts`)
The `FastMCPPOSTTransport` is specifically tuned for the **Ceph Storage Assistant** backend at `172.25.155.214`.
1. **Unified Stream**: Maintains a persistent POST connection for SSE data because the backend ties sessions to the originating connection.
2. **Dual-Stream Listening**: Processes JSON-RPC responses from both the primary SSE stream AND individual HTTP POST response bodies, as the Ceph backend distributes messages across both.
3. **Resilient Parsing**: Uses boundary-based JSON extraction in `processBuffer` to handle varied SSE formats.

## Adding / Removing Upstream MCP Servers
Edit `servers.json` in the project root (mounted read-only into the container):
```json
[
  { "id": "ceph-alpha",    "transport": "fastmcp",         "url": "http://172.25.155.214:8000/mcp" },
  { "id": "standard-sse",  "transport": "sse",             "url": "http://other-server/sse" },
  { "id": "modern-server", "transport": "streamable-http", "url": "http://other-server/mcp" },
  { "id": "local-tool",    "transport": "stdio",           "command": "npx", "args": ["some-mcp-server"] }
]
```
After editing, restart with `docker compose restart`. No rebuild needed.

The gateway also supports a custom config path via env var `SERVERS_CONFIG` (default `/app/servers.json`).

## Current Working State
- Gateway runs in `network_mode: host` to reach internal Ceph IP `172.25.155.214`.
- Authentication uses `apiKey=mcp_gateway_secret_123`.
- Dashboard available at `http://localhost:3010`.
- Hermes connects using `streamable_http` transport to `http://localhost:3010/sse?apiKey=mcp_gateway_secret_123`.
- Upstream servers auto-connect from `servers.json` on every startup.

## Known Issues Fixed
- **2026-05-14 — `tools/list` timeout (30s → CancelledError in Hermes)**: Mock transport used `set onMessage` (capital M) but MCP SDK sets `transport.onmessage` (lowercase m), so the handler was never captured and every non-initialize request hung. Fixed: `set onmessage` (lowercase) in `src/index.ts`.

- **2026-05-14 — Process crash on `resources/list`**: `messageHandler()` returns `void` (not a Promise) per MCP SDK's Transport interface, but code called `.catch()` directly → `TypeError: Cannot read properties of undefined (reading 'catch')` → entire Node.js process crashed → Hermes lost session → on reconnect Ceph was busy → only 4 pseudo-tools registered. Fixed: `Promise.resolve(messageHandler(...)).catch(...)` in `src/index.ts`.

- **2026-05-14 — Dashboard tools not refreshing**: `fetchTools()` was only called once on page load, before the Ceph connection finished (~2-3s). No periodic refresh existed. Fixed: added `setInterval(fetchTools, 15000)` in `public/app.js`.

- **2026-05-14 — Upstream not reconnecting after restart**: `servers.json` was empty (`servers: []` in `config.ts`) and no auto-connect on startup. Each container restart wiped upstream connections. Fixed: `servers.json` file (mounted as volume) loaded at startup in `src/index.ts`.

## Next Steps
1. **Session Auto-Reconnect**: Implement automatic reconnection logic in `FastMCPPOSTTransport` if the unified stream to Ceph drops mid-session.
2. **Handle Large Payloads**: Monitor if large tool lists cause buffering issues in `processBuffer`.

## Testing
- Internal tool test: `curl http://localhost:3010/api/tools`
- tools/list via Streamable HTTP: `curl -X POST "http://localhost:3010/sse?apiKey=mcp_gateway_secret_123" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"tools/list","id":2,"params":{}}'`
- Handshake test: `curl -X POST "http://localhost:3010/sse?apiKey=mcp_gateway_secret_123" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'`
