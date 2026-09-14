import { z } from "zod";

// Message protocol — the contract between sidepanel/content/options and background.
// Every `chrome.runtime.sendMessage({ type: ... })` has a matching handler in
// background.js's switch statement. This schema enumerates them.

export const MESSAGE_TYPES = [
  "GET_PAGE_CONTEXT",
  "GET_OPEN_TABS",
  "GET_TAB_CONTEXTS",
  "ASK_ZO",
  "TEST_CONNECTION",
  "GET_CONFIG",
  "LIST_MODELS",
  "GET_VISION_CATALOG",
  "LIST_PERSONAS",
  "LIST_SKILLS",
  "LIST_WORKSPACE_DIR",
  "EXECUTE_ACTIONS",
  "ENHANCE_TEXT",
  "NAVIGATE",
  "GENERATE_MODE",
  "SAVE_PAGE",
  "SAVE_CONVERSATION",
  "RUN_SKILL",
  "CREATE_AUTOMATION",
  "LIST_AUTOMATIONS",  "DUCKDB_QUERY",
  "NEW_CONVERSATION",
  "RECREATE_CONTEXT_MENUS",
  "GET_DEBUG_LOG",
  "CLEAR_DEBUG_LOG",
  "HANDOFF_START",
  "HANDOFF_PAUSE",
  "HANDOFF_RESUME",
  "HANDOFF_STOP",
  "HANDOFF_STATUS",
  "RECIPE_START",
  "RECIPE_RESUME",
  "RECIPE_STOP",
  "RECIPE_STATUS",
  "RECIPE_LIST",
] as const;

export const MessageType = z.enum(MESSAGE_TYPES);

// Background → panel PUSHES (chrome.runtime.sendMessage from the background).
// These never appear in background.js's request switch, so they live outside
// MESSAGE_TYPES — the contract test would otherwise demand a handler case.
export const BACKGROUND_PUSH_TYPES = ["HANDOFF_UPDATE", "RECIPE_UPDATE"] as const;

export const BackgroundPushMessage = z.object({
  type: z.enum(BACKGROUND_PUSH_TYPES),
}).passthrough();

// A schema that matches any valid message envelope (type + optional payload keys).
// Individual messages carry their own payloads; this validates the discriminator.
export const MessageEnvelope = z.object({
  type: MessageType,
}).passthrough();
// Write-assist popover stream port (#53) — `cobrowse-wa-stream`. The content
// script opens the port and sends ONE request; the background answers with
// live deltas and exactly one terminal event. These ride a PORT, not the
// runtime message router, so they are outside MESSAGE_TYPES by design.
export const WaEnhanceRequest = z.object({
  type: z.literal("WA_ENHANCE"),
  text: z.string(),
  instruction: z.string(),
  field: z.object({
    label: z.string().optional(),
    placeholder: z.string().optional(),
    maxLength: z.number().nullable().optional(),
    markdown: z.boolean().optional(),
  }).passthrough(),
  page: z.object({ url: z.string().optional(), title: z.string().optional() }).passthrough(),
  /** Thread id from the popover's previous turn (follow-up chips). */
  conversationId: z.string().optional(),
  /** Prior result — present makes the turn a revision, not a fresh rewrite. */
  priorText: z.string().optional(),
});
export type WaEnhanceRequest = z.infer<typeof WaEnhanceRequest>;

export const WaStreamEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("WA_DELTA"), delta: z.string(), raw: z.string() }),
  z.object({ type: z.literal("WA_DONE"), text: z.string().min(1), conversationId: z.string().optional() }),
  z.object({ type: z.literal("WA_ERROR"), error: z.string().min(1) }),
]);
export type WaStreamEvent = z.infer<typeof WaStreamEvent>;
