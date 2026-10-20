import { z } from 'zod';

/**
 * Built-in skill sources (upstream GitHub repositories that Roc vendors and keeps in sync).
 *
 * The snapshot lives inside the installed app (`resources/builtin-skills`), the installed copy
 * lives in `~/.roc/skills`, and the sync state lives in `~/.roc/config/builtin-skills.json`.
 * `commit` is the upstream commit the snapshot/installation was built from; the renderer shows it
 * so "did the update actually land" is answerable without opening the filesystem.
 */
export const builtinSkillSourceStatusSchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    repo: z.string().min(1),
    ref: z.string().min(1),
    license: z.string().nullable(),
    homepage: z.string().nullable(),
    bundledCommit: z.string(),
    installedCommit: z.string().nullable(),
    skillIds: z.array(z.string().min(1)),
    lastCheckedAt: z.string().nullable(),
    lastError: z.string().nullable()
  })
  .strict();

export const builtinSkillsStatusSchema = z
  .object({
    schemaVersion: z.literal(1),
    autoUpdate: z.boolean(),
    updating: z.boolean(),
    lastCheckedAt: z.string().nullable(),
    sources: z.array(builtinSkillSourceStatusSchema)
  })
  .strict();

export const builtinSkillsCheckRequestSchema = z
  .object({ force: z.boolean().optional() })
  .strict();

export const builtinSkillsAutoUpdateRequestSchema = z
  .object({ autoUpdate: z.boolean() })
  .strict();

export const builtinSkillsCheckResultSchema = builtinSkillsStatusSchema
  .extend({
    /** True when at least one source was reinstalled from a newer upstream commit. */
    changed: z.boolean(),
    /** Per-source failures from this check; the status also carries `lastError`. */
    errors: z.array(z.string())
  })
  .strict();
