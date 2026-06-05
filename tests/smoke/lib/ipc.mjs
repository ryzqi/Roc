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

export async function seedSmokeRuntimeData(
  page,
  { providerEndpoint, workspacePath, backgroundTaskGoal, backgroundTaskCronExpression, backgroundTaskNextRunAt }
) {
  await page.evaluate(
    async ({
      providerEndpoint: endpoint,
      workspacePath: rootPath,
      backgroundTaskGoal: seededBackgroundTaskGoal,
      backgroundTaskCronExpression: seededBackgroundTaskCronExpression,
      backgroundTaskNextRunAt: seededBackgroundTaskNextRunAt
    }) => {
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
          goal: seededBackgroundTaskGoal,
          trigger: {
            type: 'cron',
            description: 'smoke scheduled run',
            cronExpression: seededBackgroundTaskCronExpression,
            nextRunAt: seededBackgroundTaskNextRunAt
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

      await unwrap(await window.roc.memory.status(), 'memory status');
    },
    { providerEndpoint, workspacePath, backgroundTaskGoal, backgroundTaskCronExpression, backgroundTaskNextRunAt }
  );
}
