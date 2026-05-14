import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCRequest, JSONRPCResponse, JSONRPCNotification } from "@modelcontextprotocol/sdk/types.js";
import { UpstreamServerConfig } from "./config.js";
import axios from "axios";

/**
 * Clean & Robust FastMCP Transport
 */
class FastMCPPOSTTransport implements Transport {
  private _sessionId?: string;
  private _abortController?: AbortController;
  private _initialResponse?: any;
  private _sseBuffer: string = "";
  private _stream: any = null;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: any) => void;

  constructor(private _url: URL) {}

  private processBuffer(text: string) {
    this._sseBuffer += text;
    const lines = this._sseBuffer.split("\n");
    this._sseBuffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let msg: any = null;
      if (trimmed.includes("{") && trimmed.includes("}")) {
        try {
          const jsonStart = trimmed.indexOf("{");
          const jsonStr = trimmed.slice(jsonStart).trim();
          msg = JSON.parse(jsonStr);
        } catch (e) {}
      }

      if (msg) {
        console.log(`[FastMCP] Parsed message from stream: ${JSON.stringify(msg)}`);
        if (msg.id === "mcp-init") {
          this._initialResponse = msg;
        }
        this.onmessage?.(msg);
      }
    }
  }

  async start(): Promise<void> {
    console.log(`[FastMCP] Opening unified stream to ${this._url}`);
    this._abortController = new AbortController();
    
    try {
      const response = await axios.post(this._url.toString(), {
        jsonrpc: "2.0",
        id: "mcp-init",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "mcp-gateway", version: "1.0.0" }
        }
      }, {
        headers: {
          "Accept": "application/json, text/event-stream",
          "Content-Type": "application/json"
        },
        responseType: "stream",
        timeout: 0,
        signal: this._abortController.signal
      });

      this._sessionId = response.headers["mcp-session-id"];
      if (!this._sessionId) throw new Error("Missing session ID in response headers");
      
      this._stream = response.data;
      console.log(`[FastMCP] SID obtained: ${this._sessionId}. Listening for handshake...`);

      // Wait for handshake response with timeout
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Handshake timeout (15s)")), 15000);
        
        this._stream.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          console.log(`[DEBUG] Raw chunk from Ceph: ${text}`); 
          this.processBuffer(text);
          if (this._initialResponse) {
            clearTimeout(timeout);
            resolve();
          }
        });

        this._stream.on("error", (err: Error) => {
          clearTimeout(timeout);
          reject(err);
        });
        
        this._stream.on("end", () => {
          if (!this._initialResponse) {
            clearTimeout(timeout);
            reject(new Error("Stream ended before handshake complete"));
          }
        });
      });

      this._stream.on("end", () => {
        console.warn(`[FastMCP] Unified stream ended — triggering onclose for SID: ${this._sessionId}`);
        this.onclose?.();
      });
      this._stream.on("error", (err: Error) => {
        console.error(`[FastMCP] Unified stream error:`, err.message);
        this.onerror?.(err);
      });

      console.log(`[FastMCP] Unified stream ready. SID: ${this._sessionId}`);

    } catch (error: any) {
      console.error(`[FastMCP] Start failed:`, error.message);
      throw error;
    }
  }

  async send(message: JSONRPCRequest | JSONRPCResponse | JSONRPCNotification): Promise<void> {
    if (!this._sessionId) throw new Error("Transport not started");
    
    // Handle initialize locally
    if ("method" in message && message.method === "initialize") {
      if (this._initialResponse) {
        const fakeRes = { ...this._initialResponse, id: (message as JSONRPCRequest).id };
        process.nextTick(() => this.onmessage?.(fakeRes));
        return;
      }
    }

    const postUrl = new URL(this._url.toString());
    postUrl.searchParams.set("session_id", this._sessionId);
    
    const msgId = (message as any).id;
    console.log(`[FastMCP] Sending ${("method" in message ? message.method : "response")} (id: ${msgId}) to Ceph...`);

    try {
      const response = await axios.post(postUrl.toString(), message, {
        headers: { 
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          "mcp-session-id": this._sessionId
        },
        responseType: "stream",
        timeout: 10000, 
        signal: this._abortController?.signal
      });

      // Read the response stream for this specific POST
      response.data.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        // console.log(`[FastMCP] POST Response Chunk: ${text}`);
        this.processBuffer(text);
      });

    } catch (error: any) {
      // Some servers might close the connection immediately after the response
      if (error.code !== "ECONNRESET" && error.code !== "ECONNABORTED") {
        console.error(`[FastMCP] Send failed for ${msgId}:`, error.message);
        throw error;
      }
    }
  }

  async close(): Promise<void> {
    this._abortController?.abort();
    this._stream?.destroy();
  }
}

export class UpstreamManager {
  private clients = new Map<string, Client>();

  async connect(config: UpstreamServerConfig) {
    console.log(`[Upstream] Connecting to ${config.id}...`);
    
    let transport: Transport;
    if (config.transport === "stdio") {
      transport = new StdioClientTransport({
        command: config.command!,
        args: config.args || [],
      });
    } else if (config.transport === "sse") {
      transport = new SSEClientTransport(new URL(config.url!));
    } else if (config.transport === "streamable-http") {
      transport = new StreamableHTTPClientTransport(new URL(config.url!));
    } else {
      // fastmcp: Ceph-specific persistent POST transport
      transport = new FastMCPPOSTTransport(new URL(config.url!));
    }

    const client = new Client(
      { name: "mcp-gateway-client", version: "1.0.0" },
      { capabilities: {} }
    );

    await client.connect(transport);
    this.clients.set(config.id, client);
    console.log(`[Upstream] Successfully connected to ${config.id}`);
  }

  async disconnect(id: string) {
    const client = this.clients.get(id);
    if (client) {
      await client.close();
      this.clients.delete(id);
    }
  }

  getClients() {
    return this.clients;
  }

  getStatus() {
    return Array.from(this.clients.keys()).map(id => ({ id, status: "connected" }));
  }
}

export const upstreamManager = new UpstreamManager();
