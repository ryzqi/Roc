import { existsSync } from 'node:fs';
import { waitForCapabilitySelection, waitForTextContent } from './assertions.mjs';
import { redactSmokeProviderRequest } from './electron-smoke-time.mjs';
import { buildNativeFeelSummary, summarizeProcessMetrics } from './native-feel.mjs';
import { clickComposerPopoverChoice, clickSmokeControl, openChatView } from './ui-actions.mjs';

export async function runSmokeChatDiagnosticsChecks(ctx) {
  const { page, smokeProvider, providerSettingsEvidence, smokeTarget, packagedExe } = ctx;
  await openChatView(page);
  await page.hover('[data-testid="chat-tool-trigger"]');
  await page.waitForSelector('[data-testid="turn-mcp-smoke-mcp"]', { timeout: 5000 });
  await page.hover('[data-testid="chat-skill-trigger"]');
  await page.waitForSelector('[data-testid="turn-skill-smoke-skill"]', { timeout: 5000 });
  await page.hover('[data-testid="chat-tool-trigger"]');
  await clickSmokeControl(page, '[data-testid="chat-tool-clear-all"]');
  await page.hover('[data-testid="chat-skill-trigger"]');
  await clickSmokeControl(page, '[data-testid="chat-skill-clear-all"]');
  await waitForCapabilitySelection(page, { mcpCount: 0, skillCount: 0 });
  await clickComposerPopoverChoice(page, '[data-testid="chat-tool-trigger"]', '[data-testid="turn-mcp-smoke-mcp"]');
  await clickComposerPopoverChoice(page, '[data-testid="chat-skill-trigger"]', '[data-testid="turn-skill-smoke-skill"]');
  await waitForCapabilitySelection(page, {
    expectedMcpIds: ['smoke-mcp'],
    expectedSkillIds: ['smoke-skill'],
    mcpCount: 1,
    skillCount: 1
  });
  await clickComposerPopoverChoice(page, '[data-testid="chat-tool-trigger"]', '[data-testid="turn-mcp-smoke-mcp"]');
  await clickComposerPopoverChoice(page, '[data-testid="chat-skill-trigger"]', '[data-testid="turn-skill-smoke-skill"]');
  await waitForCapabilitySelection(page, { mcpCount: 0, skillCount: 0 });
  await clickComposerPopoverChoice(page, '[data-testid="chat-tool-trigger"]', '[data-testid="turn-mcp-smoke-mcp"]');
  await clickComposerPopoverChoice(page, '[data-testid="chat-skill-trigger"]', '[data-testid="turn-skill-smoke-skill"]');
  const chatCapabilityEvidence = await waitForCapabilitySelection(page, {
    expectedMcpIds: ['smoke-mcp'],
    expectedSkillIds: ['smoke-skill'],
    mcpCount: 1,
    skillCount: 1
  });
  const agentCapabilityPreviewHidden = await page.evaluate(
    () =>
      document.querySelector('[data-testid="agent-capability-preview"]') === null &&
      document.querySelector('[data-testid="agent-tool-cards"]') === null &&
      document.querySelector('[data-testid="agent-subagents"]') === null
  );
  const agentPreviewApiEvidence = await page.evaluate(async () => {
    const preview = await window.roc.agent.getCapabilityPreview({
      mcpServers: ['smoke-mcp', 'missing-mcp'],
      skills: ['smoke-skill'],
      mode: 'chat'
    });
    if (!preview.ok) {
      throw new Error(preview.error.message);
    }
    if (
      !preview.data.toolCards.some((card) => card.id === 'builtin:delete_file') ||
      !preview.data.toolCards.some((card) => card.id === 'builtin:run_shell_command')
    ) {
      throw new Error('agent_capability_preview_chat_mode_surface_missing');
    }
    return {
      selected: preview.data.selectedCapabilities,
      skipped: preview.data.skippedCapabilities,
      cards: preview.data.toolCards.map((card) => card.id),
      skills: preview.data.skillCards.map((card) => card.id),
      subagents: preview.data.subagents.map((subagent) => ({
        id: subagent.id,
        skills: subagent.skills,
        tools: subagent.tools
      })),
      policy: preview.data.untrustedContextPolicy
    };
  });
  const typedChatPrompt = `Smoke typed user prompt ${Date.now()}`;
  const typedChatPromptSecondLine = 'Smoke Shift+Enter second line';
  const submittedChatPrompt = `${typedChatPrompt}\n${typedChatPromptSecondLine}`;
  await page.waitForSelector('[data-testid="chat-input"]', { timeout: 5000 });
  await page.locator('body').hover({ position: { x: 8, y: 8 } });
  await page.fill('[data-testid="chat-input"]', '');
  await page.focus('[data-testid="chat-input"]');
  await page.keyboard.type(typedChatPrompt);
  await page.keyboard.down('Shift');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Shift');
  await page.keyboard.type(typedChatPromptSecondLine);
  const chatInputEvidence = await page.evaluate(() => {
    const input = document.querySelector('[data-testid="chat-input"]');
    const sendButton = document.querySelector('[data-testid="chat-task-submit"]');
    if (!(input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement)) {
      return {
        exists: input !== null,
        editable: false,
        visuallyFramed: false,
        sendButtonVisibleInViewport: false,
        bottomExplanationsAbsent: false,
        inputSettledAtBottom: false,
        resultAboveInput: false,
        value: ''
      };
    }
    const style = getComputedStyle(input);
    const rect = input.getBoundingClientRect();
    const viewport = {
      width: window.innerWidth,
      height: window.innerHeight
    };
    const visibleInViewport =
      rect.width > 0 &&
      rect.height > 0 &&
      rect.top >= 0 &&
      rect.left >= 0 &&
        rect.bottom <= viewport.height &&
        rect.right <= viewport.width;
    const sendButtonRect = sendButton instanceof HTMLElement ? sendButton.getBoundingClientRect() : null;
    const composer = input.closest('.composer');
    const composerRect = composer instanceof HTMLElement ? composer.getBoundingClientRect() : null;
    const composerStyle = composer instanceof HTMLElement ? getComputedStyle(composer) : null;
    const chatView = document.querySelector('[data-testid="chat-view"]');
    const chatViewRect = chatView instanceof HTMLElement ? chatView.getBoundingClientRect() : null;
    const bottomStack = document.querySelector('.chat-bottom-stack');
    const bottomStackChildren = bottomStack instanceof HTMLElement ? Array.from(bottomStack.children) : [];
    const bottomExplanationsAbsent =
      document.querySelector('[data-testid="turn-capabilities"]') === null &&
      bottomStackChildren.length === 1 &&
      bottomStackChildren[0] === composer;
    const sendButtonVisibleInViewport =
      sendButton instanceof HTMLButtonElement &&
      !sendButton.disabled &&
      sendButtonRect !== null &&
      sendButtonRect.width > 0 &&
      sendButtonRect.height > 0 &&
      sendButtonRect.top >= 0 &&
      sendButtonRect.left >= 0 &&
      sendButtonRect.bottom <= viewport.height &&
      sendButtonRect.right <= viewport.width;
    const visuallyFramed =
      rect.width >= 220 &&
      rect.height > 56 &&
      visibleInViewport &&
      style.visibility === 'visible' &&
      style.opacity !== '0' &&
      composer instanceof HTMLElement &&
      composerStyle !== null &&
      composerStyle.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
      !composerStyle.borderTop.startsWith('0px none');
    return {
      exists: true,
      editable: !input.disabled && !input.readOnly,
      visuallyFramed,
      rect: {
        width: rect.width,
        height: rect.height,
        top: rect.top,
        bottom: rect.bottom
      },
      viewport,
      visibleInViewport,
      sendButtonVisibleInViewport,
      backgroundColor: style.backgroundColor,
      borderTop: style.borderTop,
      composerBackgroundColor: composerStyle?.backgroundColor ?? null,
      composerBorderTop: composerStyle?.borderTop ?? null,
      bottomExplanationsAbsent,
      composerBottomGapToViewport: composerRect === null ? null : Math.round(viewport.height - composerRect.bottom),
      inputSettledAtBottom:
        composerRect !== null &&
        chatViewRect !== null &&
        composerRect.bottom <= chatViewRect.bottom &&
        chatViewRect.bottom - composerRect.bottom <= 4 &&
        viewport.height - composerRect.bottom <= 10,
      transcriptMountedBeforeSubmit: document.querySelector('[data-testid="chat-transcript"]') !== null,
      resultAboveInput: true,
      value: input.value
    };
  });
  await page.keyboard.press('Enter');
  try {
    await waitForTextContent(page, '[data-testid="chat-transcript"]', 'Smoke Provider 已生成首轮回复。', 15000);
  } catch (error) {
    const chatTimeoutDebug = await page.evaluate(async () => {
      const snapshot = await window.roc.tasks.getSnapshot();
      const settings = await window.roc.settings.get();
      return {
        chatText: document.querySelector('[data-testid="chat-transcript"]')?.textContent ?? null,
        inputValue: document.querySelector('[data-testid="chat-input"]')?.value ?? null,
        settingsOk: settings.ok,
        defaultModelId: settings.ok ? settings.data.defaultModelId : null,
        snapshotOk: snapshot.ok,
        recentEvents: snapshot.ok
          ? snapshot.data.recentEvents.slice(-12).map((event) => ({
              type: event.type,
              payload: event.payload
            }))
          : []
      };
    });
    console.error(
      JSON.stringify(
        {
          chatResponseTimeout: true,
          chatTimeoutDebug,
          smokeProviderRequestCount: smokeProvider.requests.length,
          lastSmokeProviderRequest: redactSmokeProviderRequest(smokeProvider.requests.at(-1) ?? null)
        },
        null,
        2
      )
    );
    throw error;
  }
  await page.waitForFunction(
    () => {
      const input = document.querySelector('[data-testid="chat-input"]');
      const latestUser = Array.from(document.querySelectorAll('[data-testid="chat-message-user"]')).at(-1);
      const latestAssistant = Array.from(document.querySelectorAll('[data-testid="chat-message-assistant"]')).at(-1);
      if (!(input instanceof HTMLElement) || !(latestUser instanceof HTMLElement) || !(latestAssistant instanceof HTMLElement)) {
        return false;
      }
      const inputRect = input.getBoundingClientRect();
      return latestUser.getBoundingClientRect().bottom <= inputRect.top &&
        latestAssistant.getBoundingClientRect().bottom <= inputRect.top;
    },
    undefined,
    { timeout: 5000 }
  );
  const chatResultText = await page.textContent('[data-testid="chat-transcript"]');
  if (chatResultText === null) {
    throw new Error('Smoke could not read chat result text.');
  }
  const normalizeChatText = (value) => value.replace(/\s+/gu, ' ').trim();
  const chatResultTextNormalized = normalizeChatText(chatResultText);
  const submittedChatPromptNormalized = normalizeChatText(submittedChatPrompt);
  const chatResultTextEvidence = {
    hasProviderResponse: chatResultText.includes('Smoke Provider 已生成首轮回复。'),
    hasSubmittedPromptExact: chatResultText.includes(submittedChatPrompt),
    hasSubmittedPromptNormalized: chatResultTextNormalized.includes(submittedChatPromptNormalized),
    submittedChatPrompt,
    submittedChatPromptNormalized,
    chatResultTextPreview: chatResultText.slice(0, 500),
    chatResultTextNormalizedPreview: chatResultTextNormalized.slice(0, 500)
  };
  providerSettingsEvidence.openaiRotatedSecretUsed = smokeProvider.requests.some(
    (request) => request.authorization === 'Bearer sk-smoke-ui-openai-rotated'
  );
  const chatResultLayoutEvidence = await page.evaluate(() => {
    const input = document.querySelector('[data-testid="chat-input"]');
    const userMessages = Array.from(document.querySelectorAll('[data-testid="chat-message-user"]'));
    const assistantMessages = Array.from(document.querySelectorAll('[data-testid="chat-message-assistant"]'));
    const latestUser = userMessages.at(-1);
    const latestAssistant = assistantMessages.at(-1);
    if (!(input instanceof HTMLElement) || !(latestUser instanceof HTMLElement) || !(latestAssistant instanceof HTMLElement)) {
      return {
        resultAboveInput: false,
        userAlignedRight: false,
        assistantAlignedLeft: false,
        assistantBubbleUnframed: false,
        assistantContentAnchoredLeft: false,
        assistantBubbleFitsContent: false,
        assistantBubbleNarrowerThanRow: false,
        userMessageUserSelect: null,
        assistantMessageUserSelect: null,
        inputUserSelect: null
      };
    }
    const inputRect = input.getBoundingClientRect();
    const userRect = latestUser.getBoundingClientRect();
    const assistantRect = latestAssistant.getBoundingClientRect();
    const assistantBubble = latestAssistant.querySelector('.chat-bubble--assistant');
    const assistantContent = latestAssistant.querySelector('[data-testid="chat-assistant-content"]');
    const assistantBubbleStyle =
      assistantBubble instanceof HTMLElement ? window.getComputedStyle(assistantBubble) : null;
    const assistantBubbleRect = assistantBubble instanceof HTMLElement ? assistantBubble.getBoundingClientRect() : null;
    const assistantContentRect = assistantContent instanceof HTMLElement ? assistantContent.getBoundingClientRect() : null;
    const composer = input.closest('.composer');
    const composerRect = composer instanceof HTMLElement ? composer.getBoundingClientRect() : null;
    const bottomStack = document.querySelector('.chat-bottom-stack');
    const bottomStackRect = bottomStack instanceof HTMLElement ? bottomStack.getBoundingClientRect() : null;
    const chatView = document.querySelector('[data-testid="chat-view"]');
    const chatViewRect = chatView instanceof HTMLElement ? chatView.getBoundingClientRect() : null;
    const scrollPlane = document.querySelector('.chat-empty-plane');
    const scrollPlaneRect = scrollPlane instanceof HTMLElement ? scrollPlane.getBoundingClientRect() : null;
    const toRoundedRect = (rect) =>
      rect === null
        ? null
        : {
            top: Math.round(rect.top),
            bottom: Math.round(rect.bottom),
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          };
    return {
      resultAboveInput: userRect.bottom <= inputRect.top && assistantRect.bottom <= inputRect.top,
      userAlignedRight: window.getComputedStyle(latestUser).justifyContent === 'flex-end',
      assistantAlignedLeft: window.getComputedStyle(latestAssistant).justifyContent === 'flex-start',
      assistantBubbleUnframed:
        assistantBubbleStyle !== null &&
        assistantBubbleStyle.backgroundColor === 'rgba(0, 0, 0, 0)' &&
        assistantBubbleStyle.borderTopWidth === '0px' &&
        assistantBubbleStyle.boxShadow === 'none',
      assistantContentAnchoredLeft:
        assistantContentRect !== null && Math.abs(assistantContentRect.left - assistantRect.left) <= 4,
      assistantBubbleFitsContent:
        assistantBubbleRect !== null &&
        assistantContentRect !== null &&
        Math.abs(assistantBubbleRect.width - assistantContentRect.width) <= 4,
      assistantBubbleNarrowerThanRow:
        assistantBubbleRect !== null && assistantBubbleRect.width <= assistantRect.width - 24,
      assistantGapToComposer:
        composerRect !== null ? Math.round(composerRect.top - assistantRect.bottom) : null,
      assistantGapToBottomStack:
        bottomStackRect !== null ? Math.round(bottomStackRect.top - assistantRect.bottom) : null,
      rects: {
        chatView: toRoundedRect(chatViewRect),
        scrollPlane: toRoundedRect(scrollPlaneRect),
        bottomStack: toRoundedRect(bottomStackRect),
        composer: toRoundedRect(composerRect),
        input: toRoundedRect(inputRect),
        latestUser: toRoundedRect(userRect),
        latestAssistant: toRoundedRect(assistantRect),
        assistantBubble: toRoundedRect(assistantBubbleRect),
        assistantContent: toRoundedRect(assistantContentRect)
      },
      userMessageUserSelect: window.getComputedStyle(latestUser).userSelect,
      assistantMessageUserSelect: window.getComputedStyle(latestAssistant).userSelect,
      inputUserSelect: window.getComputedStyle(input).userSelect
    };
  });
  const taskCapabilityEvidence = await page.evaluate(async (expectedInput) => {
    const snapshot = await window.roc.tasks.getSnapshot();
    if (!snapshot.ok) {
      throw new Error(snapshot.error.message);
    }
    const userMessage = snapshot.data.recentEvents.find(
      (item) =>
        item.type === 'message' &&
        typeof item.payload === 'object' &&
        item.payload !== null &&
        item.payload.role === 'user' &&
        item.payload.content === expectedInput
    );
    if (userMessage === undefined) {
      throw new Error(`No task user message event found for typed prompt: ${expectedInput}`);
    }
    const assistantMessage = snapshot.data.recentEvents.find(
      (item) =>
        item.type === 'message' &&
        typeof item.payload === 'object' &&
        item.payload !== null &&
        item.payload.role === 'assistant'
    );
    if (assistantMessage === undefined) {
      throw new Error('No task assistant message event found after chat submit.');
    }
    const manifest = snapshot.data.recentEvents.find((item) => item.type === 'context_manifest');
    if (manifest === undefined) {
      throw new Error('No context_manifest event found after chat submit.');
    }
    const providerUpdate = snapshot.data.recentEvents.find(
      (item) =>
        item.type === 'agent_update' &&
        typeof item.payload === 'object' &&
        item.payload !== null &&
        Reflect.get(item.payload, 'finishReason') === 'stop'
    );
    if (providerUpdate === undefined) {
      throw new Error('No provider agent_update event found after chat submit.');
    }
    const skillLoaded = snapshot.data.recentEvents.find((item) => item.type === 'skill_loaded');
    const thread = snapshot.data.threads.find((item) => item.id === userMessage.threadId);
    if (thread === undefined) {
      throw new Error(`No task thread found for typed prompt: ${expectedInput}`);
    }
    return {
      expectedInput,
      threadTitle: thread.title,
      threadGoal: thread.goal,
      userMessage: userMessage.payload,
      assistantMessage: assistantMessage.payload,
      providerUpdate: providerUpdate.payload,
      manifest: manifest.payload,
      skillLoaded: skillLoaded?.payload ?? null
    };
  }, submittedChatPrompt);
  const historySidebarEvidence = await page.evaluate((expectedTitle) => {
    const historyList = document.querySelector('.history-list');
    const text = historyList?.textContent ?? '';
    return {
      exists: historyList !== null,
      text,
      hasExpectedThreadTitle: text.includes(expectedTitle),
      hasCurrentSessionLabel: text.includes('当前主会话'),
      hasMemoryRecordLabel: text.includes('记忆整理裁决'),
      hasTaskRecordLabel: text.includes('任务工作台记录')
    };
  }, taskCapabilityEvidence.threadTitle);
  await page.click('[data-testid="nav-diagnostics"]');
  await page.waitForSelector('[data-testid="diagnostics-view"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="diagnostic-package-status"]', { timeout: 5000 });
  await page.waitForSelector('[data-testid="performance-sample"]', { timeout: 5000 });
  await waitForTextContent(page, '[data-testid="diagnostics-view"]', 'task_snapshot');
  const diagnosticsText = await page.textContent('[data-testid="diagnostics-view"]');
  if (diagnosticsText === null) {
    throw new Error('Smoke could not read diagnostics view text.');
  }
  const phase6ApiEvidence = await page.evaluate(async () => {
    const sample = await window.roc.diagnostics.samplePerformance({
      mode: 'smoke',
      memoryBudgetMb: 300
    });
    const tray = await window.roc.lifecycle.getTraySummary();
    if (!sample.ok) {
      throw new Error(sample.error.message);
    }
    if (!tray.ok) {
      throw new Error(tray.error.message);
    }
    return {
      sample: sample.data,
      tray: tray.data
    };
  });
  const nativeModuleProbe = {
    betterSqlite3: {
      status: 'loaded',
      evidence: 'database-backed diagnostics sample completed',
      sampleId: phase6ApiEvidence.sample.id
    }
  };
  const processMetricsSummary = summarizeProcessMetrics(phase6ApiEvidence.sample);
  const ipcSummary = phase6ApiEvidence.sample.ipc;
  const diagnosticNativeConfirmIpcSamples = phase6ApiEvidence.sample.timing.samples.filter(
    (sample) =>
      sample.phase === 'ipc_call' &&
      sample.label === 'roc:shell:confirm' &&
      sample.metadata?.channel === 'roc:shell:confirm' &&
      sample.metadata?.ok === true
  );
  const nativeConfirmIpcSamples = [
    ...(Array.isArray(ctx.workbenchNativeConfirmIpcSamples) ? ctx.workbenchNativeConfirmIpcSamples : []),
    ...diagnosticNativeConfirmIpcSamples
  ];
  const nativeFeel = buildNativeFeelSummary({
    sample: phase6ApiEvidence.sample,
    smokeTarget: {
      kind: smokeTarget.kind,
      path: smokeTarget.path,
      packagedExeExists: existsSync(packagedExe)
    },
    rendererReadyMs: null,
    mainInputReadyMs: null,
    nativeModuleProbe
  });


  Object.assign(ctx, {
    chatCapabilityEvidence,
    agentCapabilityPreviewHidden,
    agentPreviewApiEvidence,
    submittedChatPrompt,
    chatInputEvidence,
    chatResultText,
    chatResultTextEvidence,
    chatResultLayoutEvidence,
    taskCapabilityEvidence,
    historySidebarEvidence,
    diagnosticsText,
    phase6ApiEvidence,
    nativeModuleProbe,
    processMetricsSummary,
    ipcSummary,
    nativeConfirmIpcSamples,
    nativeFeel
  });
}
