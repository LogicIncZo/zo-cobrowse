import { z } from "zod";

// The action protocol — the contract between Zo and the extension.
// Zo returns a JSON array of actions; the extension executes them in the DOM.
// This schema is the single source of truth for valid action shapes.

export const NavigateAction = z.object({
  type: z.literal("navigate"),
  url: z.string().url(),
});

export const ClickAction = z.object({
  type: z.literal("click"),
  selector: z.string().min(1),
});

export const FillAction = z.object({
  type: z.literal("fill"),
  selector: z.string().min(1),
  value: z.string(),
});

// Batch form fill (#26): one action, N fields. `target` is a human-facing
// cue (label text, aria-label, placeholder, name); `selector` is an optional
// disambiguator. Preferred over N `fill` actions for 2+ fields.
export const FillFormValue = z.object({
  target: z.string().min(1),
  value: z.string(),
  selector: z.string().optional(),
});

export const FillFormAction = z.object({
  type: z.literal("fill_form"),
  values: z.array(FillFormValue).min(1),
});

export const ExtractAction = z.object({
  type: z.literal("extract"),
  selector: z.string(),
  attribute: z.string().optional(),
});

export const ScrollAction = z.object({
  type: z.literal("scroll"),
  direction: z.enum(["up", "down"]).optional(),
  selector: z.string().optional(),
  amount: z.number().optional(),
});

export const WaitAction = z.object({
  type: z.literal("wait"),
  ms: z.number().int().nonnegative().optional(),
});

export const DoneAction = z.object({
  type: z.literal("done"),
  response: z.string(),
});

// Context-only action: Zo requests the full content of a referenced tab
// (manifest refs T1…Tn). Intercepted by the background for the follow-up
// loop — never reaches executeDomAction.
export const ReadTabAction = z.object({
  type: z.literal("read_tab"),
  ref: z.string().min(1),
});

// Context-only pull actions (#24): Zo fetches heavy context of the CURRENT
// page on demand, inside the same stream. Like read_tab, they are consumed
// by the background's pull loop and never reach executeDomAction.
export const ReadPageAction = z.object({
  type: z.literal("read_page"),
});

export const GetDomAction = z.object({
  type: z.literal("get_dom"),
});

export const GetFormAction = z.object({
  type: z.literal("get_form"),
});

export const Action = z.discriminatedUnion("type", [
  NavigateAction,
  ClickAction,
  FillAction,
  FillFormAction,
  ExtractAction,
  ScrollAction,
  WaitAction,
  DoneAction,
  ReadTabAction,
  ReadPageAction,
  GetDomAction,
  GetFormAction,
]);

export const ActionArray = z.array(Action);

export type Action = z.infer<typeof Action>;

// The set of valid action types — used to assert the extension handles all of them.
export const ACTION_TYPES = [
  "navigate",
  "click",
  "fill",
  "fill_form",
  "extract",
  "scroll",
  "wait",
  "done",
  "read_tab",
  "read_page",
  "get_dom",
  "get_form",
] as const;
