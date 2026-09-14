import { z } from "zod";

// The pull protocol (#24) — context-on-demand contracts.
// Pull requests are what the background's stream loop extracts from Zo's
// actions; follow-ups are the auto-injected `## Auto-fetched:` turns.

export const PullRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("read_tab"), ref: z.string().min(1) }),
  z.object({ type: z.literal("read_page") }),
  z.object({ type: z.literal("get_dom") }),
  z.object({ type: z.literal("get_form") }),
  // #52: on-demand workspace file read. `path` is the raw string Zo emitted
  // (possibly empty/unsafe — validation to safeWorkspacePath happens in the
  // background; an invalid path becomes an `unavailable` follow-up, never a
  // schema failure).
  z.object({ type: z.literal("read_file"), path: z.string() }),
]);

export const FOLLOW_UP_KINDS = ["content", "unavailable", "duplicate", "budget", "blank"] as const;

export const FollowUpSchema = z.object({
  input: z.string().min(1),
  kind: z.enum(FOLLOW_UP_KINDS),
});

export const PullTargetSchema = z.object({
  title: z.string(),
  url: z.string(),
  host: z.string().optional(),
  ref: z.string().optional(),
});

// A pageContext-shaped capture (what getActiveTabContext returns).
export const PullCaptureSchema = z.object({
  url: z.string().optional(),
  title: z.string().optional(),
  tabId: z.number().optional(),
  visibleText: z.string().optional(),
  clickable: z.array(z.object({
    text: z.string(),
    tag: z.string(),
    selector: z.string(),
  })).optional(),
  formFields: z.array(z.object({
    tag: z.string(),
    type: z.string(),
    name: z.string(),
    selector: z.string(),
    placeholder: z.string().optional(),
  })).optional(),
});
