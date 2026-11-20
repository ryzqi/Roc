import type {
  AgentCapabilityPreview,
  BuiltinSkillsCheckResult,
  BuiltinSkillsStatus,
  MemoryFileWriteOutcome,
  MemoryKind,
  MemoryScope,
  MemoryStatus,
  SessionMessageSearchRequest,
  SessionMessageSearchResult,
  SkillFilePreviewRequest,
  SkillFilePreviewResult,
  SkillFileTreeRequest,
  SkillFileTreeResult,
  SkillImportRequest,
  SkillSnapshot
} from '../../shared/types';
import type { IpcResult } from '../../shared/types/common';
import type { IpcLikeResult } from '../app/loaded-state';
import type { RocClient } from '../shared/roc-client';

/**
 * Management-drawer data layer (P9/T9.1–T9.4).
 *
 * One wrapper per capability, with the argument shapes verified against
 * `src/shared/ipc-registry.ts`. Four facts here are the ones that go wrong when someone
 * "simplifies" a call site (F24):
 *
 *  1. **The memory domain exposes four capabilities, not six.** `memory.status.get`,
 *     `memory.file.read`, `memory.file.write` and `memory.snapshot.preview` are registered;
 *     the plugin also declares `memory.entries.search` / `memory.entry.remember`, but those
 *     are **not** in `ipc-registry.ts`, so the renderer cannot reach them (B25). Session
 *     search therefore goes through `agent.sessions.search`, and the only structured view of
 *     memory is `memory.status`'s auto-memory audit plus a projection of the markdown.
 *  2. **`memory.file.write` returns a domain outcome, not an IPC failure.** A refused write
 *     (security scan / capacity / invalid path / workspace required) arrives as
 *     `{ok: false, reason, detail, issues?}` inside the *successful* result, so the caller
 *     must branch on the payload — treating it as an error would hide the scan findings.
 *  3. **`skills.import` takes a directory** that must contain `SKILL.md`; there is no ZIP
 *     path in the service, and no directory picker that does not rebind the workspace (B24),
 *     which is why the panel asks for a path instead of pretending a picker can do it.
 *  4. **`memory.file.read` returns `string | null`** — null means "the file does not exist
 *     yet", which is a normal state for the four slots, not an error.
 */

/* ------------------------------------------------------------------ */
/* 记忆 (T9.1)                                                         */
/* ------------------------------------------------------------------ */

export function getMemoryStatus(client: RocClient): Promise<IpcLikeResult<MemoryStatus>> {
  return client.api.memory.status();
}

/** `null` = the slot has no file yet (the backend reads it as empty, not as an error). */
export function readMemoryFile(
  client: RocClient,
  input: { scope: MemoryScope; kind: MemoryKind }
): Promise<IpcLikeResult<string | null>> {
  return client.api.memory.readFile(input);
}

export function writeMemoryFile(
  client: RocClient,
  input: { scope: MemoryScope; kind: MemoryKind; content: string }
): Promise<IpcLikeResult<MemoryFileWriteOutcome>> {
  return client.api.memory.writeFile(input);
}

/**
 * The text that would actually be injected into a run's context.
 *
 * `memorySnapshotPreviewSchema` has no exported type in the `shared/types` barrel, so the shape
 * is expressed structurally from the schema (`z.object({text: z.string()}).strict()`); importing
 * the schema module for the type would be a value import and pull zod into the drawer chunk.
 */
export type MemorySnapshotPreviewText = { text: string };

export function getMemorySnapshotPreview(client: RocClient): Promise<IpcLikeResult<MemorySnapshotPreviewText>> {
  return client.api.memory.snapshotPreview();
}

/* ------------------------------------------------------------------ */
/* 会话记忆检索 (T9.1) — agent 域的 search，不是 memory 域              */
/* ------------------------------------------------------------------ */

export function searchSessionMessages(
  client: RocClient,
  input: SessionMessageSearchRequest
): Promise<IpcLikeResult<SessionMessageSearchResult>> {
  return client.api.sessions.search(input);
}

/* ------------------------------------------------------------------ */
/* 技能 (T9.2)                                                         */
/* ------------------------------------------------------------------ */

export function listSkills(client: RocClient): Promise<IpcResult<SkillSnapshot[]>> {
  return client.api.skills.list();
}

export function importSkill(client: RocClient, input: SkillImportRequest): Promise<IpcLikeResult<SkillSnapshot>> {
  return client.api.skills.importSkill(input);
}

export function setSkillEnabled(
  client: RocClient,
  input: { id: string; enabled: boolean }
): Promise<IpcLikeResult<SkillSnapshot>> {
  return client.api.skills.setEnabled(input);
}

/** Bare id string in, `{deleted:true}` out. */
export function deleteSkill(client: RocClient, id: string): Promise<IpcLikeResult<{ deleted: true }>> {
  return client.api.skills.deleteSkill(id);
}

export function listSkillFiles(
  client: RocClient,
  input: SkillFileTreeRequest
): Promise<IpcLikeResult<SkillFileTreeResult>> {
  return client.api.skills.listFiles(input);
}

export function readSkillFile(
  client: RocClient,
  input: SkillFilePreviewRequest
): Promise<IpcLikeResult<SkillFilePreviewResult>> {
  return client.api.skills.readFile(input);
}

/**
 * The built-in sources are a separate read from `skills.list`: the list says which skills exist,
 * this says which upstream commit put them there and when the next check runs.
 */
export function getBuiltinSkillsStatus(client: RocClient): Promise<IpcLikeResult<BuiltinSkillsStatus>> {
  return client.api.skills.builtinStatus();
}

export function checkBuiltinSkills(
  client: RocClient,
  input: { force?: boolean }
): Promise<IpcLikeResult<BuiltinSkillsCheckResult>> {
  return client.api.skills.builtinCheck(input);
}

export function setBuiltinSkillsAutoUpdate(
  client: RocClient,
  input: { autoUpdate: boolean }
): Promise<IpcLikeResult<BuiltinSkillsStatus>> {
  return client.api.skills.builtinAutoUpdate(input);
}

/**
 * Installs one bundled source. This is also the consent action for non-commercial licenses: the
 * backend records acceptance when this is called, so the button text must state that.
 */
export function restoreBuiltinSkillSource(
  client: RocClient,
  input: { sourceId: string }
): Promise<IpcLikeResult<BuiltinSkillsStatus>> {
  return client.api.skills.builtinRestore(input);
}

/* ------------------------------------------------------------------ */
/* 助手的工具装配预览 (T9.3)                                            */
/* ------------------------------------------------------------------ */

/**
 * What the next run would actually be able to call.
 *
 * This is the only renderer-reachable source of **per-server tool names** (F24): the MCP
 * snapshot's `tools` field is a *count of allowed tools*, and `mcp.tools.get` exists in the
 * plugin but has no IPC channel. `preview.manifest.tools[].provenance` carries
 * `{kind:'mcp', serverId}` plus the model-visible name, and `skippedCapabilities` explains
 * the servers/skills that were requested but not resolved.
 */
export function getCapabilityPreview(
  client: RocClient,
  input: { mcpServers: string[]; skills: string[]; mode: 'chat' | 'plan' | 'task' }
): Promise<IpcLikeResult<AgentCapabilityPreview>> {
  return client.api.agent.getCapabilityPreview(input);
}
