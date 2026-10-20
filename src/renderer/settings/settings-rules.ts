import type { AppSettings, PermissionsConfig, ProviderConfig, SettingsSnapshot } from '../../shared/types/settings';
import type { RocHookConfig } from '../../shared/types/hooks';
import type { ResearchIndexSettings } from '../../shared/types/research';
import { buildProviderModelKey } from '../../shared/provider-model-key';

/**
 * Pure rules for the settings centre (P8/T8.1–T8.3).
 *
 * Type-only imports on purpose: the unit test bundles this file with esbuild
 * so nothing here may pull zod or React into
 * the module graph. Everything that talks to the backend lives in
 * `settings-store.ts`; everything that renders lives in `sections/**`.
 *
 * The four rules encoded here are the ones a component would otherwise re-derive
 * and get subtly wrong:
 *
 *  1. **The whole-save contract.** `settings.save` has no partial patch (F22), so
 *     the draft is the four core parts at once and "dirty" is a *diff against the
 *     loaded snapshot*, not a per-field touched flag. `diffDraftPaths` is that
 *     diff; the count in the dirty bar and the warning dots are both derived from
 *     it, so they can never disagree.
 *  2. **Section attribution.** A changed path maps to exactly one section, so the
 *     dot and the count use one mapping table.
 *  3. **Only backend-real fields.** The draft has no field the backend cannot
 *     store (R15/T8.1). Everything removed from the legacy `ModelSettings` is
 *     registered in findings F22 rather than re-invented here.
 *  4. **Secrets never enter a draft.** `serializeSettingsExport` copies a fixed
 *     allow-list of keys; there is no code path that can copy a plaintext key,
 *     because the draft type has no key field (R16).
 */

/* ------------------------------------------------------------------ */
/* Sections                                                            */
/* ------------------------------------------------------------------ */

export const SETTINGS_SECTIONS = [
  { id: 'models', label: '模型与服务' },
  { id: 'default-model', label: '默认模型' },
  { id: 'rag', label: '向量与 RAG' },
  { id: 'literature', label: '文献与解析' },
  { id: 'sandbox', label: '编译与沙箱' },
  { id: 'guardrail', label: '智能体安全' },
  { id: 'app', label: '应用基础' },
  { id: 'tasks', label: '任务与调度' },
  { id: 'authorization', label: '授权与安全' },
  { id: 'hooks', label: 'Hooks' },
  { id: 'memory', label: '记忆策略' },
  { id: 'backup', label: '偏好与备份' }
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

export function sectionForDraftPath(path: string): SettingsSectionId | null {
  if (path === 'defaultModelId' || path.startsWith('defaultModelId.')) {
    return 'default-model';
  }
  if (path === 'providers' || path.startsWith('providers.')) {
    return 'models';
  }
  if (path === 'permissions' || path.startsWith('permissions.')) {
    return 'guardrail';
  }
  if (path === 'hooks' || path.startsWith('hooks.')) {
    return 'hooks';
  }
  if (path === 'index' || path.startsWith('index.')) {
    return 'rag';
  }
  if (path === 'settings.startup' || path.startsWith('settings.startup.')) {
    return 'app';
  }
  if (path === 'settings.globalHotkey' || path.startsWith('settings.globalHotkey.')) {
    return 'app';
  }
  if (path === 'settings.tasks' || path.startsWith('settings.tasks.')) {
    return 'tasks';
  }
  if (path === 'settings.memory.autoMemory' || path.startsWith('settings.memory.autoMemory.')) {
    return 'memory';
  }
  if (path === 'settings.memory' || path.startsWith('settings.memory.')) {
    return 'guardrail';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Draft                                                               */
/* ------------------------------------------------------------------ */

/**
 * The editable document.
 *
 * `settings`, `providers`, `defaultModelId` and `permissions` are exactly the four
 * parts `settings.save` takes (whole-save, no patch). `hooks` and `index` are
 * separate capabilities but are edited in the same surface, so they ride along and
 * are saved by their own call — the contract has no combined write.
 */
export type SettingsDraft = {
  settings: AppSettings;
  providers: ProviderConfig[];
  defaultModelId: string | null;
  permissions: PermissionsConfig;
  hooks: RocHookConfig;
  /** Per-project index options; null when no project is open (contract requires `projectId`). */
  index: ResearchIndexSettings | null;
};

export function draftFromSnapshot(snapshot: SettingsSnapshot, index: ResearchIndexSettings | null): SettingsDraft {
  return {
    settings: clone(snapshot.settings),
    // The whole object round-trips, including fields this UI does not edit
    // (`credentialRef`, `options.defaultHeaders`, `permissions.grants`). Dropping an
    // untouched field on save would delete real configuration.
    providers: clone(snapshot.providers),
    defaultModelId: snapshot.defaultModelId,
    permissions: clone(snapshot.permissions),
    hooks: clone(snapshot.hooks.config),
    index: index === null ? null : { ...index }
  };
}

export function cloneDraft(draft: SettingsDraft): SettingsDraft {
  return clone(draft);
}

/* ------------------------------------------------------------------ */
/* Diffing                                                             */
/* ------------------------------------------------------------------ */

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Structured deep copy for the draft.
 *
 * The draft must not alias the loaded snapshot: mutating a nested draft object in
 * place would silently edit the baseline the dirty diff compares against, and the
 * diff would then report zero changes.
 */
function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Leaf paths where `draft` differs from `base`.
 *
 * Arrays are compared per index; adding or removing an element counts as one
 * change at that index. When a whole subtree is added or removed by identity
 * (undefined ↔ value) it counts once, which is what the dirty bar should say:
 * "adding a provider" is one unsaved item, not twelve.
 */
export function diffDraftPaths(base: unknown, draft: unknown, prefix = ''): string[] {
  if (Object.is(base, draft)) {
    return [];
  }
  const baseRecord = isRecord(base);
  const draftRecord = isRecord(draft);
  if (baseRecord && draftRecord) {
    const keys = new Set([...Object.keys(base), ...Object.keys(draft)]);
    const paths: string[] = [];
    for (const key of keys) {
      const next = prefix === '' ? key : `${prefix}.${key}`;
      const baseValue = base[key];
      const draftValue = draft[key];
      if (Object.is(baseValue, draftValue)) {
        continue;
      }
      if (baseValue === undefined || draftValue === undefined) {
        paths.push(next);
        continue;
      }
      paths.push(...diffDraftPaths(baseValue, draftValue, next));
    }
    return paths;
  }
  if (Array.isArray(base) && Array.isArray(draft)) {
    const paths: string[] = [];
    const length = Math.max(base.length, draft.length);
    for (let index = 0; index < length; index += 1) {
      const next = prefix === '' ? String(index) : `${prefix}.${index}`;
      const baseValue: unknown = base[index];
      const draftValue: unknown = draft[index];
      if (Object.is(baseValue, draftValue)) {
        continue;
      }
      if (baseValue === undefined || draftValue === undefined) {
        paths.push(next);
        continue;
      }
      paths.push(...diffDraftPaths(baseValue, draftValue, next));
    }
    return paths;
  }
  return [prefix];
}

export function dirtySectionIds(paths: readonly string[]): Set<SettingsSectionId> {
  const sections = new Set<SettingsSectionId>();
  for (const path of paths) {
    const section = sectionForDraftPath(path);
    if (section !== null) {
      sections.add(section);
    }
  }
  return sections;
}

export type DraftDiff = {
  paths: string[];
  count: number;
  sections: Set<SettingsSectionId>;
};

export function diffDraft(base: SettingsDraft | null, draft: SettingsDraft | null): DraftDiff {
  if (base === null || draft === null) {
    return { paths: [], count: 0, sections: new Set() };
  }
  const paths = diffDraftPaths(base, draft);
  return { paths, count: paths.length, sections: dirtySectionIds(paths) };
}

/* ------------------------------------------------------------------ */
/* High-impact changes (T8.2)                                          */
/* ------------------------------------------------------------------ */

export type HighImpactChange = { id: string; title: string; detail: string };

function modelLabel(providers: readonly ProviderConfig[], key: string | null): string | null {
  if (key === null) {
    return null;
  }
  for (const provider of providers) {
    const model = provider.models.find((entry) => buildProviderModelKey(provider.id, entry.id) === key);
    if (model !== undefined) {
      return `${model.displayName} · ${provider.name}`;
    }
  }
  return key;
}

/**
 * The three settings whose effect reaches outside the window (T8.2): the default
 * model (every new run), login item (the OS), and the global hotkey (the system
 * keyboard table). The save flow lists these before writing.
 */
export function highImpactChanges(base: SettingsDraft | null, draft: SettingsDraft | null): HighImpactChange[] {
  if (base === null || draft === null) {
    return [];
  }
  const changes: HighImpactChange[] = [];
  if (base.defaultModelId !== draft.defaultModelId) {
    const next = modelLabel(draft.providers, draft.defaultModelId);
    changes.push({
      id: 'default-model',
      title: '默认模型',
      detail:
        next === null
          ? '默认模型将被清空：需要模型的入口（助手、阶段运行）会要求先配置。'
          : `新会话与阶段运行将默认使用 ${next}；正在进行的运行不受影响。`
    });
  }
  if (base.settings.startup.openAtLogin !== draft.settings.startup.openAtLogin) {
    changes.push({
      id: 'open-at-login',
      title: '开机启动',
      detail: draft.settings.startup.openAtLogin
        ? '下次登录 macOS 时 Roc 会自动启动。'
        : 'Roc 不再随 macOS 登录启动。'
    });
  }
  if (base.settings.globalHotkey !== draft.settings.globalHotkey) {
    const next = draft.settings.globalHotkey;
    changes.push({
      id: 'global-hotkey',
      title: '全局热键',
      detail:
        next === null || next.trim().length === 0
          ? '全局热键将被清除。'
          : `全局热键将改为 ${next}；若与系统或其它应用冲突，注册会失败并在这里显示原因。`
    });
  }
  return changes;
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export type DraftIssue = { path: string; message: string };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Field-level checks that mirror the backend's own schema rules, so a typo is shown
 * next to the field instead of coming back as one opaque save failure. Anything not
 * checked here is still validated by the backend on save — this is a convenience
 * layer, never the authority.
 */
export function validateDraft(draft: SettingsDraft | null): DraftIssue[] {
  if (draft === null) {
    return [];
  }
  const issues: DraftIssue[] = [];
  const providerIds = new Set<string>();

  draft.providers.forEach((provider, providerIndex) => {
    const at = (suffix: string): string => `providers.${providerIndex}.${suffix}`;
    if (provider.id.trim().length === 0) {
      issues.push({ path: at('id'), message: '提供商标识不能为空。' });
    } else if (providerIds.has(provider.id)) {
      issues.push({ path: at('id'), message: `提供商标识重复：${provider.id}` });
    }
    providerIds.add(provider.id);
    if (provider.name.trim().length === 0) {
      issues.push({ path: at('name'), message: '供应商名称不能为空。' });
    }
    if (provider.endpoint.trim().length === 0) {
      issues.push({ path: at('endpoint'), message: '接入地址不能为空。' });
    }

    const modelIds = new Set<string>();
    provider.models.forEach((model, modelIndex) => {
      const modelAt = (suffix: string): string => `${at(`models.${modelIndex}.${suffix}`)}`;
      if (model.id.trim().length === 0) {
        issues.push({ path: modelAt('id'), message: '模型标识不能为空。' });
      } else if (modelIds.has(model.id)) {
        issues.push({ path: modelAt('id'), message: `同一供应商下模型标识重复：${model.id}` });
      }
      modelIds.add(model.id);
      if (model.displayName.trim().length === 0) {
        issues.push({ path: modelAt('displayName'), message: '模型显示名不能为空。' });
      }
      const options = model.options;
      if (options === undefined) {
        return;
      }
      if (options.temperature !== undefined && !isFiniteNumber(options.temperature)) {
        issues.push({ path: modelAt('options.temperature'), message: '温度必须是有限数字。' });
      }
      if (options.maxTokens !== undefined && !isPositiveInt(options.maxTokens)) {
        issues.push({ path: modelAt('options.maxTokens'), message: '最大 token 必须是正整数。' });
      }
      if (options.topP !== undefined && (options.topP < 0 || options.topP > 1)) {
        issues.push({ path: modelAt('options.topP'), message: 'top-p 必须在 0 与 1 之间。' });
      }
      if (
        options.anthropicThinking?.mode === 'enabled' &&
        options.maxTokens !== undefined &&
        options.anthropicThinking.budgetTokens >= options.maxTokens
      ) {
        issues.push({
          path: modelAt('options.anthropicThinking.budgetTokens'),
          message: '思考预算是必须小于最大 token（后端会拒绝）。'
        });
      }
    });
  });

  if (draft.defaultModelId !== null) {
    const key = draft.defaultModelId;
    // `normalizeProvidersConfig` (main side) silently nulls a default whose provider or
    // model is disabled, so an enabled-only check is the honest one: anything else would
    // be accepted here and come back as 「未配置」 after the save.
    const found = draft.providers.some(
      (provider) =>
        provider.enabled &&
        provider.models.some((model) => model.enabled && buildProviderModelKey(provider.id, model.id) === key)
    );
    if (!found) {
      issues.push({
        path: 'defaultModelId',
        message: `默认模型 ${key} 不在已启用（且启用了该模型）的供应商里；请先启用它或改选一个。`
      });
    }
  }

  if (draft.index !== null) {
    if (draft.index.kinds.length === 0) {
      issues.push({ path: 'index.kinds', message: '至少选择一种索引文件类型。' });
    }
    if (draft.index.include.length === 0) {
      issues.push({ path: 'index.include', message: '包含模式至少要有 1 条。' });
    }
    if (draft.index.include.length > 100 || draft.index.exclude.length > 100) {
      issues.push({ path: 'index.include', message: '包含/排除模式各最多 100 条。' });
    }
    if (draft.index.embeddingConfigId !== null && draft.index.embeddingConfigId.trim().length === 0) {
      issues.push({ path: 'index.embeddingConfigId', message: '嵌入配置引用不能是空字符串。' });
    }
  }

  return issues;
}

/* ------------------------------------------------------------------ */
/* Model options                                                       */
/* ------------------------------------------------------------------ */

export type ModelOption = { key: string; label: string; providerId: string; modelId: string; enabled: boolean };

/** Every provider/model pair, with the key format the settings document uses. */
export function modelOptions(providers: readonly ProviderConfig[]): ModelOption[] {
  return providers.flatMap((provider) =>
    provider.models.map((model) => ({
      key: buildProviderModelKey(provider.id, model.id),
      label: `${model.displayName} · ${provider.name}${model.enabled ? '' : '（已停用）'}`,
      providerId: provider.id,
      modelId: model.id,
      enabled: model.enabled
    }))
  );
}

/** Providers tappable by `settings.testProvider`, which requires a concrete model. */
export function testableModelOptions(
  providers: readonly ProviderConfig[],
  providerId: string | null
): Array<{ key: string; label: string }> {
  if (providerId === null) {
    return [];
  }
  const provider = providers.find((entry) => entry.id === providerId);
  if (provider === undefined) {
    return [];
  }
  return provider.models
    .filter((model) => model.enabled)
    .map((model) => ({ key: model.id, label: model.displayName }));
}

/* ------------------------------------------------------------------ */
/* Export / import (T8.3 偏好与备份)                                    */
/* ------------------------------------------------------------------ */

/**
 * The export document is ours, not the backend's `settingsDocumentSchema`: it has no
 * `mcp` or `shortcuts` section because this surface does not own those, and it
 * carries `hooks` because the hooks config is portable.
 *
 * It is built from an allow-list of keys. There is no plaintext secret anywhere in
 * `SettingsDraft` (keys live in `safeStorage` behind `settings.setProviderSecret`,
 * and `credentialRef` is a reference), so the snapshot cannot leak one by design —
 * `assertNoPlaintextSecret` is the belt to that suspenders.
 */
export type SettingsExportDocument = {
  schemaVersion: 1;
  exportedAt: string;
  settings: AppSettings;
  providers: ProviderConfig[];
  defaultModelId: string | null;
  permissions: PermissionsConfig;
  hooks: RocHookConfig;
};

function buildExportDocument(draft: SettingsDraft, exportedAt: string): SettingsExportDocument {
  return {
    schemaVersion: 1,
    exportedAt,
    settings: clone(draft.settings),
    providers: clone(draft.providers),
    defaultModelId: draft.defaultModelId,
    permissions: clone(draft.permissions),
    hooks: clone(draft.hooks)
  };
}

export function serializeSettingsExport(draft: SettingsDraft, exportedAt: string): string {
  return JSON.stringify(buildExportDocument(draft, exportedAt), null, 2);
}

/**
 * The assertion the security test and the P8 gate both use: a failed export is a
 * leaked secret, so this throws rather than returning a flag — a silent `false`
 * return is how a leak ships.
 */
export function assertNoPlaintextSecret(serialized: string, secrets: readonly string[]): void {
  for (const secret of secrets) {
    if (secret.trim().length === 0) {
      continue;
    }
    if (serialized.includes(secret)) {
      throw new Error(`settings_export_contains_plaintext_secret:${secret.slice(0, 4)}…`);
    }
  }
}

export type SettingsImportResult =
  | { ok: true; document: SettingsExportDocument }
  | { ok: false; error: string };

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/**
 * Structural validation of our own export format — deliberately not the backend's
 * zod schema: the authority on whether a document is acceptable is the backend,
 * which validates the whole save request. What is checked here is that the text is
 * the document we produced (so a random JSON file cannot half-apply), and every
 * failure names the field so the user can fix it.
 */
export function parseSettingsImport(text: string): SettingsImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, error: '不是合法的 JSON 文本。' };
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: '顶层必须是一个 JSON 对象。' };
  }
  if (parsed.schemaVersion !== 1) {
    return { ok: false, error: 'schemaVersion 必须是 1（本设置中心导出的快照）。' };
  }
  if (!isRecord(parsed.settings)) {
    return { ok: false, error: '缺少 settings 对象。' };
  }
  if (!Array.isArray(parsed.providers)) {
    return { ok: false, error: '缺少 providers 数组。' };
  }
  for (const [index, provider] of parsed.providers.entries()) {
    if (!isRecord(provider)) {
      return { ok: false, error: `providers[${index}] 不是对象。` };
    }
    if (typeof provider.id !== 'string' || typeof provider.name !== 'string' || typeof provider.endpoint !== 'string') {
      return { ok: false, error: `providers[${index}] 缺少 id / name / endpoint 字符串字段。` };
    }
    if (!Array.isArray(provider.models)) {
      return { ok: false, error: `providers[${index}].models 必须是数组。` };
    }
  }
  if (!isStringOrNull(parsed.defaultModelId)) {
    return { ok: false, error: 'defaultModelId 必须是字符串或 null。' };
  }
  if (!isRecord(parsed.permissions) || typeof parsed.permissions.mode !== 'string') {
    return { ok: false, error: '缺少 permissions.mode。' };
  }
  if (parsed.permissions.mode !== 'fully_automatic' && parsed.permissions.mode !== 'default') {
    return { ok: false, error: 'permissions.mode 只能是 fully_automatic 或 default。' };
  }
  if (!isRecord(parsed.hooks) || parsed.hooks.schemaVersion !== 1 || !isRecord(parsed.hooks.hooks)) {
    return { ok: false, error: '缺少 hooks 配置（schemaVersion 1）。' };
  }
  // SAFETY: every branch above has checked the shape this document needs
  // (schemaVersion 1, record settings, provider array with id/name/endpoint/models,
  // string|null defaultModelId, permissions.mode in the two-value enum, hooks at
  // schemaVersion 1). The remaining fields are validated by the backend when the
  // imported document is saved, which is the authority — this function only decides
  // whether the text is our snapshot at all.
  const document: SettingsExportDocument = {
    schemaVersion: 1,
    exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : '',
    // SAFETY: checked above to be a record; the field-by-field shape is the backend's
    // job on save (see the comment above).
    settings: parsed.settings as AppSettings,
    // SAFETY: checked above to be an array of records carrying the three identifying
    // strings and a `models` array.
    providers: parsed.providers as ProviderConfig[],
    defaultModelId: parsed.defaultModelId,
    // SAFETY: checked above to be a record whose `mode` is one of the two literals.
    permissions: parsed.permissions as PermissionsConfig,
    // SAFETY: checked above to be `{schemaVersion: 1, hooks: record}`.
    hooks: parsed.hooks as RocHookConfig
  };
  return { ok: true, document };
}

/** Applies an imported document to the current draft, keeping the live index options. */
export function applyImport(document: SettingsExportDocument, current: SettingsDraft): SettingsDraft {
  return {
    settings: clone(document.settings),
    providers: clone(document.providers),
    defaultModelId: document.defaultModelId,
    permissions: clone(document.permissions),
    hooks: clone(document.hooks),
    index: current.index === null ? null : { ...current.index }
  };
}

/* ------------------------------------------------------------------ */
/* Index patterns                                                      */
/* ------------------------------------------------------------------ */

/** One pattern per line — the only textarea format, so it round-trips exactly. */
export function linesToPatterns(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function patternsToLines(patterns: readonly string[]): string {
  return patterns.join('\n');
}

export const INDEX_KIND_LABELS: Readonly<Record<ResearchIndexSettings['kinds'][number], string>> = {
  markdown: 'Markdown',
  latex: 'LaTeX',
  bibliography: '参考文献',
  csv: 'CSV',
  pdf: 'PDF',
  image: '图片',
  html: 'HTML'
};

/* ------------------------------------------------------------------ */
/* Provider drafts                                                     */
/* ------------------------------------------------------------------ */

export type ProviderType = ProviderConfig['type'];

export const PROVIDER_TYPE_LABELS: Readonly<Record<ProviderType, string>> = {
  openai_compatible: 'OpenAI 兼容',
  anthropic_compatible: 'Anthropic 兼容',
  nvidia: 'NVIDIA（内置）',
  openrouter: 'OpenRouter（内置）',
  llama_cpp: 'llama.cpp（内置）',
  ollama: 'Ollama',
  custom: '自定义'
};

/** Types a user may create from this surface (the three built-ins always exist). */
export const CREATABLE_PROVIDER_TYPES: readonly ProviderType[] = [
  'openai_compatible',
  'anthropic_compatible',
  'ollama',
  'custom'
];

export const DEFAULT_PROVIDER_ENDPOINTS: Readonly<Partial<Record<ProviderType, string>>> = {
  openai_compatible: 'https://api.openai.com/v1',
  anthropic_compatible: 'https://api.anthropic.com',
  ollama: 'http://127.0.0.1:11434/v1'
};

/**
 * The three providers the main process always materialises (`normalizeProvidersConfig` in
 * `config/provider-rules.ts`). Their id, name, endpoint and credential reference are
 * rewritten on every save, so the surface locks those fields and marks them 「内置」
 * rather than offering an edit the backend would silently discard.
 */
export const FIXED_PROVIDER_IDS: readonly string[] = ['nvidia', 'openrouter', 'llama_cpp'];

export function isFixedProviderId(providerId: string): boolean {
  return FIXED_PROVIDER_IDS.includes(providerId.trim().toLowerCase());
}

/**
 * Provider id from a display name.
 *
 * Mirrors the legacy shell's rule (ASCII-fold, slugify, FNV-1a fallback for names with no
 * ASCII letters) so an id created here has the shape the main process's id pattern
 * expects, and so renaming a provider does not silently move its credential file.
 */
export function providerIdFromName(name: string): string {
  const normalized = name.trim();
  if (normalized.length === 0) {
    return '';
  }
  const slug = normalized
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  if (slug.length > 0) {
    return slug;
  }
  if (!/[\p{L}\p{N}]/u.test(normalized)) {
    return '';
  }
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `provider-${hash.toString(16).padStart(8, '0')}`;
}

/** A model row with the legacy shell's defaults, so behaviour does not shift. */
export function createModelDraft(): ProviderConfig['models'][number] {
  return {
    id: '',
    displayName: '',
    enabled: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsImages: false
  };
}

/**
 * A new provider draft with a unique id.
 *
 * Non-fixed providers keep `credentialRef` pointing at their own secret slot, which is
 * what `settings.setProviderSecret` writes — a stored key is unusable until the provider
 * references it (`resolveCredential` in the main process).
 */
export function createProviderDraft(type: ProviderType, existingIds: readonly string[]): ProviderConfig {
  const base = providerIdFromName(`new-${type}`) || 'provider';
  let id = base;
  let suffix = 1;
  while (existingIds.includes(id)) {
    suffix += 1;
    id = `${base}-${suffix}`;
  }
  return {
    id,
    name: '',
    type,
    endpoint: DEFAULT_PROVIDER_ENDPOINTS[type] ?? '',
    credentialRef: null,
    enabled: true,
    models: [createModelDraft()]
  };
}

/** The `secret:<providerId>` reference a provider needs once its key is stored. */
export function credentialRefFor(providerId: string): string {
  return `secret:${providerId}`;
}
