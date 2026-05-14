import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { UpstreamManager } from "./upstream.js";

// Convert server ID to a safe prefix: "ceph-alpha" → "ceph_alpha"
function toPrefix(serverId: string): string {
  return serverId.replace(/[^a-zA-Z0-9]/g, "_");
}

// "ceph_alpha__get_health_summary" → { serverId: "ceph-alpha", toolName: "get_health_summary" }
function parseQualifiedName(
  qualifiedName: string,
  clients: Map<string, any>
): { serverId: string; toolName: string } | null {
  for (const serverId of clients.keys()) {
    const prefix = toPrefix(serverId) + "__";
    if (qualifiedName.startsWith(prefix)) {
      return { serverId, toolName: qualifiedName.slice(prefix.length) };
    }
  }
  return null;
}

export class MCPAggregator {
  constructor(private server: Server, private upstreamManager: UpstreamManager) {
    this.setupHandlers();
  }

  private setupHandlers() {
    // List Tools — prefix each tool name with server ID
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const allTools: Tool[] = [];
      for (const [id, client] of this.upstreamManager.getClients()) {
        try {
          const result = await client.listTools();
          const prefix = toPrefix(id) + "__";
          for (const tool of result.tools) {
            allTools.push({ ...tool, name: prefix + tool.name });
          }
        } catch (error) {
          console.error(`Error listing tools from ${id}:`, error);
        }
      }
      return { tools: allTools };
    });

    // Call Tool — strip prefix to find the right upstream
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const clients = this.upstreamManager.getClients();

      const parsed = parseQualifiedName(name, clients);
      if (parsed) {
        const client = clients.get(parsed.serverId);
        if (client) {
          return await client.callTool({ name: parsed.toolName, arguments: args });
        }
      }

      // Fallback: search by original name across all upstreams (backward compat)
      for (const [id, client] of clients) {
        try {
          const tools = await client.listTools();
          if (tools.tools.find((t: Tool) => t.name === name)) {
            return await client.callTool({ name, arguments: args });
          }
        } catch (error) {
          console.error(`Error searching tool in ${id}:`, error);
        }
      }

      throw new Error(`Tool "${name}" not found in any upstream server`);
    });

    // List Resources — prefix URI with server ID to avoid collision
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const allResources: any[] = [];
      for (const [id, client] of this.upstreamManager.getClients()) {
        try {
          const result = await client.listResources();
          const prefix = toPrefix(id) + "__";
          for (const resource of result.resources || []) {
            allResources.push({ ...resource, uri: prefix + resource.uri });
          }
        } catch (error) {
          console.error(`Error listing resources from ${id}:`, error);
        }
      }
      return { resources: allResources };
    });

    // Read Resource — strip prefix to route to correct upstream
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const clients = this.upstreamManager.getClients();
      const uri: string = (request.params as any).uri;

      const parsed = parseQualifiedName(uri, clients);
      if (parsed) {
        const client = clients.get(parsed.serverId);
        if (client) {
          return await client.readResource({ ...request.params, uri: parsed.toolName });
        }
      }

      // Fallback: try all upstreams
      for (const [, client] of clients) {
        try {
          return await client.readResource(request.params);
        } catch (e) {}
      }
      throw new Error("Resource not found");
    });

    // List Prompts — prefix name with server ID
    this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
      const allPrompts: any[] = [];
      for (const [id, client] of this.upstreamManager.getClients()) {
        try {
          const result = await client.listPrompts();
          const prefix = toPrefix(id) + "__";
          for (const prompt of result.prompts || []) {
            allPrompts.push({ ...prompt, name: prefix + prompt.name });
          }
        } catch (e) {}
      }
      return { prompts: allPrompts };
    });

    // Get Prompt — strip prefix to route to correct upstream
    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const clients = this.upstreamManager.getClients();
      const name: string = (request.params as any).name;

      const parsed = parseQualifiedName(name, clients);
      if (parsed) {
        const client = clients.get(parsed.serverId);
        if (client) {
          return await client.getPrompt({ ...request.params, name: parsed.toolName });
        }
      }

      for (const [, client] of clients) {
        try {
          return await client.getPrompt(request.params);
        } catch (e) {}
      }
      throw new Error("Prompt not found");
    });
  }
}
