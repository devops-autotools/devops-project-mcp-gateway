# MCP Gateway — Technical Documentation

## Overview

The **MCP Gateway** is a TypeScript aggregator that sits between AI agents (Hermes) and multiple MCP backend servers (Ceph Storage Assistant, etc.). It exposes a single unified endpoint so agents only need one connection regardless of how many upstream MCP servers are configured.

```
Hermes Agent (Python)
    │  streamable_http (MCP 2025-11-25)
    │  POST /sse?apiKey=...
    ▼
MCP Gateway (TypeScript, port 3010)
    │  FastMCPPOSTTransport (SSE over persistent POST)
    │  http://172.25.155.214:8000/mcp
    ▼
Ceph Storage Assistant (Python FastMCP, MCP 2024-11-05)
```

---

## Architecture

### Downstream: `/sse` Hybrid Endpoint (`src/index.ts`)

The gateway exposes a single `/sse` endpoint that handles two transport modes:

#### Mode 1 — Streamable HTTP (MCP `2025-11-25`)
Used by Hermes via `mcp.client.streamable_http`. All communication is done via HTTP POST.

| Method | Behavior |
|--------|----------|
| `POST initialize` | Fast-path: immediately returns hardcoded JSON response with `protocolVersion: 2025-11-25` |
| `POST notifications/*` | No ID → returns 204 immediately, no dispatch |
| `POST <any other method>` | Creates a temporary `Server` + `MCPAggregator`, dispatches via mock transport, returns JSON response. 30s timeout. |
| `GET` | Opens legacy SSE stream (see Mode 2) |

**Mock Transport Details**:
The POST handler uses a one-shot mock transport object to bridge between the HTTP request and the MCP SDK's Server class:
- `set onmessage(handler)` — captures the SDK's message dispatcher (must be lowercase `m`)
- `send(message)` — when `message.id === request.id`, writes `res.json(message)` back to the HTTP client
- Dispatch uses `Promise.resolve(messageHandler(req.body)).catch(...)` to safely handle `void` returns from the SDK

> **Critical invariant**: The setter must be `set onmessage` (lowercase). The MCP SDK assigns `transport.onmessage = handler`. Using `set onMessage` (capital M) creates a property name mismatch — the setter never fires, `messageHandler` stays `undefined`, and all non-initialize requests silently time out after 30s.

#### Mode 2 — Legacy SSE (MCP `2024-11-05`)
Standard `GET /sse` opens a persistent `SSEServerTransport` stream. The client then sends RPCs via `POST /messages?sessionId=...`.

---

### Upstream: Ceph Backend (`src/upstream.ts`)

The Ceph Storage Assistant has non-standard session behavior that required a custom transport: `FastMCPPOSTTransport`.

**Why custom transport?**
The Ceph backend ties sessions to the **originating HTTP connection**. Using standard SSEClientTransport (which opens a separate GET for streaming) causes `Session not found` errors because the session was bound to the initial POST.

**How `FastMCPPOSTTransport` works:**

1. **`start()`**: Opens a single persistent `axios.post(url, initialize_request)` with `responseType: "stream"`. This stream stays open indefinitely and serves as the primary SSE data channel. The session ID (`mcp-session-id`) from the response headers is stored.

2. **`send(message)`**: For every subsequent RPC (e.g., `tools/list`, `call_tool`), sends a new `axios.post` including `?session_id=<sid>` and `mcp-session-id` header. The response body of this POST is also treated as a stream and piped through `processBuffer` — because Ceph sends some responses via the POST body rather than the primary SSE stream.

3. **`processBuffer(text)`**: Dual-stream parser. Extracts JSON objects by boundary detection (`{...}`) regardless of SSE prefix format (`data:`, `data: `, etc.). All parsed messages are forwarded via `this.onmessage(msg)`.

---

### Aggregation Layer (`src/aggregator.ts`)

`MCPAggregator` registers handlers on an MCP `Server` instance and fans out to all connected upstream clients:

- `tools/list` → iterates all upstream clients, merges tool arrays
- `tools/call` → finds which upstream has the named tool, proxies the call
- `resources/list`, `resources/read`, `prompts/list`, `prompts/get` → similar fan-out pattern

---

### Upstream Configuration (`servers.json`)

Upstream servers are defined in `servers.json` at the project root, mounted as a read-only volume into the container:

```json
[
  {
    "id": "ceph-alpha",
    "transport": "sse",
    "url": "http://172.25.155.214:8000/mcp"
  }
]
```

Supported transport types (per `src/config.ts` schema):

| `transport` | Class | Protocol | Dùng khi |
|---|---|---|---|
| `stdio` | `StdioClientTransport` | — | MCP server chạy local process |
| `sse` | `SSEClientTransport` (SDK chuẩn) | MCP `2024-11-05` | MCP server dùng SSE chuẩn |
| `streamable-http` | `StreamableHTTPClientTransport` (SDK chuẩn) | MCP `2025-11-25` | MCP server dùng Streamable HTTP chuẩn |
| `fastmcp` | `FastMCPPOSTTransport` (custom) | Ceph-specific | Ceph Storage Assistant — persistent POST stream |

> `sse` và `streamable-http` dùng transport chuẩn từ MCP SDK, tương thích với bất kỳ MCP server nào. `fastmcp` chỉ dùng cho Ceph vì backend đó có session binding đặc thù.

On startup, `src/index.ts` reads this file and connects to every listed server before accepting traffic. To add or remove a server: edit `servers.json` and run `docker compose restart` (no rebuild needed).

Custom config path: `SERVERS_CONFIG` env var (default: `/app/servers.json`).

---

## Issues Found & Fixed (2026-05-14)

### Issue 1 — `tools/list` always timed out (30s → CancelledError in Hermes)

**Symptom**: Hermes logs showed `CancelledError` exactly 30 seconds after `Negotiated protocol version: 2025-11-25`. Gateway logs showed no dispatch activity.

**Root cause**: Mock transport setter was named `set onMessage` (capital M). MCP SDK assigns `transport.onmessage` (lowercase m). JavaScript setter name mismatch → setter never called → `messageHandler` stayed `undefined` → `if (messageHandler)` check failed → request never dispatched → 30s timeout fired → `res.status(504)`.

**Fix** (`src/index.ts`):
```ts
// Before (broken)
set onMessage(handler) { messageHandler = handler; }

// After (fixed)
set onmessage(handler) { messageHandler = handler; }
```

---

### Issue 2 — Process crash on `resources/list` (Hermes only received 4 pseudo-tools)

**Symptom**: After `tools/list` succeeded, Hermes sent `resources/list`. Gateway crashed with `TypeError: Cannot read properties of undefined (reading 'catch')`. Process restarted, Hermes reconnected but Ceph was momentarily busy → `tools/list` returned empty → Hermes registered only 4 pseudo-tools (framework wrappers for resources/prompts capabilities).

**Root cause**: MCP SDK's Transport interface defines `onmessage` as `(message) => void`, not `Promise<void>`. Calling `.catch()` directly on a `void` return throws `TypeError`.

**Fix** (`src/index.ts`):
```ts
// Before (crash)
messageHandler(req.body).catch(err => { ... });

// After (safe)
Promise.resolve(messageHandler(req.body)).catch(err => { ... });
```

---

### Issue 3 — Dashboard tools not refreshing after startup

**Symptom**: Dashboard showed "No tools aggregated" even when Ceph was connected.

**Root cause**: `fetchTools()` in `public/app.js` was called once on `DOMContentLoaded`, but the upstream Ceph connection takes 2–3 seconds to complete. By the time the DOM loaded and `fetchTools()` ran, the tools list was still empty. No periodic refresh was scheduled.

**Fix** (`public/app.js`):
```js
// Added alongside existing fetchStatus interval
setInterval(fetchTools, 15000);
```

---

### Issue 4 — Upstream connections lost after container restart

**Symptom**: Every `docker compose restart` or `docker compose up` cleared all upstream connections. Tools disappeared from dashboard, Hermes got empty tool list.

**Root cause**: `src/config.ts` had `servers: []` hardcoded. No startup logic to auto-connect upstreams. Users had to manually call `POST /api/servers` after each restart.

**Fix**:
- Added `servers.json` file loaded on startup in `src/index.ts`
- Mounted as `./servers.json:/app/servers.json:ro` volume in `docker-compose.yaml`
- Gateway iterates entries and calls `upstreamManager.connect()` for each on startup

---

## Current Working State

| Component | Status | Detail |
|-----------|--------|--------|
| Gateway | ✅ Running | `http://localhost:3010`, `network_mode: host` |
| Ceph upstream | ✅ Connected | `http://172.25.155.214:8000/mcp`, 18 tools |
| Hermes → Gateway | ✅ Working | `streamable_http`, protocol `2025-11-25` |
| Tool discovery | ✅ Working | Hermes registers all 18 Ceph tools on connect |
| Dashboard | ✅ Working | Tools + servers refresh every 15s |
| Restart persistence | ✅ Working | `servers.json` auto-loaded on startup |

---

## Agent Support

> **Currently only Hermes Agent is officially supported.**
> Hermes connects via `mcp.client.streamable_http` (MCP protocol `2025-11-25`) to `http://localhost:3010/sse?apiKey=...`.
>
> Support for other agents is planned but not yet implemented:
> - LangChain MCP integration
> - AutoGen tool adapter
> - OpenAI Agents SDK

## Next Steps

1. **Multi-agent support** — Investigate protocol differences between Hermes and other agent frameworks to extend downstream compatibility.

2. **Session Auto-Reconnect** — If the unified SSE stream to Ceph drops mid-session, `FastMCPPOSTTransport` has no reconnect logic. Implement exponential-backoff reconnect in the stream `end` handler.

3. **Large Payload Buffering** — `processBuffer` processes data line-by-line. If a very large tool list arrives split across multiple TCP packets, boundary detection may need additional robustness testing.

---

## Quick Reference

```bash
# Rebuild & start
docker compose up -d --build

# Restart without rebuild (after editing servers.json)
docker compose restart

# Stream logs
docker compose logs -f

# Check connected upstreams
curl http://localhost:3010/api/status

# List all aggregated tools
curl http://localhost:3010/api/tools

# Test tools/list as Hermes would
curl -X POST "http://localhost:3010/sse?apiKey=mcp_gateway_secret_123" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1,"params":{}}'

# Add upstream at runtime (not persistent — use servers.json instead)
curl -X POST http://localhost:3010/api/servers \
  -H "Content-Type: application/json" \
  -d '{"id":"my-server","transport":"sse","url":"http://..."}'
```
