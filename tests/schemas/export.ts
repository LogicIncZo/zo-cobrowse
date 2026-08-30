import { z } from "zod";

// Chat export (Lane D item 6) — the conversation-record shape lib/export.js
// consumes (matches what the sidepanel persists in cobrowse_convos) and the
// serializer's option/result envelope.

export const ExportedMessage = z.object({
  role: z.enum(["user", "assistant", "system", "error", "thinking"]),
  text: z.string(),
  timestamp: z.number().optional(),
  reasoning: z.string().optional(),
  durationMs: z.number().optional(),
  contextTier: z.number().int().min(0).max(3).optional(),
  contextReason: z.string().optional(),
  screenshot: z.string().optional(),
});
export type ExportedMessage = z.infer<typeof ExportedMessage>;

export const ExportRequest = z.object({
  title: z.string(),
  messages: z.array(ExportedMessage),
  exportedAt: z.number().optional(),
});
export type ExportRequest = z.infer<typeof ExportRequest>;

// The serializer's contract: a non-empty markdown document that names the
// title, credits the export, and contains role headers for the turns.
export const MarkdownExport = z.string().min(1).refine(
  (s) => s.startsWith("# ") && s.includes("🧑 You") || s.includes("no exportable turns"),
  { message: "markdown export must carry a title header and turn headers" },
);
export type MarkdownExport = z.infer<typeof MarkdownExport>;

export const ExportFileName = z.string().regex(
  /^zo-chat-[a-z0-9-]+-\d{8}\.md$/,
  { message: "filename must be zo-chat-<slug>-<YYYYMMDD>.md" },
);
