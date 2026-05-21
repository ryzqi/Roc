export async function readMainPageText(page, { pageId, viewSelector, label }) {
  const openedPage = await page.evaluate(async (targetPage) => {
    const result = await window.roc.app.openMainPage(targetPage);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return result.data.page;
  }, pageId);
  if (openedPage !== pageId) {
    throw new Error(`Smoke navigated to ${openedPage} instead of ${pageId}.`);
  }
  await page.waitForSelector(viewSelector, { timeout: 5000 });
  const text = await page.textContent(viewSelector);
  if (text === null) {
    throw new Error(`Smoke could not read ${label} view text.`);
  }
  return text;
}

export async function seedSmokeRuntimeData(page, { providerEndpoint, workspacePath }) {
  await page.evaluate(
    async ({ providerEndpoint: endpoint, workspacePath: rootPath }) => {
      async function unwrap(result, label) {
        if (!result.ok) {
          throw new Error(`${label} failed: ${result.error.message}`);
        }
        return result.data;
      }

      const currentSettings = await unwrap(await window.roc.settings.get(), 'settings get');
      await unwrap(
        await window.roc.settings.setProviderSecret({
          providerId: 'smoke-provider',
          plaintext: 'sk-smoke-seed-secret'
        }),
        'settings set provider secret'
      );
      await unwrap(
        await window.roc.settings.save({
          settings: currentSettings.settings,
          permissions: currentSettings.permissions,
          providers: [
            ...currentSettings.providers,
            {
              id: 'smoke-provider',
              name: 'Smoke Provider',
              type: 'openai_compatible',
              endpoint,
              credentialRef: 'secret:smoke-provider',
              enabled: true,
              models: [
                {
                  id: 'smoke-model',
                  displayName: 'Smoke Model',
                  enabled: true,
                  supportsStreaming: true,
                  supportsToolCalls: true
                }
              ]
            }
          ],
          defaultModelId: 'smoke-model'
        }),
        'settings save'
      );
      await unwrap(
        await window.roc.mcp.upsertServer({
          id: 'smoke-mcp',
          name: 'Smoke MCP',
          enabled: true,
          transport: 'http',
          preset: false,
          riskLevel: 'low',
          url: 'http://127.0.0.1:65534/mcp',
          allowedTools: ['smoke_tool']
        }),
        'mcp upsert'
      );
      await unwrap(await window.roc.mcp.ensureExaPreset(), 'exa preset');

      const backgroundPreview = await unwrap(
        await window.roc.tasks.createBackgroundTaskPreview({
          goal: 'Phase 6 smoke background diagnostic task',
          trigger: {
            type: 'cron',
            description: 'smoke scheduled run',
            cronExpression: '0 9 * * *',
            nextRunAt: '2026-05-22T01:00:00.000Z'
          },
          workspacePath: rootPath,
          allowedActions: ['pnpm test'],
          forbiddenActions: ['git push'],
          failurePolicy: 'pause_and_report',
          notificationPolicy: 'failures_and_confirmations'
        }),
        'background task preview'
      );
      await unwrap(await window.roc.tasks.createBackgroundTask(backgroundPreview), 'background task create');

      const existing = await unwrap(
        await window.roc.memory.search({ query: 'phase four smoke active', source: 'all' }),
        'memory search'
      );
      const existingActiveMemory = existing.items.find((item) =>
        item.summary.includes('phase four smoke active memory validates candidate acceptance and recall.')
      );
      if (existingActiveMemory === undefined) {
        const candidate = await unwrap(
          await window.roc.memory.writeCandidate({
            type: 'project_context',
            scope: 'project:roc-smoke',
            content: 'phase four smoke active memory validates candidate acceptance and recall.',
            confidence: 0.9,
            priority: 'medium',
            source: 'user_explicit',
            sourceRef: 'smoke:memory'
          }),
          'memory candidate'
        );
        const accepted = await unwrap(await window.roc.memory.acceptCandidate(candidate.id), 'memory accept');
        const deleted = await unwrap(await window.roc.memory.delete(accepted.id), 'memory delete');
        if (!deleted.recoverable) {
          throw new Error('memory delete did not create a recoverable state.');
        }
        await unwrap(await window.roc.memory.restore(accepted.id), 'memory restore');
        await unwrap(
          await window.roc.memory.writeCandidate({
            type: 'project_context',
            scope: 'project:roc-smoke',
            content: 'phase four smoke active memory does not validate candidate acceptance and recall.',
            confidence: 0.7,
            priority: 'medium',
            source: 'agent_extract:smoke',
            sourceRef: 'smoke:conflict'
          }),
          'memory conflict candidate'
        );
        await unwrap(
          await window.roc.memory.writeSessionRecall({
            sessionId: 'smoke-session-phase4',
            title: 'phase four smoke session',
            summary: 'phase four smoke session recall validates searchable archived conversation.',
            scope: 'project:roc-smoke',
            content: 'phase four smoke session stores raw recall without promoting it into curated memory.',
            sourceRef: 'smoke:session'
          }),
          'memory session recall'
        );
      }
    },
    { providerEndpoint, workspacePath }
  );
}
