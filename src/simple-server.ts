import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  {
    name: "simple-time-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register a simple tool to get the current time
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_current_time",
        description: "Get the current time from the server",
        inputSchema: {
          type: "object",
          properties: {
            timezone: { type: "string", description: "Optional timezone" }
          }
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "get_current_time") {
    return {
      content: [
        {
          type: "text",
          text: `The current server time is: ${new Date().toLocaleString()}`,
        },
      ],
    };
  }
  throw new Error("Tool not found");
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Simple Time Server running...");
