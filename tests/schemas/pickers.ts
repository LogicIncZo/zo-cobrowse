import { z } from "zod";

// Composer reference pickers (#28): `/` skills + `%` Zo-workspace files.
// Covers the pure lib/pickers.js outputs and the two message payloads
// (LIST_SKILLS / LIST_WORKSPACE_DIR) the sidepanel exchanges with background.

export const SkillEntrySchema = z.object({
  /** Skill folder name under /home/workspace/Skills (stable id + Zo-side path segment). */
  id: z.string().min(1),
  /** `name:` from SKILL.md frontmatter; falls back to the folder name. */
  name: z.string().min(1),
  /** `description:` from SKILL.md frontmatter (possibly multiline, trimmed); may be ''. */
  description: z.string(),
});

export const FileEntrySchema = z.object({
  /** Entry name as listed by `ls -1F` (classifier suffix stripped). */
  name: z.string().min(1),
  /** Absolute path inside the workspace root. */
  path: z.string().startsWith("/"),
  /** `ls -F` classifier: dir/file/symlink/exec/other. */
  kind: z.enum(["dir", "file", "symlink", "exec", "other"]),
});

export const ListSkillsResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    skills: z.array(SkillEntrySchema),
    /** Total skill FOLDERS seen by the bash listing (#73) — lets the UI say
     *  "+N more" when folders were skipped (no SKILL.md head / cut listing). */
    total: z.number().int().nonnegative().optional(),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export const ListWorkspaceDirResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    path: z.string().startsWith("/"),
    entries: z.array(FileEntrySchema),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

/** What rides on an ASK_ZO payload for one picked skill (chip → per-turn). */
export const PickedSkillSchema = SkillEntrySchema;

/** What rides on an ASK_ZO payload for one picked file (#74: `dir` marks a
 *  FOLDER pick — it rides as a path too; Zo lists/recurses server-side). */
export const PickedFileSchema = z.object({
  path: z.string().startsWith("/"),
  dir: z.boolean().optional(),
});
