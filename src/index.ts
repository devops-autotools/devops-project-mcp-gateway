import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { upstreamManager } from "./upstream.js";
import { MCPAggregator } from "./aggregator.js";
import type { UpstreamServerConfig } from "./config.js";
import path from "path";
import { fileURLToPath } from "url";
import { readFile, writeFile } from "fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = parseInt(process.env.PORT || "3000", 10);
const API_KEY = process.env.API_KEY || "mcp_gateway_secret_123";

// Store active transports to handle incoming messages
const activeTransports = new Map<string, SSEServerTransport>();

// Global Middleware
app.use(express.json());

// Global Request Logger for Debugging
app.use((req, res, next) => {
  if (req.url.startsWith("/api")) return next();
  console.log(`[DEBUG] ${new Date().toISOString()} ${req.method} ${req.url} from ${req.ip}`);
  next();
});

// Static files for Dashboard
app.use(express.static(path.join(__dirname, "../public")));

/**
 * Hybrid SSE / HTTP Handshake & RPC Route
 */
app.all("/sse", async (req, res) => {
  // Security Check
  if (req.query.apiKey !== API_KEY) {
    console.warn(`Unauthorized connection attempt from ${req.ip}`);
    res.status(401).send("Unauthorized: Invalid API Key");
    return;
  }

  const protocol = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["host"];
  const endpointUrl = `${protocol}://${host}/messages`;

  // Handle JSON-RPC POST (For Hermes/Python SDK compatibility)
  if (req.method === "POST" && req.body && req.body.jsonrpc === "2.0") {
    const { method, id } = req.body;
    console.log(`JSON-RPC POST to /sse (method: ${method}, id: ${id})`);
    
    // Fast-path for initialize to ensure compatibility
    if (method === "initialize") {
      res.json({
        jsonrpc: "2.0",
        id: id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: "mcp-gateway", version: "1.0.0" }
        }
      });
      return;
    }

    // Dynamic handling for other methods (like listTools)
    const tempServer = new Server(
      { name: "mcp-gateway-hybrid", version: "1.0.0" },
      { capabilities: { tools: {}, resources: {}, prompts: {} } }
    );
    new MCPAggregator(tempServer, upstreamManager);

    let responseSent = false;
    let messageHandler: ((message: any) => Promise<void>) | undefined;

    // Handle notifications (no ID) immediately
    if (id === undefined) {
      res.status(204).end();
      return;
    }

    const responsePromise = new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.warn(`[TIMEOUT] Request ${id} (${method}) timed out after 30s`);
        resolve(null);
      }, 30000);

      const mockTransport = {
        onclose: undefined as any,
        onerror: undefined as any,
        set onmessage(handler: (message: any) => Promise<void>) { messageHandler = handler; },
        send: async (message: any) => {
          if (message.id === id && !responseSent) {
            console.log(`[DEBUG] Sending response for ${id} (${method})`);
            responseSent = true;
            clearTimeout(timeout);
            res.json(message);
            resolve(message);
          }
        },
        start: async () => {},
        close: async () => {}
      };

      tempServer.connect(mockTransport as any).then(() => {
        if (messageHandler) {
          console.log(`[DEBUG] Dispatching request ${id} (${method}) to aggregator`);
          Promise.resolve(messageHandler(req.body)).catch(err => {
            console.error(`[ERROR] Dispatching request ${id} failed:`, err);
            resolve(null);
          });
        }
      });
    });

    await responsePromise;
    if (!responseSent) {
      res.status(504).send("Gateway Timeout");
    }
    return;
  }

  // GET: Start the actual SSE stream
  console.log(`New SSE Stream Connection (GET) from ${req.ip}`);
  const transport = new SSEServerTransport(endpointUrl as any, res);
  const sessionId = transport.sessionId;
  
  const sessionServer = new Server(
    { name: "mcp-gateway-session", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );

  new MCPAggregator(sessionServer, upstreamManager);
  activeTransports.set(sessionId, transport);

  try {
    await sessionServer.connect(transport);
  } catch (err: any) {
    activeTransports.delete(sessionId);
    return;
  }

  req.on("close", () => {
    activeTransports.delete(sessionId);
    sessionServer.close().catch(() => {});
  });
});

/**
 * Message Endpoint
 */
app.post("/messages", express.json(), async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = activeTransports.get(sessionId);
  if (!transport) return res.status(404).send("Session not found");

  try {
    await transport.handlePostMessage(req, res);
  } catch (error: any) {
    res.status(500).send(error.message);
  }
});

/**
 * Management API
 */
app.get("/api/status", async (req, res) => {
  res.json({ gateway: "online", upstream: upstreamManager.getStatus() });
});

app.get("/api/tools", async (req, res) => {
  const allTools: any[] = [];
  for (const [id, client] of upstreamManager.getClients().entries()) {
    try {
      const result = await client.listTools();
      allTools.push(...result.tools.map((t: any) => ({ ...t, serverId: id })));
    } catch (e: any) {
      console.error(`[api/tools] Error listing tools from ${id}:`, e.message);
    }
  }
  res.json(allTools);
});

async function loadServersFile(configPath: string): Promise<UpstreamServerConfig[]> {
  try {
    return JSON.parse(await readFile(configPath, "utf-8"));
  } catch {
    return [];
  }
}

async function saveServersFile(configPath: string, servers: UpstreamServerConfig[]) {
  await writeFile(configPath, JSON.stringify(servers, null, 2), "utf-8");
}

app.get("/api/config", async (req, res) => {
  const configPath = process.env.SERVERS_CONFIG || "/app/servers.json";
  res.json(await loadServersFile(configPath));
});

app.post("/api/servers", async (req, res) => {
  const { id, transport, url, command, args } = req.body;
  const configPath = process.env.SERVERS_CONFIG || "/app/servers.json";

  let entry: UpstreamServerConfig;
  if (transport === "stdio") {
    entry = { id, transport: "stdio", command, args: args || [] };
  } else if (transport === "streamable-http") {
    entry = { id, transport: "streamable-http", url };
  } else if (transport === "fastmcp") {
    entry = { id, transport: "fastmcp", url };
  } else {
    entry = { id, transport: "sse", url };
  }

  try {
    await upstreamManager.connect(entry);

    const servers = await loadServersFile(configPath);
    const exists = servers.findIndex(s => s.id === id);
    if (exists >= 0) servers[exists] = entry;
    else servers.push(entry);
    await saveServersFile(configPath, servers);

    console.log(`[Config] Saved ${id} to ${configPath}`);
    res.json({ message: `Connected ${id}` });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/servers/:id", async (req, res) => {
  const configPath = process.env.SERVERS_CONFIG || "/app/servers.json";
  try {
    await upstreamManager.disconnect(req.params.id);

    const servers = await loadServersFile(configPath);
    await saveServersFile(configPath, servers.filter(s => s.id !== req.params.id));

    console.log(`[Config] Removed ${req.params.id} from ${configPath}`);
    res.json({ message: "Disconnected" });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(port, "0.0.0.0", async () => {
  console.log(`MCP Gateway running at http://0.0.0.0:${port}`);

  const configPath = process.env.SERVERS_CONFIG || "/app/servers.json";
  try {
    const { readFile } = await import("fs/promises");
    const raw = await readFile(configPath, "utf-8");
    const servers: UpstreamServerConfig[] = JSON.parse(raw);
    console.log(`[Startup] Loading ${servers.length} server(s) from ${configPath} (parallel)`);
    const results = await Promise.allSettled(
      servers.map(server => upstreamManager.connect(server))
    );
    results.forEach((result, i) => {
      if (result.status === "fulfilled") console.log(`[Startup] Connected: ${servers[i].id}`);
      else console.error(`[Startup] Failed to connect ${servers[i].id}:`, result.reason?.message);
    });
  } catch (err: any) {
    if (err.code !== "ENOENT") console.error(`[Startup] Could not load ${configPath}:`, err.message);
  }
});
