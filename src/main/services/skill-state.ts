import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `roc.skill.json` — the one file Roc owns inside a skill directory.
 *
 * It carries the user's enable toggle and, for skills installed from an upstream repository, the
 * provenance the management surface needs (origin, source, upstream commit). It is written next to
 * `SKILL.md` rather than in a side database so a skill directory stays copyable on its own.
 *
 * Existing installations only have `{schemaVersion: 1, enabled}`; the missing fields load as
 * `user` origin, which is exactly what those skills are until a built-in sync adopts them.
 */

export type SkillOrigin = 'builtin' | 'user';

export type SkillState = {
  schemaVersion: 1;
  enabled: boolean;
  origin: SkillOrigin;
  sourceId: string | null;
  upstreamRepo: string | null;
  upstreamCommit: string | null;
};

export const skillStateFileName = 'roc.skill.json';

export function createDefaultSkillState(origin: SkillOrigin = 'user'): SkillState {
  return {
    schemaVersion: 1,
    enabled: true,
    origin,
    sourceId: null,
    upstreamRepo: null,
    upstreamCommit: null
  };
}

export function readSkillState(skillDir: string): SkillState {
  const path = join(skillDir, skillStateFileName);
  if (!existsSync(path)) {
    return createDefaultSkillState();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return createDefaultSkillState();
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return createDefaultSkillState();
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== 1 || typeof record.enabled !== 'boolean') {
    return createDefaultSkillState();
  }
  return {
    schemaVersion: 1,
    enabled: record.enabled,
    origin: record.origin === 'builtin' ? 'builtin' : 'user',
    sourceId: typeof record.sourceId === 'string' ? record.sourceId : null,
    upstreamRepo: typeof record.upstreamRepo === 'string' ? record.upstreamRepo : null,
    upstreamCommit: typeof record.upstreamCommit === 'string' ? record.upstreamCommit : null
  };
}

export function writeSkillState(skillDir: string, state: SkillState): void {
  const next: SkillState = {
    schemaVersion: 1,
    enabled: state.enabled,
    origin: state.origin,
    sourceId: state.sourceId,
    upstreamRepo: state.upstreamRepo,
    upstreamCommit: state.upstreamCommit
  };
  writeFileSync(join(skillDir, skillStateFileName), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

/** True when the directory is managed by the given built-in source. */
export function isSkillOwnedBy(skillDir: string, sourceId: string): boolean {
  const state = readSkillState(skillDir);
  return state.origin === 'builtin' && state.sourceId === sourceId;
}
