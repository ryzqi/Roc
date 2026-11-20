import { z } from 'zod';
import {
  appSettingsSchema,
  permissionsConfigSchema,
  providerConfigSchema,
  providerModelSchema,
  providersSaveSchema,
  rocHookConfigSchema
} from '../../shared/schemas/ipc-memory-settings';
import { researchIndexOptionsSchema } from '../../shared/schemas/research-index';
import { buildProviderModelKey } from '../../shared/provider-model-key';
import type { DraftIssue, SettingsDraft, SettingsImportResult } from './settings-rules';

// Import can restore a draft with unfinished names. Save still validates nonblank,
// unique identifiers and the default-model relationship.
const importModelSchema = z.object({
  ...providerModelSchema.shape,
  id: z.string(),
  displayName: z.string()
}).strict();
const importProviderSchema = z.object({
  ...providerConfigSchema.shape,
  id: z.string(),
  name: z.string(),
  endpoint: z.string(),
  models: z.array(importModelSchema)
}).strict();
const settingsImportSchema = z.object({
  schemaVersion: z.literal(1),
  exportedAt: z.string().default(''),
  settings: appSettingsSchema,
  providers: z.array(importProviderSchema),
  defaultModelId: z.string().nullable(),
  permissions: permissionsConfigSchema,
  hooks: rocHookConfigSchema
}).strict();

/** Validate every field before an imported document can replace the live draft. */
export function parseSettingsImport(text: string): SettingsImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, error: '不是合法的 JSON 文本。' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: '顶层必须是一个 JSON 对象。' };
  }
  const result = settingsImportSchema.safeParse(parsed);
  if (!result.success) {
    const errors = result.error.issues.map((issue) => {
      const path = issue.path.reduce<string>((value, part) =>
        typeof part === 'number' ? `${value}[${part}]` : `${value}${value ? '.' : ''}${String(part)}`, '');
      return `${path || '文档'}：${issue.message}`;
    });
    return { ok: false, error: errors.join('\n') };
  }
  return { ok: true, document: result.data };
}

/** Shared schema validation plus the settings center's cross-resource model selection rule. */
export function validateDraft(draft: SettingsDraft | null): DraftIssue[] {
  if (draft === null) return [];

  const issues: DraftIssue[] = [];
  const providersResult = providersSaveSchema.safeParse(draft.providers);
  if (!providersResult.success) {
    for (const issue of providersResult.error.issues) {
      issues.push({ path: ['providers', ...issue.path].join('.'), message: issue.message });
    }
  }

  if (draft.defaultModelId !== null) {
    const key = draft.defaultModelId;
    // Main normalizes an unavailable default to null; show the same relationship before save.
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
    const indexResult = researchIndexOptionsSchema.safeParse({
      kinds: draft.index.kinds,
      include: draft.index.include,
      exclude: draft.index.exclude,
      watch: draft.index.watch,
      paused: draft.index.paused,
      embeddingConfigId: draft.index.embeddingConfigId
    });
    if (!indexResult.success) {
      for (const issue of indexResult.error.issues) {
        issues.push({ path: ['index', ...issue.path].join('.'), message: issue.message });
      }
    }
  }

  return issues;
}
