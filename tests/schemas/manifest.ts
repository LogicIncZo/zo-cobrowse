import { z } from "zod";

// manifest.json schema — validates the parts of Chrome MV3 manifest we rely on.
// Full MV3 spec is large; this covers what the extension exercises.

const IconSet = z.object({
  "16": z.string().regex(/\.png$/),
  "32": z.string().regex(/\.png$/).optional(),
  "48": z.string().regex(/\.png$/),
  "128": z.string().regex(/\.png$/),
});

const Command = z.object({
  suggested_key: z.object({
    default: z.string(),
    mac: z.string().optional(),
    windows: z.string().optional(),
    linux: z.string().optional(),
    chromeos: z.string().optional(),
  }).passthrough(),
  description: z.string().min(1),
}).passthrough();

export const ManifestSchema = z.object({
  manifest_version: z.literal(3),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string(),
  permissions: z.array(z.string()),
  // <all_urls> is REQUIRED: chrome.tabs.captureVisibleTab needs the literal
  // <all_urls> pattern (or an activeTab gesture) — scoped wildcards like
  // http://*/* + https://*/* do not qualify, so tier-3 capture silently
  // fails without it (2026-08-29 real-Chrome triage).
  host_permissions: z.array(z.string()).refine(
    (perms) => perms.includes("<all_urls>"),
    { message: "host_permissions must include <all_urls> — captureVisibleTab requires it" },
  ).optional(),
  background: z.object({
    service_worker: z.string(),
    type: z.literal("module").optional(),
  }),
  side_panel: z.object({
    default_path: z.string(),
  }),
  options_ui: z.object({
    page: z.string(),
    open_in_tab: z.boolean(),
  }).optional(),
  options_page: z.string().optional(),
  content_scripts: z.array(z.object({
    matches: z.array(z.string()),
    js: z.array(z.string()),
    run_at: z.string().optional(),
    all_frames: z.boolean().optional(),
  })).optional(),
  action: z.object({
    default_title: z.string(),
    default_icon: IconSet.optional(),
  }).passthrough(),
  icons: IconSet,
  commands: z.record(z.string(), Command).optional(),
  omnibox: z.object({
    keyword: z.string().min(1),
  }).optional(),
  // Write-assist widget renders the Zo icon inside host pages via
  // chrome.runtime.getURL — MV3 requires the asset be web-accessible.
  web_accessible_resources: z.array(z.object({
    resources: z.array(z.string()),
    matches: z.array(z.string()),
  }).passthrough()).optional(),
}).passthrough();

export type Manifest = z.infer<typeof ManifestSchema>;
