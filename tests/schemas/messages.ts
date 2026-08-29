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
  "RUN_SKILL",
  "CREATE_AUTOMATION",
  "LIST_AUTOMATIONS",  "DUCKDB_QUERY",
  "NEW_CONVERSATION",
  "RECREATE_CONTEXT_MENUS",
  "GET_DEBUG_LOG",
  "CLEAR_DEBUG_LOG",
] as const;

export const MessageType = z.enum(MESSAGE_TYPES);

// A schema that matches any valid message envelope (type + optional payload keys).
// Individual messages carry their own payloads; this validates the discriminator.
export const MessageEnvelope = z.object({
  type: MessageType,
}).passthrough();
