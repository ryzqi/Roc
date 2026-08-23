import { existsSync } from 'node:fs';
import { writeSmokeResult } from './artifacts.mjs';
import { buildRendererBoundaryCapabilities } from './electron-smoke-boundary-capabilities.mjs';
import { buildRendererBoundaryWorkbench } from './electron-smoke-boundary-workbench.mjs';
import { nativeFeelScorecard } from './native-feel.mjs';

export function writeElectronSmokeResult(ctx) {
  const { artifactDir, releaseReadiness, dataRoot, smokeTarget, packagedExe, phase6ApiEvidence, ipcSummary, nativeFeel, nativeModuleProbe, processMetricsSummary, smokeProvider, chatInputEvidence, workspaceSelectButtonEvidence, sidebarDockEvidenceBefore, sidebarDockEvidenceAfter, buttonInteractionEvidence, historySidebarEvidence, memoryStatusApiEvidence, terminalText, terminalLiveOutput, terminalWorkbenchStyleEvidence, gitText, filePreviewLayoutEvidence, filePreviewStatsEvidence, workbenchGitText, workbenchGitAfterBatchStage, gitDiffScrollEvidenceBefore, gitDiffScrollEvidenceAfter, workbenchWidthBefore, workbenchWidthAfter, collapsedChatLayoutBeforeOpen, collapsedChatLayoutAfterClose, chatResultTextEvidence, chatResultLayoutEvidence, skillLayoutEvidence, manualRunNowEvidence, manualRunDetailText, manualRunTranscriptText, createdTaskDetailText, taskProposalEvidence, providerSettingsEvidence, materialEvidence, windowPlacementEvidence, phase3WebViewEvidence, phase4VisualEvidence, confirmMessages, nativeConfirmIpcSamples, previewText } = ctx;
  const rendererBoundary = {
    ...buildRendererBoundaryWorkbench(ctx),
    ...buildRendererBoundaryCapabilities(ctx)
  };
  const releaseReadinessHonest =
    releaseReadiness.integrations.appProtocol.status === 'absent' &&
    releaseReadiness.integrations.fileAssociation.status === 'absent' &&
    releaseReadiness.integrations.windowsToast.status === 'absent' &&
    releaseReadiness.integrations.taskbarJumpList.status === 'absent' &&
    releaseReadiness.integrations.installerSigningUpdater.status === 'absent' &&
    releaseReadiness.integrations.crashReporter.status === 'absent';

  const failedChecks = Object.entries({
    hasRequire: !rendererBoundary.hasRequire,
    hasProcess: !rendererBoundary.hasProcess,
    immersiveWorkbandVisible: rendererBoundary.immersiveWorkbandVisible,
    systemMenuHidden: rendererBoundary.systemMenuHidden,
    initialWindowNotMaximized: rendererBoundary.initialWindowNotMaximized,
    appShellFlushToWindow: rendererBoundary.appShellFlushToWindow,
    materialEvidenceRecorded: rendererBoundary.materialEvidenceRecorded,
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
      materialEvidence,
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
    rendererBoundary,
    checkedAt: new Date().toISOString()
  };

  writeSmokeResult(artifactDir, result);

  if (!passed) {
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  }
  Object.assign(ctx, { failedChecks, passed, rendererBoundary, result });
}
