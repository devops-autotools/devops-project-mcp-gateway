import express from "express";
import cors from "cors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client } from "ssh2";

const app = express();
app.use(cors());

const REMOTE_CONFIG = {
  host: "103.165.142.148",
  port: 22,
  username: "mcp-test",
  password: "mcp-test",
};

function runSshCommand(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on("ready", () => {
      conn.exec(command, (err, stream) => {
        if (err) return reject(err);
        let data = "";
        stream.on("data", (chunk: any) => { data += chunk; });
        stream.on("close", () => {
          conn.end();
          resolve(data.trim());
        });
      });
    }).on("error", reject).connect(REMOTE_CONFIG);
  });
}

// We'll store the active transport to close it if a new one comes
let activeTransport: SSEServerTransport | null = null;

app.get("/sse", async (req, res) => {
  console.log("Gateway connecting to SSH Monitor...");
  
  const server = new Server(
    { name: "ssh-monitor-node", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        { name: "check_disk", description: "Check disk usage", inputSchema: { type: "object" } },
        { name: "check_ram", description: "Check RAM usage", inputSchema: { type: "object" } },
        { name: "check_cpu", description: "Check CPU load", inputSchema: { type: "object" } }
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      if (request.params.name === "check_disk") {
        const output = await runSshCommand("df -h");
        return { content: [{ type: "text", text: `--- DISK USAGE ---\n${output}` }] };
      }
      if (request.params.name === "check_ram") {
        const output = await runSshCommand("free -m");
        return { content: [{ type: "text", text: `--- RAM USAGE (MB) ---\n${output}` }] };
      }
      if (request.params.name === "check_cpu") {
        const output = await runSshCommand("uptime");
        return { content: [{ type: "text", text: `--- CPU STATUS ---\n${output}` }] };
      }
      throw new Error("Tool not found");
    } catch (error: any) {
      return { isError: true, content: [{ type: "text", text: `SSH Error: ${error.message}` }] };
    }
  });

  const transport = new SSEServerTransport("/messages", res);
  activeTransport = transport;
  await server.connect(transport);
  
  res.on("close", () => {
    console.log("Connection closed");
  });
});

app.post("/messages", async (req, res) => {
  if (activeTransport) {
    await activeTransport.handlePostMessage(req, res);
  } else {
    res.status(400).send("No active transport");
  }
});

app.listen(3030, () => {
  console.log(`SSH Monitor MCP-Client running at http://0.0.0.0:3030`);
});
