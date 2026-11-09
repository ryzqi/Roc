/** One-time cleanup of persisted configuration; current schemas accept no accounting fields. */
export function removeExecutionConfig(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const document = structuredClone(value) as Record<string, unknown>;
  const providers = (document.providers as { providers?: Array<{ models?: Array<{ options?: Record<string, unknown> }> }> } | undefined)?.providers;
  for (const provider of providers ?? []) {
    for (const model of provider.models ?? []) {
      const options = model.options;
      if (options === undefined) continue;
      if ('contextBudgetTokens' in options) {
        options.contextWindowTokens ??= options.contextBudgetTokens;
        delete options.contextBudgetTokens;
      }
      if ((options.anthropicThinking as { mode?: string } | undefined)?.mode === 'enabled') {
        // Manual thinking required a token allocation. Leave the provider default in control.
        delete options.anthropicThinking;
      }
    }
  }
  return document;
}

export function removePilotAccounting(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const settings = { ...value } as Record<string, unknown>;
  for (const key of ['extraBudgetMicrousd', 'budgetAcknowledgedAt', 'spentMicrousd', 'allowance', 'spent', 'costState']) delete settings[key];
  if (settings.breakerReason === 'pilot_budget_exhausted' || settings.breakerReason === 'pilot_allowance_exhausted') {
    if (settings.breakerReason === 'pilot_allowance_exhausted' && typeof settings.failureStreak === 'number') {
      settings.failureStreak = Math.max(0, settings.failureStreak - 1);
    }
    settings.circuitOpen = false;
    settings.breakerReason = null;
  }
  return settings;
}
