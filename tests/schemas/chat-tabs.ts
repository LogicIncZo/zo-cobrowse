import { z } from "zod";

// Chat-tab contracts — validates the outputs of extension/lib/chat-tabs.js
// (the chat tab bar: several conversations open at once + rename/search
// management). See docs/superpowers/specs/2026-08-15-chat-tabs-design.md

/** One persisted history message (shape mirrors sidepanel addMessage writes). */
export const ChatMessageSchema = z
  .object({
    role: z.enum(["user", "assistant", "system", "error", "thinking"]),
    text: z.string(),
    timestamp: z.number(),
    reasoning: z.string().optional(),
    durationMs: z.number().optional(),
    /** True when this turn's prompt carried a page screenshot (📷 footer chip). */
    screenshot: z.boolean().optional(),
    healed: z.boolean().optional(),
    // Context policy outcome for the turn (footer chip + tooltip). Optional —
    // messages predating the chip don't carry it.
    contextTier: z.number().int().min(0).max(3).optional(),
    contextReason: z.string().optional(),
    tabRefs: z
      .array(z.object({ ref: z.string(), host: z.string(), title: z.string() }))
      .optional(),
    /** True when the user armed the 📷 Image toggle for this turn (📷 pill). */
    shot: z.boolean().optional(),
  })
  .passthrough();
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/**
 * A conversation object as persisted under `cobrowse_convos`. `zoThreadId` is
 * the Zo server thread for this chat (per-chat conversation_id threading);
 * `pendingActions` holds actions that finished streaming while the chat was in
 * the background. Both optional — old conversations predate them.
 */
export const ConversationSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
    messages: z.array(ChatMessageSchema),
    zoThreadId: z.string().optional(),
    pendingActions: z
      .object({
        reasoning: z.string(),
        actions: z.array(z.object({ type: z.string() }).passthrough()),
      })
      .optional(),
  })
  .passthrough();
export type Conversation = z.infer<typeof ConversationSchema>;
export const ConversationsSchema = z.record(z.string(), ConversationSchema);

/**
 * The open-tab set: ordered chat ids (leftmost = oldest open) plus the active
 * chat id. Null activeId only in the pristine pre-init state; every op output
 * that touches activation has a non-null activeId.
 */
export const TabsStateSchema = z.object({
  openIds: z.array(z.string()),
  activeId: z.string().nullable(),
});
export type TabsState = z.infer<typeof TabsStateSchema>;

/** Same summary shape the history view renders (listConversationSummaries). */
export const ChatSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  /** One-line preview of the first user message ("" when the chat is empty). */
  snippet: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  messageCount: z.number().int().min(0),
  isActive: z.boolean(),
});
export type ChatSummary = z.infer<typeof ChatSummarySchema>;
export const ChatSummaryArray = z.array(ChatSummarySchema);

/** Result of renameConversation — new map (spread-copied) + whether it applied. */
export const RenameResultSchema = z.object({
  convos: ConversationsSchema,
  changed: z.boolean(),
});
export type RenameResult = z.infer<typeof RenameResultSchema>;
