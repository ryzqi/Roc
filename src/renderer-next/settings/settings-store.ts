import type {
  AppStatus,
  ProviderSecretClearResult,
  ProviderSecretSetResult,
  ProviderTestResult,
  ResearchEmbeddingConfig,
  ResearchEmbeddingConfigSaveRequest,
  ResearchIndexSettingsSaveRequest,
  ResearchIndexStatus,
  ResearchModelsStatus,
  ResearchToolchainStatus,
  RocHookConfigSnapshot,
  RocHookTrustRequest,
  RtkStatus,
  SchedulerStatus,
  SettingsSaveRequest,
  SettingsSnapshot,
  TraySummary
} from '../../shared/types';
import type { IpcLikeResult } from '../app/loaded-state';
import type { RocClient } from '../shared/roc-client';

/**
 * Settings-centre data layer (P8/T8.1–T8.4).
 *
 * One wrapper per capability, so no section names a preload method itself. Four
 * contract facts are the reason this file exists instead of calling `window.roc`
 * inline:
 *
 *  1. **`settings.*` is `kind: 'direct'`, not plugin** — the domain has no
 *     `capabilityName`, unlike every other domain in the registry (F22). Inputs and
 *     outputs are still validated by the same contract machinery.
 *  2. **`settings.save` is a whole document.** There is no partial patch: the
 *     caller sends `{settings, providers, defaultModelId, permissions}` and must
 *     preserve every field it does not edit (a dropped field is a deleted setting).
 *  3. **Capability name ≠ preload method name** for the research domain:
 *     `research.index.configure` → `saveIndexSettings`,
 *     `research.index.status` → `getIndexStatus` (F16/F20 — the third phase in a
 *     row where the two tables disagree).
 *  4. **Secrets have exactly two write paths**, and both take plaintext for one
 *     call: `settings.setProviderSecret({providerId, plaintext})` and
 *     `research.embedding.save({…, apiKey})`. `clearProviderSecret` takes a **bare
 *     provider id string**, not an object. The renderer never stores the plaintext
 *     (see `settings-rules.ts`: the draft type has no key field).
 */

/* ------------------------------------------------------------------ */
/* Settings document                                                   */
/* ------------------------------------------------------------------ */

export function getSettingsSnapshot(client: RocClient): Promise<IpcLikeResult<SettingsSnapshot>> {
  return client.api.settings.get();
}

export function saveSettings(client: RocClient, request: SettingsSaveRequest): Promise<IpcLikeResult<SettingsSnapshot>> {
  return client.api.settings.save(request);
}

export function testProvider(
  client: RocClient,
  input: { providerId: string; modelId: string }
): Promise<IpcLikeResult<ProviderTestResult>> {
  return client.api.settings.testProvider(input);
}

export function setProviderSecret(
  client: RocClient,
  input: { providerId: string; plaintext: string }
): Promise<IpcLikeResult<ProviderSecretSetResult>> {
  return client.api.settings.setProviderSecret(input);
}

/** Bare string in, bare result out — not an object (F22). */
export function clearProviderSecret(
  client: RocClient,
  providerId: string
): Promise<IpcLikeResult<ProviderSecretClearResult>> {
  return client.api.settings.clearProviderSecret(providerId);
}

/* ------------------------------------------------------------------ */
/* Hooks                                                               */
/* ------------------------------------------------------------------ */

/**
 * The hooks config (handlers, trust state, validation errors) already arrives inside
 * `settings.get`'s snapshot, so there is no separate `getHooks` wrapper here — one read
 * path means the handler list and the config it was derived from cannot disagree.
 * Trust and save both return the fresh snapshot, which the store reloads.
 */
export function saveHookConfig(
  client: RocClient,
  config: RocHookConfigSnapshot['config']
): Promise<IpcLikeResult<RocHookConfigSnapshot>> {
  return client.api.settings.saveHooks({ config });
}

/** A handler whose hash is unchanged since review stays trusted; any edit resets it. */
export function trustHook(
  client: RocClient,
  input: RocHookTrustRequest
): Promise<IpcLikeResult<RocHookConfigSnapshot>> {
  return client.api.settings.trustHook(input);
}

/* ------------------------------------------------------------------ */
/* Embedding configs and per-project index options                     */
/* ------------------------------------------------------------------ */

export function listEmbeddingConfigs(client: RocClient): Promise<IpcLikeResult<ResearchEmbeddingConfig[]>> {
  return client.api.research.listEmbeddingConfigs();
}

/**
 * Requires a **plaintext** `apiKey` even when only dimensions changed (B23). The main
 * process stores it with `context.secrets.set` — the same safeStorage path as
 * `settings.setProviderSecret` — but the request shape is the reason the embedding
 * editor keeps its key in transient component state instead of the shared draft.
 */
export function saveEmbeddingConfig(
  client: RocClient,
  request: ResearchEmbeddingConfigSaveRequest
): Promise<IpcLikeResult<ResearchEmbeddingConfig>> {
  return client.api.research.saveEmbeddingConfig(request);
}

export function getIndexStatus(client: RocClient, projectId: string): Promise<IpcLikeResult<ResearchIndexStatus>> {
  return client.api.research.getIndexStatus({ projectId });
}

/** Whole-object save with optimistic concurrency: `expectedRevision` is `status.settings.revision`. */
export function saveIndexSettings(
  client: RocClient,
  request: ResearchIndexSettingsSaveRequest
): Promise<IpcLikeResult<ResearchIndexStatus>> {
  return client.api.research.saveIndexSettings(request);
}

/* ------------------------------------------------------------------ */
/* Read-only status surfaces                                           */
/* ------------------------------------------------------------------ */

export function getToolchainStatus(client: RocClient): Promise<IpcLikeResult<ResearchToolchainStatus>> {
  return client.api.research.getToolchainStatus();
}

export function getModelsStatus(client: RocClient): Promise<IpcLikeResult<ResearchModelsStatus>> {
  return client.api.research.getModelsStatus();
}

export function downloadModels(client: RocClient): Promise<IpcLikeResult<ResearchModelsStatus>> {
  return client.api.research.downloadModels();
}

export function getRtkStatus(client: RocClient): Promise<IpcLikeResult<RtkStatus>> {
  return client.api.rtk.status();
}

export function getAppStatus(client: RocClient): Promise<IpcLikeResult<AppStatus>> {
  return client.api.app.getStatus();
}

export function getSchedulerStatus(client: RocClient): Promise<IpcLikeResult<SchedulerStatus>> {
  return client.api.tasks.getSchedulerStatus();
}

/* ------------------------------------------------------------------ */
/* Lifecycle (background execution)                                    */
/* ------------------------------------------------------------------ */

export function getTraySummary(client: RocClient): Promise<IpcLikeResult<TraySummary>> {
  return client.api.lifecycle.getTraySummary();
}

/** Both take **no arguments** and return the new `traySummarySchema` (F22). */
export function pauseBackgroundExecution(client: RocClient): Promise<IpcLikeResult<TraySummary>> {
  return client.api.lifecycle.pauseBackgroundExecution();
}

export function resumeBackgroundExecution(client: RocClient): Promise<IpcLikeResult<TraySummary>> {
  return client.api.lifecycle.resumeBackgroundExecution();
}
