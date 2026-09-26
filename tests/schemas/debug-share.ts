import { z } from "zod";

// Diagnostics sharing (user-triggered, anonymous, 24h expiry) — the contract
// for lib/debug-share.js outputs and the SHARE_DIAGNOSTICS response. The
// bundle is composed only from the metadata-only debug ring plus an explicit
// settings allowlist; the upload result is the honest success/failure union.

/** One anonymous paste host in the failover chain. */
export const PasteHostSchema = z.object({
  name: z.string().min(1),
  endpoint: z.string().url(),
  bodyType: z.enum(["form", "json", "multipart"]),
  headers: z.record(z.string()).optional(),
});
export type PasteHost = z.infer<typeof PasteHostSchema>;

/** Upload outcome — never throws; failures carry a combined per-host error. */
export const UploadResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    url: z.string().url(),
    host: z.string().min(1),
    expiresAt: z.number(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.string().min(1),
  }),
]);
export type UploadResult = z.infer<typeof UploadResultSchema>;

/** SHARE_DIAGNOSTICS response (background → options). ok:true always
 * carries the paste url; failures carry only the error. */
export const ShareDiagnosticsResponseSchema = z.object({
  ok: z.boolean(),
  url: z.string().url().optional(),
  host: z.string().optional(),
  expiresAt: z.number().optional(),
  error: z.string().optional(),
}).passthrough()
  .refine((v) => !v.ok || !!v.url, { message: "ok:true requires the paste url" })
  .refine((v) => v.ok || !v.url, { message: "ok:false never carries a url" });
export type ShareDiagnosticsResponse = z.infer<typeof ShareDiagnosticsResponseSchema>;

/** NAVIGATE request (panel → background): the capture's source tabId now
 * rides explicitly — the panel is an extension page, so the background can
 * never infer it from the sender. */
export const NavigateRequestSchema = z.object({
  type: z.literal("NAVIGATE"),
  url: z.string().url(),
  tabId: z.number().optional(),
}).passthrough();
export type NavigateRequest = z.infer<typeof NavigateRequestSchema>;
