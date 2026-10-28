import { providersSaveSchema } from '../../shared/schemas/ipc-memory-settings';
import { researchIndexOptionsSchema } from '../../shared/schemas/research-index';
import { buildProviderModelKey } from '../../shared/provider-model-key';
import type { DraftIssue, SettingsDraft } from './settings-rules';

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
