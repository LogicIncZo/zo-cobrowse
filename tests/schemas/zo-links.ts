import { z } from "zod";

// zo-links schema — Zo web deep links (0.2.8.0 conversation-id debug tooling).
// zo-links.js builds "open this conversation in Zo's web UI" URLs; both
// exports return plain strings or empty/null, so the contract is the shape +
// the null-on-invalid rule (callers hide the affordance on null).

/** zoChatUrl() result — a full https URL, or null when origin or
 *  conversation id is missing/malformed. */
export const ZoChatUrlSchema = z.string().url("https?://…/?chat=con_…&t=chats").nullable();

/** truncateId() result — non-empty display string (≤ 11 chars). */
export const TruncatedIdSchema = z.string().max(11);

/** Inputs the builders accept (loose — anything JS can pass). */
export const ZoChatUrlInputSchema = z.tuple([z.unknown(), z.unknown()]);

/** The conversation-id shape zo-links accepts (`con_*`). */
export const ConversationIdSchema = z.string().regex(/^con_[A-Za-z0-9_-]+$/);

/** The user-configured zoWebOrigin setting (empty = feature off). */
export const ZoWebOriginSchema = z.string();
