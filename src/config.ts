import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

export const UpstreamServerSchema = z.discriminatedUnion("transport", [
  z.object({
    id: z.string(),
    transport: z.literal("stdio"),
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    id: z.string(),
    transport: z.literal("sse"),           // Standard SSE protocol (MCP 2024-11-05)
    url: z.string().url(),
  }),
  z.object({
    id: z.string(),
    transport: z.literal("streamable-http"), // Standard Streamable HTTP (MCP 2025-11-25)
    url: z.string().url(),
  }),
  z.object({
    id: z.string(),
    transport: z.literal("fastmcp"),         // Ceph-specific persistent POST transport
    url: z.string().url(),
  }),
]);

export type UpstreamServerConfig = z.infer<typeof UpstreamServerSchema>;

export const GatewayConfigSchema = z.object({
  port: z.number().default(3000),
  host: z.string().default("0.0.0.0"),
  apiKey: z.string().optional(),
  servers: z.array(UpstreamServerSchema),
});

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

export function loadConfig(): GatewayConfig {
  return {
    port: parseInt(process.env.PORT || "3000"),
    host: process.env.HOST || "0.0.0.0",
    apiKey: process.env.API_KEY,
    servers: [], // Pure gateway: no hardcoded servers
  };
}
