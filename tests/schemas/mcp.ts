import { z } from "zod";

// MCP schema — JSON-RPC 2.0 envelopes for the api.zo.computer/mcp transport
// (shapes live-verified 2026-08-18, protocol 2024-11-05). mcp.js builds the
// request half; parseMcpMessage/toolText consume the response half. All
// passthrough: the server may add protocol fields we don't consume.

export const JsonRpcMessageCommon = {
  jsonrpc: z.literal("2.0"),
};

/** mcpRequest() body (after JSON.parse) — request WITH id. */
export const McpRequestMessageSchema = z
  .object({
    ...JsonRpcMessageCommon,
    id: z.number().int(),
    method: z.string().min(1),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

/** mcpNotification() body — no id, no response expected. */
export const McpNotificationMessageSchema = z
  .object({
    ...JsonRpcMessageCommon,
    method: z.string().min(1),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

/** initializeParams() — the handshake the extension sends. */
export const McpInitializeParamsSchema = z.object({
  protocolVersion: z.string().min(1),
  capabilities: z.record(z.string(), z.unknown()),
  clientInfo: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
  }),
});

/** toolCallParams() — one tools/call invocation. */
export const McpToolCallParamsSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
});

/** parseMcpMessage() output — response (or echoed request) message. */
export const McpResponseMessageSchema = z
  .object({
    ...JsonRpcMessageCommon,
    id: z.number().int().optional(),
    result: z.record(z.string(), z.unknown()).optional(),
    error: z
      .object({ code: z.number(), message: z.string() })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** One entry of a tools/call result.content array. */
export const McpContentItemSchema = z
  .object({
    type: z.string().min(1),
    text: z.string().optional(),
  })
  .passthrough();

/** The result object toolText()/isToolError() consume. */
export const McpToolResultSchema = z
  .object({
    content: z.array(McpContentItemSchema).optional(),
    isError: z.boolean().optional(),
  })
  .passthrough();

export type McpRequestMessage = z.infer<typeof McpRequestMessageSchema>;
export type McpResponseMessage = z.infer<typeof McpResponseMessageSchema>;
