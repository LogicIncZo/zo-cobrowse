import { z } from "zod";
import { ActionArray } from "./actions.js";

// parse-output schema — validates the channel triple parseZoOutput() returns
// for EVERY Zo response shape (JSON envelope, fenced JSON, plain text, junk).
// parse-output.js feeds both the stream render path (finishStream) and the
// read_tab/pull loops, so a shape drift here corrupts every surface at once.

export const ParseResultSchema = z
  .object({
    /** Zo's optional reasoning channel ('' when absent). */
    reasoning: z.string(),
    /** Normalized type-first actions ([] for non-envelope responses). */
    actions: ActionArray,
    /** JSON.stringify of the parsed envelope ('' when not an envelope). */
    rawOutput: z.string(),
    /** Non-JSON answer text ('' when an envelope was parsed). */
    plainText: z.string(),
    /** The input normalized to string|object for parsing. */
    normalizedOutput: z.unknown(),
  })
  .passthrough();

export type ParseResult = z.infer<typeof ParseResultSchema>;

/**
 * The channel invariant parseZoOutput promises: an envelope response carries
 * reasoning/actions/rawOutput and empty plainText; a plain-text response
 * carries plainText and empty everything else — EXCEPT that a nullish/empty
 * input degrades to empty plainText (nothing to show), which is why plainText
 * emptiness is not an error here. Not folded into ParseResultSchema because
 * both channel shapes are valid — callers assert whichever applies.
 */
export function expectChannel(result: ParseResult, channel: "envelope" | "plain") {
  if (channel === "envelope") {
    if (result.plainText !== "") throw new Error("envelope result must have empty plainText");
  } else {
    if (result.actions.length !== 0) throw new Error("plain result must have no actions");
    if (result.rawOutput !== "") throw new Error("plain result must have empty rawOutput");
    if (result.reasoning !== "") throw new Error("plain result must have empty reasoning");
  }
}
