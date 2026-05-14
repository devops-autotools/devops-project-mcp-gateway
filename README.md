# MCP Gateway

A TypeScript gateway that aggregates multiple MCP (Model Context Protocol) servers into a single endpoint, enabling AI agents to access tools from many backends through one connection.

```
AI Agent
   │
   ▼
MCP Gateway  ←─── servers.json (config)
   │
   ├── Ceph Storage Assistant  (fastmcp)
   ├── Other MCP Server        (sse / streamable-http)
   └── Local Tool              (stdio)
```

---

## ⚠️ Agent Support

> **Currently, MCP Gateway officially supports [Hermes Agent](https://github.com/...) only.**
>
> Hermes connects using the **MCP Streamable HTTP protocol (2025-11-25)** via `mcp.client.streamable_http`.
> Support for other agents (LangChain, AutoGen, OpenAI Agents SDK, etc.) is planned for future development.

---

## Features

- **Multi-server aggregation** — connect as many MCP servers as needed, tools are merged into one list
- **Namespace isolation** — tools are prefixed with server ID (`ceph_alpha__get_health_summary`) so agents know exactly which backend to target, even when multiple servers expose the same tool names
- **4 transport types** — supports all current MCP transport protocols plus a custom Ceph-compatible transport
- **Persistent config** — `servers.json` is the single source of truth; adding/removing servers via the dashboard persists across restarts
- **Web dashboard** — visual overview of connected servers and aggregated tools
- **Docker-ready** — runs in a container with host networking for internal backend access

---

## Transport Types

| Value | Protocol | Use when |
|---|---|---|
| `streamable-http` | MCP 2025-11-25 | Server uses modern Streamable HTTP |
| `sse` | MCP 2024-11-05 | Server uses legacy SSE protocol |
| `fastmcp` | Custom (Ceph) | Ceph Storage Assistant — persistent POST stream |
| `stdio` | stdio | Local process (npx, python, etc.) |

---

## Quick Start

### 1. Start the gateway

```bash
docker compose up -d --build
```

Dashboard: `http://localhost:3010`

### 2. Add MCP servers

Open the dashboard and click **"Add New MCP-Client"**. Select the transport type, enter the URL and an ID — the server connects immediately and is saved automatically.

> `servers.json` is automatically updated by the gateway whenever you add or remove a server via the dashboard or API. **There is no need to edit this file manually.**
>
> Only edit it directly if you want to pre-configure servers before the very first `docker compose up`.

### 3. Connect Hermes

In your Hermes `config.yaml`:

```yaml
mcp_servers:
  Ceph-Alpha:
    url: http://localhost:3010/sse?apiKey=mcp_gateway_secret_123
```

Hermes will discover all aggregated tools automatically. Tools are namespaced by server ID:
- `ceph_alpha__get_health_summary`
- `ceph_alpha__get_cluster_capacity`
- `my_other_mcp__some_tool`

---

## Configuration

### Environment variables (`docker-compose.yaml`)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3010` | Gateway listen port |
| `API_KEY` | `mcp_gateway_secret_123` | Auth key required in `?apiKey=` |
| `SERVERS_CONFIG` | `/app/servers.json` | Path to servers config file |

### `servers.json` schema

```json
[
  { "id": "string", "transport": "streamable-http", "url": "http://..." },
  { "id": "string", "transport": "sse",             "url": "http://..." },
  { "id": "string", "transport": "fastmcp",         "url": "http://..." },
  { "id": "string", "transport": "stdio", "command": "npx", "args": ["pkg"] }
]
```

`servers.json` is automatically updated whenever you add or remove a server via the dashboard or API. Only edit it manually to pre-configure servers before the first `docker compose up` — after that, use the dashboard.

---

## Management API

```bash
# List connected servers + status
curl http://localhost:3010/api/status

# List all aggregated tools
curl http://localhost:3010/api/tools

# Add a server at runtime (persisted to servers.json)
curl -X POST http://localhost:3010/api/servers \
  -H "Content-Type: application/json" \
  -d '{"id":"new-server","transport":"streamable-http","url":"http://..."}'

# Remove a server at runtime (removed from servers.json)
curl -X DELETE http://localhost:3010/api/servers/new-server

# Test tools/list as an agent would
curl -X POST "http://localhost:3010/sse?apiKey=mcp_gateway_secret_123" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1,"params":{}}'
```

---

## Development

```bash
# Install dependencies
npm install

# Run in dev mode (hot reload)
npm run dev

# Build
npm run build

# Start production
npm start

# Docker
docker compose up -d --build   # build & start
docker compose restart          # restart (picks up servers.json changes)
docker compose logs -f          # stream logs
```

---

## Project Structure

```
mcp-gateway/
├── src/
│   ├── index.ts        # Express app, /sse endpoint, management API
│   ├── aggregator.ts   # Tool/resource/prompt fan-out + namespace prefixing
│   ├── upstream.ts     # Transport classes, UpstreamManager
│   └── config.ts       # Zod schema for servers.json
├── public/             # Web dashboard (HTML/CSS/JS)
├── docs/
│   └── plan.md         # Architecture & issue history
├── servers.json        # Upstream server registry (persistent)
└── docker-compose.yaml
```

---

## Roadmap

- [ ] Support for additional AI agents (LangChain, AutoGen, OpenAI Agents SDK, ...)
- [ ] Auto-reconnect on upstream stream drop
- [ ] Health check endpoint per upstream server
- [ ] Authentication per upstream (API key injection)
