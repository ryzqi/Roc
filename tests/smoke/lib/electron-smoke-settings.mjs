import { waitForTextContent } from './assertions.mjs';
import { clickSmokeControl, openChatView } from './ui-actions.mjs';

export async function runSmokeSettingsChecks(ctx) {
  const { page, smokeProvider } = ctx;
  const providerSettingsEvidence = {
    nvidiaListed: false,
    nvidiaFixedDetail: false,
    nvidiaDefaultModelChoicesVisible: false,
    llamaCppListed: false,
    llamaCppFixedDetail: false,
    llamaCppDefaultModelChoicesVisible: false,
    smokeProviderListed: false,
    providerActionsVisible: false,
    addProviderEntryVisible: false,
    headerChromeRemoved: false,
    apiKeyHelpRemoved: false,
    createWithoutApiKeyAllowed: false,
    editWithoutApiKeyAllowed: false,
    detailScrollReachable: false,
    searchMatchesNameAndId: false,
    openaiSlugGenerated: false,
    openaiCreated: false,
    openaiSecretStored: false,
    openaiApiKeyCleared: false,
    openaiSecretUpdated: false,
    openaiRotatedSecretUsed: false,
    anthropicSlugGenerated: false,
    anthropicCreated: false,
    anthropicSecretStored: false,
    anthropicSecretCleared: false,
    chineseProviderNameVisible: false,
    chineseProviderAsciiId: false,
    openaiReady: false,
    defaultModelSelectable: false,
    providerTestFeedbackVisible: false,
    saveAllDirect: false,
    hostIntegrationReturned: false,
    hostIntegrationStatusVisible: false
  };
  await clickSmokeControl(page, '[data-testid="settings-gear"]');
  await page.waitForSelector('[data-testid="settings-modal"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="settings-view"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="provider-settings"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="provider-list-item-nvidia"]', { timeout: 5000 });
  providerSettingsEvidence.nvidiaListed = true;
  providerSettingsEvidence.nvidiaFixedDetail = await page.evaluate(() => {
    const models = document.querySelector('[data-testid="provider-model-card-0"]');
    const legacyModelId = document.querySelector('[data-testid="provider-draft-model-id"]');
    const endpoint = document.querySelector('[data-testid="provider-draft-endpoint"]');
    const deleteButton = document.querySelector('[data-testid="provider-delete-nvidia"]');
    const statusPills = Array.from(
      document.querySelectorAll('.provider-detail-title .provider-status-pill'),
      (element) => element.textContent?.trim() ?? ''
    );
    return (
      models instanceof HTMLElement &&
      legacyModelId === null &&
      endpoint instanceof HTMLInputElement &&
      endpoint.readOnly === true &&
      endpoint.value === 'https://integrate.api.nvidia.com/v1' &&
      deleteButton === null &&
      !statusPills.includes('Fixed')
    );
  });
  await setFirstModel(page, 'moonshotai/kimi-k2.6', 'Kimi K2.6');
  await clickSmokeControl(page, '[data-testid="provider-model-add"]');
  await page.fill('[data-testid="provider-model-id-1"]', 'meta/llama-3.3-70b-instruct');
  await page.fill('[data-testid="provider-model-name-1"]', 'Llama 3.3 70B');
  await clickSmokeControl(page, '[data-testid="provider-save"]');
  await page.waitForFunction(
    async () => {
      const result = await window.roc.settings.get();
      if (!result.ok) {
        return false;
      }
      const provider = result.data.providers.find((entry) => entry.id === 'nvidia');
      return (
        provider !== undefined &&
        provider.models.length === 2 &&
        provider.models[0]?.id === 'moonshotai/kimi-k2.6' &&
        provider.models[1]?.id === 'meta/llama-3.3-70b-instruct' &&
        document.querySelector('[data-testid="provider-model-card-1"]') instanceof HTMLElement
      );
    },
    undefined,
    { timeout: 5000 }
  );
  await clickSmokeControl(page, '[data-testid="provider-list-item-llama_cpp"]');
  await page.waitForSelector('[data-testid="provider-model-test-0"]', { timeout: 5000 });
  providerSettingsEvidence.llamaCppListed = true;
  providerSettingsEvidence.llamaCppFixedDetail = await page.evaluate(() => {
    const models = document.querySelector('[data-testid="provider-model-card-0"]');
    const name = document.querySelector('[data-testid="provider-draft-name"]');
    const endpoint = document.querySelector('[data-testid="provider-draft-endpoint"]');
    const deleteButton = document.querySelector('[data-testid="provider-delete-llama_cpp"]');
    return (
      models instanceof HTMLElement &&
      name === null &&
      endpoint instanceof HTMLInputElement &&
      endpoint.readOnly === false &&
      endpoint.value === 'http://127.0.0.1:8081/v1' &&
      deleteButton === null
    );
  });
  await setFirstModel(page, 'qwen3.5-4b', 'Qwen 3.5 4B');
  await clickSmokeControl(page, '[data-testid="provider-save"]');
  await page.waitForFunction(
    async () => {
      const result = await window.roc.settings.get();
      if (!result.ok) {
        return false;
      }
      const provider = result.data.providers.find((entry) => entry.id === 'llama_cpp');
      const endpoint = document.querySelector('[data-testid="provider-draft-endpoint"]');
      return (
        provider !== undefined &&
        provider.credentialRef === null &&
        provider.endpoint === 'http://127.0.0.1:8081/v1' &&
        provider.models.length === 1 &&
        provider.models[0]?.id === 'qwen3.5-4b' &&
        endpoint instanceof HTMLInputElement &&
        endpoint.value === 'http://127.0.0.1:8081/v1' &&
        document.querySelector('[data-testid="provider-model-id-0"]')?.value === 'qwen3.5-4b'
      );
    },
    undefined,
    { timeout: 5000 }
  );
  providerSettingsEvidence.headerChromeRemoved = await page.evaluate(() => {
    const header = document.querySelector('[data-testid="settings-header"]');
    if (!(header instanceof HTMLElement)) {
      return false;
    }
    return (
      header.querySelector('.page-copy') === null &&
      header.querySelector('.page-kicker') === null &&
      header.querySelector('.page-title') === null &&
      header.querySelector('[data-testid="settings-dirty-count"]') instanceof HTMLElement &&
      header.querySelector('[data-testid="settings-reset-all"]') instanceof HTMLElement &&
      header.querySelector('[data-testid="settings-save-all"]') instanceof HTMLElement
    );
  });
  await clickSmokeControl(page, '[data-testid="provider-list-item-smoke-provider"]');
  await page.waitForSelector('[data-testid="provider-test-smoke-provider"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="provider-delete-smoke-provider"]', { timeout: 5000 });
  providerSettingsEvidence.smokeProviderListed = true;
  providerSettingsEvidence.providerActionsVisible = true;
  for (const sectionId of [
    'providers',
    'default-model',
    'app-basics',
    'tasks',
    'auth-security',
    'memory'
  ]) {
    await clickSmokeControl(page, `[data-testid="settings-section-${sectionId}"]`);
    await page.waitForSelector(`[data-testid="settings-panel-${sectionId}"], [data-testid="provider-settings"], [data-testid="default-model-settings"]`, {
      timeout: 5000
    });
    if (sectionId === 'tasks') {
      providerSettingsEvidence.taskSettingsVisible =
        (await page.locator('[data-testid="settings-panel-tasks"]').count()) > 0 ||
        ((await page.textContent('[data-testid="settings-view"]')) ?? '').includes('任务与调度');
    }
  }
  await clickSmokeControl(page, '[data-testid="settings-section-default-model"]');
  await page.waitForFunction(
    () => {
      const kimi = document.querySelector('[data-testid="default-model-nvidia-moonshotai/kimi-k2.6"]');
      const llama = document.querySelector('[data-testid="default-model-nvidia-meta/llama-3.3-70b-instruct"]');
      const llamaCpp = document.querySelector('[data-testid="default-model-llama_cpp-qwen3.5-4b"]');
      return kimi instanceof HTMLButtonElement && llama instanceof HTMLButtonElement && llamaCpp instanceof HTMLButtonElement;
    },
    undefined,
    { timeout: 5000 }
  );
  providerSettingsEvidence.nvidiaDefaultModelChoicesVisible = true;
  providerSettingsEvidence.llamaCppDefaultModelChoicesVisible = true;
  await clickSmokeControl(page, '[data-testid="settings-section-providers"]');
  await page.waitForSelector('[data-testid="provider-add-anthropic"]', { state: 'detached', timeout: 5000 });
  await page.waitForSelector('[data-testid="provider-add-openai"]', { timeout: 5000 });
  providerSettingsEvidence.addProviderEntryVisible = true;
  const renamedSmokeProviderName = 'Smoke Provider Renamed';
  await page.fill('[data-testid="provider-draft-name"]', renamedSmokeProviderName);
  await clickSmokeControl(page, '[data-testid="provider-save"]');
  await page.waitForFunction(
    async ({ providerId, providerName }) => {
      const result = await window.roc.settings.get();
      if (!result.ok) {
        return false;
      }
      const provider = result.data.providers.find((entry) => entry.id === providerId);
      const secretStored = result.data.providerSecretStatus.find((entry) => entry.providerId === providerId)?.stored === true;
      return (
        provider?.name === providerName &&
        secretStored &&
        document.querySelector('[data-testid="provider-draft-status"]') === null
      );
    },
    { providerId: 'smoke-provider', providerName: renamedSmokeProviderName },
    { timeout: 5000 }
  );
  const smokeProviderEditState = await page.evaluate(async ({ providerId, providerName }) => {
    const result = await window.roc.settings.get();
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    const provider = result.data.providers.find((entry) => entry.id === providerId);
    return {
      providerName: provider?.name ?? null,
      secretStored:
        result.data.providerSecretStatus.find((entry) => entry.providerId === providerId)?.stored === true,
      statusText: document.querySelector('[data-testid="provider-draft-status"]')?.textContent ?? null
    };
  }, { providerId: 'smoke-provider', providerName: renamedSmokeProviderName });
  providerSettingsEvidence.editWithoutApiKeyAllowed =
    smokeProviderEditState.providerName === renamedSmokeProviderName &&
    smokeProviderEditState.secretStored &&
    smokeProviderEditState.statusText === null;
  await clickSmokeControl(page, '[data-testid="provider-add-openai"]');
  const openaiProviderName = 'Smoke UI OpenAI';
  await page.fill('[data-testid="provider-draft-name"]', openaiProviderName);
  await page.fill('[data-testid="provider-draft-endpoint"]', smokeProvider.endpoint);
  await setFirstModel(page, 'smoke-ui-openai-model', 'Smoke UI OpenAI Model');
  await clickSmokeControl(page, '[data-testid="provider-save"]');
  await page.waitForFunction(
    async (providerName) => {
      const result = await window.roc.settings.get();
      if (!result.ok) {
        return false;
      }
      const provider = result.data.providers.find((entry) => entry.name === providerName);
      const apiKeyInput = document.querySelector('[data-testid="provider-draft-api-key"]');
      return (
        provider !== undefined &&
        result.data.providerSecretStatus.find((entry) => entry.providerId === provider.id)?.stored === false &&
        apiKeyInput instanceof HTMLInputElement &&
        apiKeyInput.value === '' &&
        document.querySelector('[data-testid="provider-draft-status"]') === null
      );
    },
    openaiProviderName,
    { timeout: 5000 }
  );
  const openaiWithoutKeyState = await page.evaluate(async (providerName) => {
    const result = await window.roc.settings.get();
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    const provider = result.data.providers.find((entry) => entry.name === providerName);
    const apiKeyInput = document.querySelector('[data-testid="provider-draft-api-key"]');
    return {
      providerId: provider?.id ?? null,
      providerExists: provider !== undefined,
      secretStored:
        provider === undefined
          ? null
          : result.data.providerSecretStatus.find((entry) => entry.providerId === provider.id)?.stored === true,
      apiKeyValue: apiKeyInput instanceof HTMLInputElement ? apiKeyInput.value : null,
      statusText: document.querySelector('[data-testid="provider-draft-status"]')?.textContent ?? null
    };
  }, openaiProviderName);
  providerSettingsEvidence.createWithoutApiKeyAllowed =
    openaiWithoutKeyState.providerExists &&
    openaiWithoutKeyState.providerId === 'smoke-ui-openai' &&
    openaiWithoutKeyState.secretStored === false &&
    openaiWithoutKeyState.apiKeyValue === '' &&
    openaiWithoutKeyState.statusText === null;
  await page.fill('[data-testid="provider-draft-api-key"]', 'sk-smoke-ui-openai');
  await clickSmokeControl(page, '[data-testid="provider-save"]');
  await page.waitForFunction(
    async (providerName) => {
      const result = await window.roc.settings.get();
      if (!result.ok) {
        return false;
      }
      const provider = result.data.providers.find((entry) => entry.name === providerName);
      const apiKeyInput = document.querySelector('[data-testid="provider-draft-api-key"]');
      return (
        provider !== undefined &&
        result.data.providerSecretStatus.find((entry) => entry.providerId === provider.id)?.stored === true &&
        apiKeyInput instanceof HTMLInputElement &&
        apiKeyInput.value === ''
      );
    },
    openaiProviderName,
    { timeout: 5000 }
  );
  providerSettingsEvidence.openaiCreated = true;
  const openaiProviderState = await page.evaluate(async (providerName) => {
    const result = await window.roc.settings.get();
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    const provider = result.data.providers.find((entry) => entry.name === providerName);
    const apiKeyInput = document.querySelector('[data-testid="provider-draft-api-key"]');
    return {
      statusText: document.querySelector('[data-testid="provider-draft-status"]')?.textContent ?? null,
      providerIds: result.data.providers.map((entry) => `${entry.id}:${entry.name}`),
      providerId: provider?.id ?? null,
      secretStored:
        provider === undefined
          ? false
          : result.data.providerSecretStatus.find((entry) => entry.providerId === provider.id)?.stored === true,
      apiKeyValue: apiKeyInput instanceof HTMLInputElement ? apiKeyInput.value : null
    };
  }, openaiProviderName);
  if (openaiProviderState.providerId === null) {
    throw new Error(
      `missing provider for ${openaiProviderName}; status=${openaiProviderState.statusText}; providers=${openaiProviderState.providerIds.join(',')}`
    );
  }
  const openaiProviderId = openaiProviderState.providerId;
  providerSettingsEvidence.openaiSlugGenerated = openaiProviderId === 'smoke-ui-openai';
  providerSettingsEvidence.openaiSecretStored = openaiProviderState.secretStored;
  providerSettingsEvidence.openaiApiKeyCleared = openaiProviderState.apiKeyValue === '';
  await clickSmokeControl(page, '[data-testid="provider-add-openai"]');
  const chineseProviderName = '中文模型供应商';
  await page.fill('[data-testid="provider-draft-name"]', chineseProviderName);
  await page.fill('[data-testid="provider-draft-endpoint"]', smokeProvider.endpoint);
  await setFirstModel(page, 'zh-smoke-model', '中文模型');
  await clickSmokeControl(page, '[data-testid="provider-save"]');
  await page.waitForFunction(
    async (providerName) => {
      const result = await window.roc.settings.get();
      if (!result.ok) {
        return false;
      }
      const provider = result.data.providers.find((entry) => entry.name === providerName);
      return provider !== undefined && /^[A-Za-z0-9_-]+$/.test(provider.id) && provider.id.startsWith('provider-');
    },
    chineseProviderName,
    { timeout: 5000 }
  );
  const chineseProviderState = await page.evaluate(async (providerName) => {
    const result = await window.roc.settings.get();
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    const provider = result.data.providers.find((entry) => entry.name === providerName);
    return {
      providerId: provider?.id ?? null,
      providerName: provider?.name ?? null,
      providerIds: result.data.providers.map((entry) => `${entry.id}:${entry.name}`),
      statusText: document.querySelector('[data-testid="provider-draft-status"]')?.textContent ?? null,
      listText: document.querySelector('[data-testid="provider-list"]')?.textContent ?? ''
    };
  }, chineseProviderName);
  if (chineseProviderState.providerId === null) {
    throw new Error(
      `missing Chinese provider for ${chineseProviderName}; status=${chineseProviderState.statusText}; providers=${chineseProviderState.providerIds.join(',')}`
    );
  }
  const chineseProviderId = chineseProviderState.providerId;
  providerSettingsEvidence.chineseProviderAsciiId =
    /^[A-Za-z0-9_-]+$/.test(chineseProviderId) &&
    /^provider-[a-f0-9]{8}$/.test(chineseProviderId);
  await page.fill('[data-testid="provider-search"]', chineseProviderName);
  await page.waitForSelector(`[data-testid="provider-list-item-${chineseProviderId}"]`, { timeout: 5000 });
  providerSettingsEvidence.chineseProviderNameVisible =
    chineseProviderState.providerName === chineseProviderName &&
    chineseProviderState.listText.includes(chineseProviderName) &&
    ((await page.textContent(`[data-testid="provider-list-item-${chineseProviderId}"]`)) ?? '').includes(chineseProviderName);
  await page.fill('[data-testid="provider-search"]', '');
  await clickSmokeControl(page, `[data-testid="provider-list-item-${openaiProviderId}"]`);
  const providerDetailText = await page.textContent('[data-testid="provider-detail"]');
  providerSettingsEvidence.apiKeyHelpRemoved =
    providerDetailText !== null &&
    !providerDetailText.includes('Get your API key from') &&
    !providerDetailText.includes('OpenAI compatible chat completions endpoint') &&
    !providerDetailText.includes('Anthropic compatible /messages endpoint') &&
    !providerDetailText.includes('保存 Provider 后可录入 API Key。');
  await clickSmokeControl(page, `[data-testid="provider-list-item-${openaiProviderId}"]`);
  await page.waitForSelector('[data-testid="provider-draft-api-key"]', { timeout: 5000 });
  const providerDetailScrollEvidence = await page.evaluate(() => {
    const detail = document.querySelector('[data-testid="provider-detail"]');
    const providerSave = document.querySelector('[data-testid="provider-save"]');
    const apiKeyInput = document.querySelector('[data-testid="provider-draft-api-key"]');
    if (
      !(detail instanceof HTMLElement) ||
      !(providerSave instanceof HTMLElement) ||
      !(apiKeyInput instanceof HTMLElement)
    ) {
      return {
        exists: false,
        overflowY: null,
        hadOverflow: false,
        scrollMoved: false,
        providerSaveVisible: false,
        apiKeyVisible: false
      };
    }
    const before = detail.scrollTop;
    detail.scrollTop = detail.scrollHeight;
    const after = detail.scrollTop;
    const detailRect = detail.getBoundingClientRect();
    const providerSaveRect = providerSave.getBoundingClientRect();
    const apiKeyRect = apiKeyInput.getBoundingClientRect();
    const isVisibleWithinDetail = (rect) =>
      rect.top >= detailRect.top - 1 && rect.bottom <= detailRect.bottom + 1;
    return {
      exists: true,
      overflowY: window.getComputedStyle(detail).overflowY,
      hadOverflow: detail.scrollHeight > detail.clientHeight,
      scrollMoved: after > before,
      providerSaveVisible: isVisibleWithinDetail(providerSaveRect),
      apiKeyVisible: isVisibleWithinDetail(apiKeyRect)
    };
  });
  providerSettingsEvidence.detailScrollReachable =
    providerDetailScrollEvidence.exists &&
    providerDetailScrollEvidence.overflowY === 'auto' &&
    (!providerDetailScrollEvidence.hadOverflow || providerDetailScrollEvidence.scrollMoved) &&
    providerDetailScrollEvidence.providerSaveVisible &&
    providerDetailScrollEvidence.apiKeyVisible;
  await page.waitForSelector(`[data-testid="provider-secret-clear-${openaiProviderId}"]`, { timeout: 5000 });
  await page.fill('[data-testid="provider-draft-api-key"]', 'sk-smoke-ui-openai-rotated');
  await clickSmokeControl(page, '[data-testid="provider-save"]');
  await page.waitForFunction(
    async (providerId) => {
      const result = await window.roc.settings.get();
      if (!result.ok) {
        return false;
      }
      const apiKeyInput = document.querySelector('[data-testid="provider-draft-api-key"]');
      return (
        result.data.providerSecretStatus.find((entry) => entry.providerId === providerId)?.stored === true &&
        apiKeyInput instanceof HTMLInputElement &&
        apiKeyInput.value === ''
      );
    },
    openaiProviderId,
    { timeout: 5000 }
  );
  const openaiSecretUpdateState = await page.evaluate(async (providerId) => {
    const result = await window.roc.settings.get();
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    const apiKeyInput = document.querySelector('[data-testid="provider-draft-api-key"]');
    return {
      secretStored:
        result.data.providerSecretStatus.find((entry) => entry.providerId === providerId)?.stored === true,
      apiKeyValue: apiKeyInput instanceof HTMLInputElement ? apiKeyInput.value : null
    };
  }, openaiProviderId);
  providerSettingsEvidence.openaiSecretUpdated =
    openaiSecretUpdateState.secretStored && openaiSecretUpdateState.apiKeyValue === '';
  await clickSmokeControl(page, '[data-testid="provider-add-openai"]');
  await clickSmokeControl(page, '[data-testid="provider-draft-type-anthropic_compatible"]');
  const anthropicProviderName = 'Smoke UI Anthropic';
  await page.fill('[data-testid="provider-draft-name"]', anthropicProviderName);
  await page.fill('[data-testid="provider-draft-api-key"]', 'sk-smoke-ui-anthropic');
  await page.fill('[data-testid="provider-draft-endpoint"]', smokeProvider.endpoint);
  await setFirstModel(page, 'smoke-ui-anthropic-model', 'Smoke UI Anthropic Model');
  await clickSmokeControl(page, '[data-testid="provider-save"]');
  await page.waitForFunction(
    async (providerName) => {
      const result = await window.roc.settings.get();
      if (!result.ok) {
        return false;
      }
      const provider = result.data.providers.find((entry) => entry.name === providerName);
      const apiKeyInput = document.querySelector('[data-testid="provider-draft-api-key"]');
      return (
        provider !== undefined &&
        result.data.providerSecretStatus.find((entry) => entry.providerId === provider.id)?.stored === true &&
        apiKeyInput instanceof HTMLInputElement &&
        apiKeyInput.value === ''
      );
    },
    anthropicProviderName,
    { timeout: 5000 }
  );
  providerSettingsEvidence.anthropicCreated = true;
  const anthropicProviderState = await page.evaluate(async (providerName) => {
    const result = await window.roc.settings.get();
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    const provider = result.data.providers.find((entry) => entry.name === providerName);
    return {
      statusText: document.querySelector('[data-testid="provider-draft-status"]')?.textContent ?? null,
      providerIds: result.data.providers.map((entry) => `${entry.id}:${entry.name}`),
      providerId: provider?.id ?? null,
      secretStored:
        provider === undefined
          ? false
          : result.data.providerSecretStatus.find((entry) => entry.providerId === provider.id)?.stored === true
    };
  }, anthropicProviderName);
  if (anthropicProviderState.providerId === null) {
    throw new Error(
      `missing provider for ${anthropicProviderName}; status=${anthropicProviderState.statusText}; providers=${anthropicProviderState.providerIds.join(',')}`
    );
  }
  const anthropicProviderId = anthropicProviderState.providerId;
  providerSettingsEvidence.anthropicSlugGenerated = anthropicProviderId === 'smoke-ui-anthropic';
  providerSettingsEvidence.anthropicSecretStored = anthropicProviderState.secretStored;
  await clickSmokeControl(page, `[data-testid="provider-list-item-${anthropicProviderId}"]`);
  await page.waitForSelector(`[data-testid="provider-secret-clear-${anthropicProviderId}"]`, { timeout: 5000 });
  await clickSmokeControl(page, `[data-testid="provider-secret-clear-${anthropicProviderId}"]`);
  await page.waitForSelector(`[data-testid="provider-secret-clear-${anthropicProviderId}"]`, {
    state: 'detached',
    timeout: 5000
  });
  const anthropicSecretClearState = await page.evaluate(async (providerId) => {
    const result = await window.roc.settings.get();
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return result.data.providerSecretStatus.find((entry) => entry.providerId === providerId)?.stored === true;
  }, anthropicProviderId);
  providerSettingsEvidence.anthropicSecretCleared = anthropicSecretClearState === false;
  await page.fill('[data-testid="provider-search"]', openaiProviderName);
  await page.waitForSelector(`[data-testid="provider-list-item-${openaiProviderId}"]`, { timeout: 5000 });
  await page.fill('[data-testid="provider-search"]', openaiProviderId);
  await page.waitForSelector(`[data-testid="provider-list-item-${openaiProviderId}"]`, { timeout: 5000 });
  await page.fill('[data-testid="provider-search"]', '');
  providerSettingsEvidence.searchMatchesNameAndId = true;
  await clickSmokeControl(page, `[data-testid="provider-list-item-${openaiProviderId}"]`);
  await clickSmokeControl(page, `[data-testid="provider-test-${openaiProviderId}"]`);
  await waitForTextContent(page, '[data-testid="provider-detail-status"]', 'Active');
  await waitForTextContent(page, '[data-testid="provider-test-feedback"]', '已测试 smoke-ui-openai-model 可用。');
  providerSettingsEvidence.openaiReady = true;
  providerSettingsEvidence.providerTestFeedbackVisible =
    ((await page.textContent('[data-testid="provider-test-feedback"]')) ?? '').includes(
      '已测试 smoke-ui-openai-model 可用。'
    );
  await clickSmokeControl(page, '[data-testid="settings-section-default-model"]');
  await page.waitForSelector(`[data-testid="default-model-${openaiProviderId}-smoke-ui-openai-model"]`, { timeout: 5000 });
  await clickSmokeControl(page, `[data-testid="default-model-${openaiProviderId}-smoke-ui-openai-model"]`);
  await waitForTextContent(page, '[data-testid="default-model-settings"]', 'smoke-ui-openai-model');
  providerSettingsEvidence.defaultModelSelectable = true;
  await clickSmokeControl(page, '[data-testid="settings-section-app-basics"]');
  await page.waitForSelector('[data-testid="settings-panel-app-basics"]', { timeout: 5000 });
  const openAtLoginBeforeSaveAll = await page.locator('[data-testid="settings-startup-open-at-login"]').isChecked();
  await clickSmokeControl(page, '[data-testid="settings-startup-open-at-login"]');
  await waitForTextContent(page, '[data-testid="settings-dirty-count"]', '未保存 1 项');
  await clickSmokeControl(page, '[data-testid="settings-save-all"]');
  await page.waitForSelector('[data-testid="impact-preview-modal"]', { state: 'detached', timeout: 5000 });
  await waitForTextContent(page, '[data-testid="settings-dirty-count"]', '无未保存变更');
  const hostIntegrationAfterSaveAll = await page.evaluate(async () => {
    const result = await window.roc.settings.get();
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return {
      openAtLogin: result.data.settings.startup.openAtLogin,
      hostIntegration: result.data.hostIntegration
    };
  });
  providerSettingsEvidence.saveAllDirect = hostIntegrationAfterSaveAll.openAtLogin === !openAtLoginBeforeSaveAll;
  providerSettingsEvidence.hostIntegrationReturned =
    hostIntegrationAfterSaveAll.hostIntegration?.startup?.configuredOpenAtLogin === hostIntegrationAfterSaveAll.openAtLogin &&
    typeof hostIntegrationAfterSaveAll.hostIntegration?.startup?.effectiveOpenAtLogin === 'boolean' &&
    typeof hostIntegrationAfterSaveAll.hostIntegration?.globalHotkey?.registered === 'boolean';
  await page.evaluate(async ({ providerId, contextBudgetTokens }) => {
    const current = await window.roc.settings.get();
    if (!current.ok) {
      throw new Error(current.error.message);
    }
    const saved = await window.roc.settings.save({
      settings: current.data.settings,
      permissions: current.data.permissions,
      providers: current.data.providers.map((provider) =>
        provider.id === providerId
          ? {
              ...provider,
              models: provider.models.map((model, index) =>
                index === 0 ? { ...model, options: { ...model.options, contextBudgetTokens } } : model
              )
            }
          : provider
      ),
      defaultModelId: current.data.defaultModelId
    });
    if (!saved.ok) {
      throw new Error(saved.error.message);
    }
    const refreshed = await window.roc.settings.get();
    if (!refreshed.ok) {
      throw new Error(refreshed.error.message);
    }
    const persisted = refreshed.data.providers.find((provider) => provider.id === providerId);
    if (persisted?.models[0]?.options?.contextBudgetTokens !== contextBudgetTokens) {
      throw new Error('smoke_provider_context_budget_not_persisted');
    }
  }, { providerId: openaiProviderId, contextBudgetTokens: 128_000 });
  const appBasicsText = await page.textContent('[data-testid="settings-panel-app-basics"]');
  providerSettingsEvidence.hostIntegrationStatusVisible =
    appBasicsText !== null && appBasicsText.includes('系统实际状态');
  await clickSmokeControl(page, '[data-testid="settings-section-providers"]');
  await waitForTextContent(page, '[data-testid="provider-detail-status"]', 'Active');
  const settingsText = await page.textContent('[data-testid="settings-view"]');
  if (settingsText === null) {
    throw new Error('Smoke could not read settings view text.');
  }
  await page.click('[data-testid="settings-modal-close"]');
  await page.waitForSelector('[data-testid="settings-modal"]', { state: 'detached', timeout: 5000 });

  Object.assign(ctx, {
    providerSettingsEvidence,
    settingsText
  });
}

async function setFirstModel(page, id, displayName) {
  const modelId = page.locator('[data-testid="provider-model-id-0"]');
  if ((await modelId.count()) === 0) {
    await clickSmokeControl(page, '[data-testid="provider-model-add"]');
  }
  await page.fill('[data-testid="provider-model-id-0"]', id);
  await page.fill('[data-testid="provider-model-name-0"]', displayName);
}
