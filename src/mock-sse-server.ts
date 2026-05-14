import express from "express";
import cors from "cors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const app = express();
app.use(cors());

const server = new Server(
  {
    name: "dynamic-mock-server",
    version: "2.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "dynamic_hello",
        description: "A tool from a dynamically added server",
        inputSchema: { type: "object" },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "dynamic_hello") {
    return {
      content: [{ type: "text", text: "Hello from the dynamic server!" }],
    };
  }
  throw new Error("Tool not found");
});

let transport: SSEServerTransport | null = null;

app.get("/sse", async (req, res) => {
  console.log("Gateway connecting to mock server...");
  transport = new SSEServerTransport("/messages", res);
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  if (transport) {
    await transport.handlePostMessage(req, res);
  }
});

const port = 3020;
app.listen(port, () => {
  console.log(`Mock SSE Server running at http://0.0.0.0:${port}`);
});
