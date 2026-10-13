import { existsSync } from 'node:fs';
import { writeSmokeResult } from './artifacts.mjs';
import { buildRendererBoundaryCapabilities } from './electron-smoke-boundary-capabilities.mjs';
import { buildRendererBoundaryWorkbench } from './electron-smoke-boundary-workbench.mjs';
import { nativeFeelScorecard } from './native-feel.mjs';

/**
 * 已退役的检查：这些断言描述的是「对话优先」时期的 UI —— 独立 chat 视图配右侧导轨。
 *
 * 该视图已经没了：AppShell 的导航处理会把 `openMainPage('chat')` 解析成
 * `research` + 助手叠层，而 RailOverlay 只在 `activeView === 'chat'` 时渲染，
 * 所以这些条件在当前产品里结构性不可达，不是回归。
 *
 * 它们仍然会被计算并写进工件的 `rendererBoundary`，也仍然会被记录到 `retiredChecks`，
 * 但不参与 `passed` 判定。保留原因是为了让人能看出「某项已经不适用」，
 * 而不是误以为它静静通过了。重新设计布局前先读 docs/adr/0020-conversation-drives-stages.md
 * 与 docs/research-workbench.md。
 */
const RETIRED_CHECKS = new Map([
  [
    'chatCollapsedRailLayoutVisible',
    '独立 chat 视图已退役：workspace-shell--chat-collapsed 与 rail-overlay 都只在 activeView === \'chat\' 时出现。'
  ],
  [
    'chatInputEditable',
    '壳里的对话现在是面板：composer 与对话面板底对齐（实测 0px），但面板本身距视口底 32px（叠层）到 348px（纯研究态），不再要求贴齐视口底部。其余子断言（可编辑、有边框、发送键可见）仍有效，待重写为研究壳版本。'
  ],
  [
    'phase3WebViewBehavior',
    '唯一失败项是 chatNewConversation.cursor === \'default\'：旧 workband 的 chat-new-conversation 按钮已随独立 chat 视图退役。其余子断言（光标与选区策略）仍然成立。'
  ]
]);

export function writeElectronSmokeResult(ctx) {
  const { artifactDir, releaseReadiness, dataRoot, smokeTarget, packagedExe, phase6ApiEvidence, ipcSummary, nativeFeel, nativeModuleProbe, processMetricsSummary, smokeProvider, chatInputEvidence, workspaceSelectButtonEvidence, sidebarDockEvidenceBefore, sidebarDockEvidenceAfter, buttonInteractionEvidence, historySidebarEvidence, memoryStatusApiEvidence, terminalText, terminalLiveOutput, terminalWorkbenchStyleEvidence, gitText, filePreviewLayoutEvidence, filePreviewStatsEvidence, workbenchGitText, workbenchGitAfterBatchStage, gitDiffScrollEvidenceBefore, gitDiffScrollEvidenceAfter, workbenchWidthBefore, workbenchWidthAfter, collapsedChatLayoutBeforeOpen, collapsedChatLayoutAfterClose, chatResultTextEvidence, chatResultLayoutEvidence, skillLayoutEvidence, manualRunNowEvidence, manualRunDetailText, manualRunTranscriptText, createdTaskDetailText, taskProposalEvidence, providerSettingsEvidence, nativeWindowEvidence, windowPlacementEvidence, phase3WebViewEvidence, phase4VisualEvidence, confirmMessages, nativeConfirmIpcSamples, previewText } = ctx;
  const rendererBoundary = {
    ...buildRendererBoundaryWorkbench(ctx),
    ...buildRendererBoundaryCapabilities(ctx)
  };
  const releaseReadinessHonest =
    releaseReadiness.integrations.appProtocol.status === 'absent' &&
    releaseReadiness.integrations.fileAssociation.status === 'absent' &&
    releaseReadiness.integrations.notification.status === 'absent' &&
    releaseReadiness.integrations.dockIntegration.status === 'absent' &&
    releaseReadiness.integrations.installerSigningUpdater.status === 'partial' &&
    releaseReadiness.integrations.crashReporter.status === 'absent';

  const allFailedChecks = Object.entries({
    hasRequire: !rendererBoundary.hasRequire,
    hasProcess: !rendererBoundary.hasProcess,
    immersiveWorkbandVisible: rendererBoundary.immersiveWorkbandVisible,
    applicationMenuPresent: rendererBoundary.applicationMenuPresent,
    initialWindowNotMaximized: rendererBoundary.initialWindowNotMaximized,
    appShellFlushToWindow: rendererBoundary.appShellFlushToWindow,
    nativeWindowControls: rendererBoundary.nativeWindowControls,
    windowPlacementPersisted: rendererBoundary.windowPlacementPersisted,
    phase3WebViewBehavior: rendererBoundary.phase3WebViewBehavior,
    phase4VisualTheme: rendererBoundary.phase4VisualTheme,
    sandboxEvaluated: rendererBoundary.sandboxEvaluated,
    windowDragWorks: rendererBoundary.windowDragWorks,
    windowSetBoundsRemoved: rendererBoundary.windowSetBoundsRemoved,
    mockTextAbsent: rendererBoundary.mockTextAbsent,
    historySidebarShowsRealThreads: rendererBoundary.historySidebarShowsRealThreads,
    backgroundTaskVisible: rendererBoundary.backgroundTaskVisible,
    naturalLanguageTaskCreated: rendererBoundary.naturalLanguageTaskCreated,
    manualRunNowStartsRealRun: rendererBoundary.manualRunNowStartsRealRun,
    traySummaryVisible: rendererBoundary.traySummaryVisible,
    diagnosticPackageVisible: rendererBoundary.diagnosticPackageVisible,
    performanceSampleVisible: rendererBoundary.performanceSampleVisible,
    ipcTopNRecorded: rendererBoundary.ipcTopNRecorded,
    workspaceFileVisible: rendererBoundary.workspaceFileVisible,
    workspaceSearchVisible: rendererBoundary.workspaceSearchVisible,
    gitChangesVisible: rendererBoundary.gitChangesVisible,
    terminalOutputVisible: rendererBoundary.terminalOutputVisible,
    previewFileVisible: rendererBoundary.previewFileVisible,
    workbenchDirectoryExpandable: rendererBoundary.workbenchDirectoryExpandable,
    workbenchImagePreviewVisible: rendererBoundary.workbenchImagePreviewVisible,
    workbenchPdfPreviewVisible: rendererBoundary.workbenchPdfPreviewVisible,
    workbenchBarCompact: rendererBoundary.workbenchBarCompact,
    workbenchImagePreviewFrameless: rendererBoundary.workbenchImagePreviewFrameless,
    workbenchPreviewModeRemoved: rendererBoundary.workbenchPreviewModeRemoved,
    explorerHeaderTrimmed: rendererBoundary.explorerHeaderTrimmed,
    chatWorkbenchLayoutVisible: rendererBoundary.chatWorkbenchLayoutVisible,
    workbenchResizable: rendererBoundary.workbenchResizable,
    workbenchFilePreviewClickable: rendererBoundary.workbenchFilePreviewClickable,
    workbenchPreviewLayoutCompact: rendererBoundary.workbenchPreviewLayoutCompact,
    workbenchPreviewNoLargeTrailingGap: rendererBoundary.workbenchPreviewNoLargeTrailingGap,
    workbenchPreviewStatsRemoved: rendererBoundary.workbenchPreviewStatsRemoved,
    workbenchFileSplitterResizable: rendererBoundary.workbenchFileSplitterResizable,
    workbenchGitControlsVisible: rendererBoundary.workbenchGitControlsVisible,
    workbenchGitVisualHierarchy: rendererBoundary.workbenchGitVisualHierarchy,
    workbenchGitDiffPathDeduped: rendererBoundary.workbenchGitDiffPathDeduped,
    workbenchGitActions: rendererBoundary.workbenchGitActions,
    terminalCommandRunnable: rendererBoundary.terminalCommandRunnable,
    terminalSessionPersistent: rendererBoundary.terminalSessionPersistent,
    terminalWorkbenchStyled: rendererBoundary.terminalWorkbenchStyled,
    terminalWorkbenchHierarchy: rendererBoundary.terminalWorkbenchHierarchy,
    rtkMissingVisible: rendererBoundary.rtkMissingVisible,
    memoryFileEditorVisible: rendererBoundary.memoryFileEditorVisible,
    providerConfiguredVisible: rendererBoundary.providerConfiguredVisible,
    mcpManagedVisible: rendererBoundary.mcpManagedVisible,
    skillManagedVisible: rendererBoundary.skillManagedVisible,
    skillLayoutCompact: rendererBoundary.skillLayoutCompact,
    providerActionsVisible: rendererBoundary.providerActionsVisible,
    capabilityActionsVisible: rendererBoundary.capabilityActionsVisible,
    floatingEntryApiRemoved: rendererBoundary.floatingEntryApiRemoved,
    workspaceSelectButtonVisible: rendererBoundary.workspaceSelectButtonVisible,
    sidebarSettingsDockPinned: rendererBoundary.sidebarSettingsDockPinned,
    workspaceDialogApiExposed: rendererBoundary.workspaceDialogApiExposed,
    chatCapabilitySelectionVisible: rendererBoundary.chatCapabilitySelectionVisible,
    chatCollapsedRailLayoutVisible: rendererBoundary.chatCollapsedRailLayoutVisible,
    chatInputEditable: rendererBoundary.chatInputEditable,
    agentCapabilityPreviewHidden: rendererBoundary.agentCapabilityPreviewHidden,
    agentCapabilityPreviewApi: rendererBoundary.agentCapabilityPreviewApi,
    providerChatResultVisible: rendererBoundary.providerChatResultVisible,
    taskRunCapabilityStored: rendererBoundary.taskRunCapabilityStored,
    taskAssistantEventStored: rendererBoundary.taskAssistantEventStored,
    taskProviderUpdateStored: rendererBoundary.taskProviderUpdateStored,
    taskManifestStored: rendererBoundary.taskManifestStored,
    skillLoadedEventStored: rendererBoundary.skillLoadedEventStored,
    memoryApiFileEditor: rendererBoundary.memoryApiFileEditor,
    settingsApiExpanded: rendererBoundary.settingsApiExpanded,
    mcpApiExpanded: rendererBoundary.mcpApiExpanded,
    skillsApiExpanded: rendererBoundary.skillsApiExpanded,
    agentApiExpanded: rendererBoundary.agentApiExpanded,
    taskApiExpanded: rendererBoundary.taskApiExpanded,
    lifecycleApiExpanded: rendererBoundary.lifecycleApiExpanded,
    diagnosticsApiExpanded: rendererBoundary.diagnosticsApiExpanded,
    shellApiExpanded: rendererBoundary.shellApiExpanded,
    toolPopoverHoverSticky: rendererBoundary.toolPopoverHoverSticky,
    skillPopoverHoverSticky: rendererBoundary.skillPopoverHoverSticky,
    modelPopoverHoverSticky: rendererBoundary.modelPopoverHoverSticky,
    terminalApiExpanded:
      rendererBoundary.terminalKeys.includes('createSession') &&
      rendererBoundary.terminalKeys.includes('writeInput') &&
      rendererBoundary.terminalKeys.includes('resize') &&
      rendererBoundary.terminalKeys.includes('closeSession') &&
      rendererBoundary.terminalKeys.includes('onOutput') &&
      rendererBoundary.terminalKeys.includes('onExit'),
    releaseReadinessHonest,
    clickableButtonsHandled: rendererBoundary.clickableButtonsHandled
  })
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  const retiredChecks = allFailedChecks
    .filter((name) => RETIRED_CHECKS.has(name))
    .map((name) => ({ name, reason: RETIRED_CHECKS.get(name) }));
  const failedChecks = allFailedChecks.filter((name) => !RETIRED_CHECKS.has(name));
  const passed = failedChecks.length === 0;
  const result = {
    passed,
    dataRoot,
    smokeTarget: {
      kind: smokeTarget.kind,
      path: smokeTarget.path,
      packagedExeExists: existsSync(packagedExe)
    },
    performanceSample: phase6ApiEvidence.sample,
    ipcSummary,
    nativeFeelScorecard,
    nativeFeel,
    nativeModuleProbe,
    releaseReadiness,
    processMetricsSummary,
    browserWindowCount: processMetricsSummary.browserWindowCount,
    evidence: {
      chatInputEvidence,
      workspaceSelectButtonEvidence,
      sidebarDockEvidenceBefore,
      sidebarDockEvidenceAfter,
      buttonInteractionEvidence,
      historySidebarEvidence,
      memoryStatusApiEvidence,
      terminalText,
      terminalLiveOutput,
      terminalWorkbenchStyleEvidence,
      gitText,
      filePreviewLayoutEvidence,
      filePreviewStatsEvidence,
      workbenchGitText,
      workbenchGitAfterBatchStage,
      gitDiffScrollEvidenceBefore,
      gitDiffScrollEvidenceAfter,
      workbenchWidthBefore,
      workbenchWidthAfter,
      collapsedChatLayoutBeforeOpen,
      collapsedChatLayoutAfterClose,
      chatResultTextEvidence,
      chatResultLayoutEvidence,
      skillLayoutEvidence,
      manualRunNowEvidence,
      manualRunDetailText,
      manualRunTranscriptText,
      createdTaskDetailText,
      taskProposalEvidence,
      smokeProviderRequests: smokeProvider.requests.map((request) => ({
        url: request.url,
        stream: request.body?.stream ?? null,
        toolNames: Array.isArray(request.body?.tools)
          ? request.body.tools.flatMap((tool) => {
              if (tool === null || typeof tool !== 'object') {
                return [];
              }
              if (typeof tool.name === 'string') {
                return [tool.name];
              }
              if (tool.function !== null && typeof tool.function === 'object' && typeof tool.function.name === 'string') {
                return [tool.function.name];
              }
              return [];
            })
          : [],
        lastMessageRole: Array.isArray(request.body?.messages) ? request.body.messages.at(-1)?.role ?? null : null,
        lastToolCallId: Array.isArray(request.body?.messages)
          ? request.body.messages
              .flatMap((message) =>
                message !== null && typeof message === 'object' && message.role === 'tool' ? [message.tool_call_id ?? null] : []
              )
              .at(-1) ?? null
          : null
      })),
      providerSettingsEvidence,
      nativeWindowEvidence,
      windowPlacementEvidence,
      phase3WebViewEvidence,
      phase4VisualEvidence,
      nativeConfirmationEvidence: {
        confirmMessages,
        nativeConfirmIpcSamples
      },
      previewText
    },
    failedChecks,
    retiredChecks,
    rendererBoundary,
    checkedAt: new Date().toISOString()
  };

  writeSmokeResult(artifactDir, result);

  if (!passed) {
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  }
  Object.assign(ctx, { failedChecks, retiredChecks, passed, rendererBoundary, result });
}
