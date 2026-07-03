export function buildRendererBoundaryCapabilities(ctx) {
  const { memoryText, memoryStatusApiEvidence, providerSettingsEvidence, mcpText, skillText, disabledSkillText, skillLayoutEvidence, boundary, workspaceSelectButtonEvidence, sidebarSettingsReachable, chatCapabilityEvidence, collapsedChatLayoutBeforeOpen, collapsedChatLayoutAfterClose, chatInputEvidence, submittedChatPrompt, agentCapabilityPreviewHidden, agentPreviewApiEvidence, chatResultTextEvidence, chatResultLayoutEvidence, taskCapabilityEvidence, historySidebarEvidence, buttonInteractionEvidence, appShellFrameEvidence, materialEvidence, windowPlacementEvidence, phase3WebViewEvidence, phase4VisualEvidence, windowDragEvidence } = ctx;
  return {
    memoryFileEditorVisible:
      memoryText.includes('USER.md') &&
      memoryText.includes('会话回顾') &&
      memoryText.includes('系统快照') &&
      memoryStatusApiEvidence.fullTextIndex.status === 'ready',
    providerConfiguredVisible:
      providerSettingsEvidence.nvidiaListed &&
      providerSettingsEvidence.nvidiaFixedDetail &&
      providerSettingsEvidence.nvidiaDefaultModelChoicesVisible &&
      providerSettingsEvidence.llamaCppListed &&
      providerSettingsEvidence.llamaCppFixedDetail &&
      providerSettingsEvidence.llamaCppDefaultModelChoicesVisible &&
      providerSettingsEvidence.smokeProviderListed &&
      providerSettingsEvidence.addProviderEntryVisible &&
      providerSettingsEvidence.headerChromeRemoved &&
      providerSettingsEvidence.apiKeyHelpRemoved &&
      providerSettingsEvidence.createWithoutApiKeyAllowed &&
      providerSettingsEvidence.editWithoutApiKeyAllowed &&
      providerSettingsEvidence.detailScrollReachable &&
      providerSettingsEvidence.searchMatchesNameAndId &&
      providerSettingsEvidence.openaiSlugGenerated &&
      providerSettingsEvidence.openaiCreated &&
      providerSettingsEvidence.openaiSecretStored &&
      providerSettingsEvidence.openaiApiKeyCleared &&
      providerSettingsEvidence.openaiSecretUpdated &&
      providerSettingsEvidence.openaiRotatedSecretUsed &&
      providerSettingsEvidence.anthropicSlugGenerated &&
      providerSettingsEvidence.anthropicCreated &&
      providerSettingsEvidence.anthropicSecretStored &&
      providerSettingsEvidence.anthropicSecretCleared &&
      providerSettingsEvidence.chineseProviderNameVisible &&
      providerSettingsEvidence.chineseProviderAsciiId &&
      providerSettingsEvidence.openaiReady &&
      providerSettingsEvidence.defaultModelSelectable &&
      providerSettingsEvidence.providerTestFeedbackVisible &&
      providerSettingsEvidence.saveAllDirect &&
      providerSettingsEvidence.hostIntegrationReturned &&
      providerSettingsEvidence.hostIntegrationStatusVisible,
    mcpManagedVisible:
      mcpText.includes('Smoke MCP') &&
      mcpText.includes('smoke-mcp:ready') &&
      mcpText.includes('enabled'),
    skillManagedVisible:
      skillText.includes('smoke-skill') &&
      skillText.includes('ready') &&
      (disabledSkillText ?? '').includes('disabled'),
    skillLayoutCompact:
      skillLayoutEvidence.exists &&
      skillLayoutEvidence.filterStripHeight !== null &&
      skillLayoutEvidence.filterStripHeight <= 72 &&
      skillLayoutEvidence.chipMaxHeight !== null &&
      skillLayoutEvidence.chipMaxHeight <= 56 &&
      skillLayoutEvidence.gapToRowList !== null &&
      skillLayoutEvidence.gapToRowList <= 64,
    providerActionsVisible: providerSettingsEvidence.providerActionsVisible,
    capabilityActionsVisible:
      mcpText.includes('测试') &&
      mcpText.includes('禁用') &&
      mcpText.includes('删除'),
    floatingEntryApiRemoved:
      boundary.appKeys.includes('openMainPage') &&
      !boundary.appKeys.includes('openQuickEntry') &&
      !boundary.appKeys.includes('openTrayEntry') &&
      boundary.appKeys.includes('onNavigate'),
    windowSetBoundsRemoved: !boundary.windowKeys.includes('setBounds'),
    workspaceSelectButtonVisible:
      workspaceSelectButtonEvidence.exists &&
      workspaceSelectButtonEvidence.clickable &&
      workspaceSelectButtonEvidence.visibleInViewport &&
      workspaceSelectButtonEvidence.text.includes('选择'),
    sidebarScrollableToSettings: sidebarSettingsReachable,
    workspaceDialogApiExposed: boundary.workspaceKeys.includes('selectFromDialog'),
    chatCapabilitySelectionVisible:
      chatCapabilityEvidence.toolTriggerClass.includes('active') &&
      chatCapabilityEvidence.skillTriggerClass.includes('active') &&
      chatCapabilityEvidence.mcpActiveIds.includes('smoke-mcp') &&
      chatCapabilityEvidence.skillActiveIds.includes('smoke-skill'),
    chatCollapsedRailLayoutVisible:
      collapsedChatLayoutBeforeOpen.shellExists &&
      collapsedChatLayoutBeforeOpen.railExists &&
      collapsedChatLayoutBeforeOpen.composerExists &&
      collapsedChatLayoutBeforeOpen.workbenchVisible === false &&
      collapsedChatLayoutBeforeOpen.shellClassName?.includes('workspace-shell--chat-collapsed') === true &&
      typeof collapsedChatLayoutBeforeOpen.railGapToShellRight === 'number' &&
      collapsedChatLayoutBeforeOpen.railGapToShellRight <= 12 &&
      typeof collapsedChatLayoutBeforeOpen.composerWidthRatio === 'number' &&
      collapsedChatLayoutBeforeOpen.composerWidthRatio >= 0.42 &&
      collapsedChatLayoutAfterClose.shellExists &&
      collapsedChatLayoutAfterClose.railExists &&
      collapsedChatLayoutAfterClose.composerExists &&
      collapsedChatLayoutAfterClose.workbenchVisible === false &&
      collapsedChatLayoutAfterClose.shellClassName?.includes('workspace-shell--chat-collapsed') === true &&
      typeof collapsedChatLayoutAfterClose.railGapToShellRight === 'number' &&
      collapsedChatLayoutAfterClose.railGapToShellRight <= 12 &&
      typeof collapsedChatLayoutAfterClose.composerWidthRatio === 'number' &&
      collapsedChatLayoutAfterClose.composerWidthRatio >= 0.42,
    chatInputEditable:
      chatInputEvidence.exists &&
      chatInputEvidence.editable &&
      chatInputEvidence.transcriptMountedBeforeSubmit &&
      chatInputEvidence.visuallyFramed &&
      chatInputEvidence.sendButtonVisibleInViewport &&
      chatInputEvidence.bottomExplanationsAbsent &&
      (chatInputEvidence.inputSettledAtBottom ||
        (typeof chatInputEvidence.composerBottomGapToViewport === 'number' &&
          chatInputEvidence.composerBottomGapToViewport <= 10)) &&
      chatInputEvidence.value === submittedChatPrompt,
    agentCapabilityPreviewHidden: agentCapabilityPreviewHidden,
    agentCapabilityPreviewApi:
      agentPreviewApiEvidence.selected.mcpServers.includes('smoke-mcp') &&
      agentPreviewApiEvidence.selected.skills.includes('smoke-skill') &&
      agentPreviewApiEvidence.skipped.some(
        (item) => item.id === 'missing-mcp' && item.type === 'mcp_server' && item.reason === 'not_found'
      ) &&
      agentPreviewApiEvidence.cards.includes('web:web_read') &&
      agentPreviewApiEvidence.cards.includes('builtin:run_shell_command') &&
      agentPreviewApiEvidence.cards.includes('builtin:delete_file') &&
      agentPreviewApiEvidence.cards.includes('mcp:smoke-mcp:smoke_tool') &&
      agentPreviewApiEvidence.skills.includes('skill:smoke-skill') &&
      !agentPreviewApiEvidence.subagents.some((subagent) => subagent.id === 'code-review') &&
      agentPreviewApiEvidence.subagents.some(
        (subagent) =>
          subagent.id === 'research' &&
          Array.isArray(subagent.skills) &&
          subagent.skills.length === 0 &&
          Array.isArray(subagent.tools) &&
          subagent.tools.includes('web_read')
      ) &&
      agentPreviewApiEvidence.policy === 'external_content_reference_only',
    providerChatResultVisible:
      chatResultTextEvidence.hasProviderResponse &&
      chatResultTextEvidence.hasSubmittedPromptExact &&
      chatResultLayoutEvidence.resultAboveInput &&
      chatResultLayoutEvidence.userAlignedRight &&
      chatResultLayoutEvidence.assistantAlignedLeft &&
      chatResultLayoutEvidence.assistantBubbleUnframed &&
      chatResultLayoutEvidence.assistantContentAnchoredLeft &&
      chatResultLayoutEvidence.assistantBubbleFitsContent &&
      chatResultLayoutEvidence.assistantBubbleNarrowerThanRow,
    taskRunCapabilityStored:
      taskCapabilityEvidence.expectedInput === submittedChatPrompt &&
      taskCapabilityEvidence.threadGoal === submittedChatPrompt &&
      typeof taskCapabilityEvidence.userMessage === 'object' &&
      taskCapabilityEvidence.userMessage !== null &&
      taskCapabilityEvidence.userMessage.content === submittedChatPrompt &&
      Array.isArray(taskCapabilityEvidence.userMessage.enabledCapabilities?.mcpServers) &&
      Array.isArray(taskCapabilityEvidence.userMessage.enabledCapabilities?.skills) &&
      taskCapabilityEvidence.userMessage.enabledCapabilities.mcpServers.includes('smoke-mcp') &&
      taskCapabilityEvidence.userMessage.enabledCapabilities.skills.includes('smoke-skill'),
    taskAssistantEventStored:
      typeof taskCapabilityEvidence.assistantMessage === 'object' &&
      taskCapabilityEvidence.assistantMessage !== null &&
      typeof taskCapabilityEvidence.assistantMessage.content === 'string' &&
      taskCapabilityEvidence.assistantMessage.content.includes('Smoke Provider 已生成首轮回复。') &&
      taskCapabilityEvidence.assistantMessage.providerId === 'smoke-ui-openai' &&
      taskCapabilityEvidence.assistantMessage.modelId === 'smoke-ui-openai-model',
    taskProviderUpdateStored:
      typeof taskCapabilityEvidence.providerUpdate === 'object' &&
      taskCapabilityEvidence.providerUpdate !== null &&
      taskCapabilityEvidence.providerUpdate.providerId === 'smoke-ui-openai' &&
      taskCapabilityEvidence.providerUpdate.modelId === 'smoke-ui-openai-model' &&
      taskCapabilityEvidence.providerUpdate.finishReason === 'stop',
    taskManifestStored:
      typeof taskCapabilityEvidence.manifest === 'object' &&
      taskCapabilityEvidence.manifest !== null &&
      taskCapabilityEvidence.manifest.resolvedCapabilities.mcpServers.includes('smoke-mcp') &&
      taskCapabilityEvidence.manifest.resolvedCapabilities.skills.includes('smoke-skill') &&
      taskCapabilityEvidence.manifest.toolCards.some((card) => card.id === 'mcp:smoke-mcp:smoke_tool') &&
      taskCapabilityEvidence.manifest.untrustedContextPolicy === 'external_content_reference_only',
    skillLoadedEventStored:
      taskCapabilityEvidence.skillLoaded === null ||
      (typeof taskCapabilityEvidence.skillLoaded === 'object' &&
        taskCapabilityEvidence.skillLoaded !== null &&
        taskCapabilityEvidence.skillLoaded.skillId === 'smoke-skill' &&
        taskCapabilityEvidence.skillLoaded.enabledBy === 'turn_selection'),
    historySidebarShowsRealThreads:
      historySidebarEvidence.exists &&
      historySidebarEvidence.hasExpectedThreadTitle &&
      !historySidebarEvidence.hasCurrentSessionLabel &&
      !historySidebarEvidence.hasMemoryRecordLabel &&
      !historySidebarEvidence.hasTaskRecordLabel,
    memoryApiFileEditor:
      boundary.memoryKeys.length === 4 &&
      boundary.memoryKeys.includes('status') &&
      boundary.memoryKeys.includes('readFile') &&
      boundary.memoryKeys.includes('writeFile') &&
      boundary.memoryKeys.includes('snapshotPreview'),
    settingsApiExpanded:
      boundary.settingsKeys.includes('get') &&
      boundary.settingsKeys.includes('save') &&
      boundary.settingsKeys.includes('testProvider'),
    mcpApiExpanded:
      boundary.mcpKeys.includes('ensureExaPreset') &&
      boundary.mcpKeys.includes('upsertServer') &&
      boundary.mcpKeys.includes('setServerEnabled') &&
      boundary.mcpKeys.includes('deleteServer') &&
      boundary.mcpKeys.includes('testServer'),
    skillsApiExpanded:
      boundary.skillKeys.includes('importSkill') &&
      boundary.skillKeys.includes('setEnabled') &&
      boundary.skillKeys.includes('deleteSkill'),
    agentApiExpanded:
      boundary.agentKeys.includes('getStatus') &&
      boundary.agentKeys.includes('getConfigPreview') &&
      boundary.agentKeys.includes('getCapabilityPreview'),
    taskApiExpanded:
      boundary.taskKeys.includes('createBackgroundTaskPreview') &&
      boundary.taskKeys.includes('createBackgroundTask') &&
      boundary.taskKeys.includes('pauseBackgroundTask') &&
      boundary.taskKeys.includes('resumeBackgroundTask') &&
      boundary.taskKeys.includes('cancelBackgroundTask') &&
      boundary.taskKeys.includes('getActiveTasks') &&
      boundary.taskKeys.includes('getSchedulerStatus') &&
      !boundary.taskKeys.includes(['open', 'In', 'Chat'].join('')),
    lifecycleApiExpanded:
      boundary.lifecycleKeys.includes('getTraySummary') &&
      boundary.lifecycleKeys.includes('pauseBackgroundExecution') &&
      boundary.lifecycleKeys.includes('resumeBackgroundExecution'),
    diagnosticsApiExpanded:
      boundary.diagnosticsKeys.includes('samplePerformance') &&
      boundary.diagnosticsKeys.includes('createDiagnosticPackage') &&
      boundary.diagnosticsKeys.includes('runChecks'),
    shellApiExpanded:
      boundary.shellKeys.includes('execute') &&
      boundary.shellKeys.includes('confirm'),
    toolPopoverHoverSticky: buttonInteractionEvidence.toolPopoverHoverSticky,
    skillPopoverHoverSticky: buttonInteractionEvidence.skillPopoverHoverSticky,
    modelPopoverHoverSticky: buttonInteractionEvidence.modelPopoverHoverSticky,
    appShellFlushToWindow:
      appShellFrameEvidence.exists &&
      appShellFrameEvidence.gapTop !== null &&
      appShellFrameEvidence.gapRight !== null &&
      appShellFrameEvidence.gapBottom !== null &&
      appShellFrameEvidence.gapLeft !== null &&
      appShellFrameEvidence.gapTop <= 1 &&
      appShellFrameEvidence.gapRight <= 1 &&
      appShellFrameEvidence.gapBottom <= 1 &&
      appShellFrameEvidence.gapLeft <= 1,
    materialEvidenceRecorded:
      materialEvidence.main.requestedMaterial === 'mica' &&
      materialEvidence.main.apiAvailable &&
      Object.values(materialEvidence).every((item) => item.accepted || typeof item.errorMessage === 'string'),
    windowPlacementPersisted:
      windowPlacementEvidence.persisted &&
      windowPlacementEvidence.snapshot?.maximized === false &&
      typeof windowPlacementEvidence.snapshot?.updatedAt === 'string',
    phase3WebViewBehavior:
      phase3WebViewEvidence.body.cursor === 'default' &&
      phase3WebViewEvidence.body.userSelect === 'none' &&
      phase3WebViewEvidence.chatHistorySearchToggle.cursor === 'default' &&
      phase3WebViewEvidence.chatNewConversation.cursor === 'default' &&
      chatResultLayoutEvidence.userMessageUserSelect !== 'none' &&
      chatResultLayoutEvidence.assistantMessageUserSelect !== 'none' &&
      chatResultLayoutEvidence.inputUserSelect !== 'none' &&
      phase3WebViewEvidence.chatInput.userSelect !== 'none' &&
      phase3WebViewEvidence.pointerCursorNonLinks.length === 0,
    phase4VisualTheme:
      /^#[0-9a-fA-F]{6}$/.test(phase4VisualEvidence.appAppearance.accentColor) &&
      phase4VisualEvidence.datasetTheme === phase4VisualEvidence.appAppearance.resolvedTheme &&
      phase4VisualEvidence.datasetThemeSource === phase4VisualEvidence.appAppearance.themeSource &&
      phase4VisualEvidence.forcedColorsDataset === String(phase4VisualEvidence.appAppearance.inForcedColorsMode) &&
      phase4VisualEvidence.highContrastDataset === String(phase4VisualEvidence.appAppearance.shouldUseHighContrastColors) &&
      phase4VisualEvidence.reducedTransparencyDataset === String(phase4VisualEvidence.appAppearance.prefersReducedTransparency) &&
      phase4VisualEvidence.systemAccentVariable === phase4VisualEvidence.appAppearance.accentColor &&
      phase4VisualEvidence.colorScheme.includes(phase4VisualEvidence.appAppearance.resolvedTheme) &&
      phase4VisualEvidence.bodyFontFamily.includes('Segoe UI') &&
      phase4VisualEvidence.bodyBackgroundImage === 'none' &&
      phase4VisualEvidence.appShellBackgroundImage === 'none' &&
      phase4VisualEvidence.forcedColorsMedia === '(forced-colors: active)',
    sandboxEvaluated:
      phase4VisualEvidence.rendererBoundary.sandbox.evaluated === true &&
      phase4VisualEvidence.rendererBoundary.sandbox.enabled === false &&
      phase4VisualEvidence.rendererBoundary.sandbox.compensatingControls.includes('external URL scheme allowlist'),
    windowDragWorks: windowDragEvidence.moved,
    clickableButtonsHandled: Object.values(buttonInteractionEvidence).every(Boolean)
  };
}
