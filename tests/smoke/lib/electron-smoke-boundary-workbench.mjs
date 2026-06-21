import { existsSync } from 'node:fs';

export function buildRendererBoundaryWorkbench(ctx) {
  const { boundary, workbandBox, initialWindowShell, smokeTarget, packagedExe, processMetricsSummary, taskText, backgroundTaskGoal, backgroundTaskApiEvidence, backgroundTaskNextRunAt, taskProposalEvidence, naturalLanguageTaskGoal, createdTaskDetailText, naturalLanguageTaskCronExpression, manualRunNowEvidence, manualRunDetailText, manualRunTranscriptText, diagnosticsText, phase6ApiEvidence, ipcSummary, workspaceText, workspaceApiEvidence, gitText, terminalLiveOutput, previewText, previewPageImageEvidence, filePreviewBeforeClick, filePreviewAfterClick, directoryExpandEvidence, imagePreviewEvidence, pdfPreviewEvidence, workbenchPreviewModeButtonCount, workbenchCodeModeButtonCount, filePaneWidthAfter, filePaneWidthBefore, explorerHideButtonCountBefore, explorerRefreshButtonCountBefore, chatWorkbenchLayoutVisible, workbenchWidthAfter, workbenchWidthBefore, filePreviewLayoutEvidence, filePreviewStatsEvidence, gitCommitButtonCount, gitCommitMessageCount, gitRefreshPrimaryCount, gitBatchStageCount, gitBranchSelectCount, gitSplitCount, gitSidebarCount, gitDetailPaneCount, gitChangeActionCount, gitHeaderEvidence, workbenchGitSelectionActionCountBeforeStage, workbenchGitSelectionActionCountAfterManual, workbenchGitSelectionActionCountAfterStage, workbenchGitSelectionText, workbenchGitSelectionPath, workbenchGitSelectionAfterStage, gitDiffScrollEvidenceBefore, gitDiffScrollEvidenceAfter, workbenchGitText, gitCommitInitialState, workbenchGitAfterBatchStage, workbenchGitSelectedCountAfterManual, workbenchGitSelectedCountAfterAll, gitCommitReadyState, gitCurrentBranchAfterCreate, initialGitBranch, gitCurrentBranchAfterCheckout, confirmMessages, nativeConfirmIpcSamples, gitLastCommitText, gitCommitResetState, gitLastPushText, workspaceRoot, terminalSecondOutput, terminalWorkbenchStyleEvidence, rtkPanelText } = ctx;
  return {
    hasRequire: boundary.hasRequire,
    hasProcess: boundary.hasProcess,
    rocKeys: boundary.rocKeys,
    appKeys: boundary.appKeys,
    windowKeys: boundary.windowKeys,
    workspaceKeys: boundary.workspaceKeys,
    fileKeys: boundary.fileKeys,
    memoryKeys: boundary.memoryKeys,
    settingsKeys: boundary.settingsKeys,
    mcpKeys: boundary.mcpKeys,
    skillKeys: boundary.skillKeys,
    taskKeys: boundary.taskKeys,
    lifecycleKeys: boundary.lifecycleKeys,
    diagnosticsKeys: boundary.diagnosticsKeys,
    agentKeys: boundary.agentKeys,
    terminalKeys: boundary.terminalKeys,
    shellKeys: boundary.shellKeys,
    activeViewText: boundary.activeViewText,
    immersiveWorkbandVisible: workbandBox.height > 0 && workbandBox.y <= 2,
    systemMenuHidden: initialWindowShell.menuBarVisible === false,
    initialWindowNotMaximized: initialWindowShell.maximized === false,
    mockTextAbsent: true,
    smokeTargetKind: smokeTarget.kind,
    smokeTargetPath: smokeTarget.path,
    packagedExeExists: existsSync(packagedExe),
    browserWindowCount: processMetricsSummary.browserWindowCount,
    backgroundTaskVisible:
      taskText.includes(backgroundTaskGoal) &&
      backgroundTaskApiEvidence.activeTasks.some((item) => item.goal === backgroundTaskGoal) &&
      backgroundTaskApiEvidence.tray.backgroundTasks.total > 0 &&
      backgroundTaskApiEvidence.tray.nextRunAt === backgroundTaskNextRunAt &&
      backgroundTaskApiEvidence.hasCreatedEvent,
    naturalLanguageTaskCreated:
      taskProposalEvidence.activeTaskGoal === naturalLanguageTaskGoal &&
      typeof createdTaskDetailText === 'string' &&
      createdTaskDetailText.includes(naturalLanguageTaskGoal) &&
      taskProposalEvidence.triggerType === 'cron' &&
      taskProposalEvidence.cronExpression === naturalLanguageTaskCronExpression &&
      taskProposalEvidence.nextRunAt === taskProposalEvidence.expectedNextRunAt &&
      taskProposalEvidence.hasCreatedEvent &&
      taskProposalEvidence.hasProposeToolCallStart &&
      taskProposalEvidence.hasProposeToolCallEnd &&
      taskProposalEvidence.hasScheduleToolCallStart &&
      taskProposalEvidence.hasScheduleToolCallEnd &&
      taskProposalEvidence.schemaFailureCount === 0,
    manualRunNowStartsRealRun:
      manualRunNowEvidence.returnedRealRunId &&
      manualRunNowEvidence.runId.startsWith('run_') &&
      manualRunNowEvidence.outputEventTypes.some((type) => type === 'message' || type === 'assistant_block') &&
      typeof manualRunDetailText === 'string' &&
      manualRunDetailText.includes('Smoke manual run-now diagnostic task') &&
      typeof manualRunTranscriptText === 'string' &&
      manualRunTranscriptText.trim().length > 0,
    traySummaryVisible:
      taskText.includes('待处理') &&
      taskText.includes('进行中') &&
      taskText.includes('已暂停') &&
      taskText.includes('已结束') &&
      backgroundTaskApiEvidence.schedulerStatus.running &&
      backgroundTaskApiEvidence.tray.backgroundTasks.total > 0 &&
      backgroundTaskApiEvidence.hasCreatedEvent,
    diagnosticPackageVisible:
      diagnosticsText.includes('脱敏') &&
      diagnosticsText.includes('task_snapshot') &&
      diagnosticsText.includes('Doctor 检查') &&
      diagnosticsText.includes('调度器运行'),
    performanceSampleVisible:
      diagnosticsText.includes('RSS') &&
      phase6ApiEvidence.sample.rssMb > 0 &&
      phase6ApiEvidence.sample.heapUsedMb > 0 &&
      typeof phase6ApiEvidence.sample.exceedsBudget === 'boolean',
    ipcTopNRecorded:
      ipcSummary.totalCalls > 0 &&
      ipcSummary.topSlowCalls.length > 0 &&
      ipcSummary.topFrequentCalls.length > 0 &&
      ipcSummary.windowSetBoundsCalls === 0,
    workspaceFileVisible: workspaceText.includes('phase-three-notes.txt'),
    workspaceSearchVisible:
      workspaceApiEvidence.search.matches.some(
        (match) => match.relativePath === 'phase-three-notes.txt' && match.preview.includes('phase three smoke workspace')
      ),
    gitChangesVisible:
      workspaceText.includes('phase-three-notes.txt') &&
      gitText.includes('phase-three-notes.txt') &&
      gitText.includes('变更'),
    terminalOutputVisible:
      workspaceText.includes('phase-three-notes.txt') &&
      terminalLiveOutput?.includes('phase-three-notes.txt') === true,
    previewFileVisible:
      ((previewText.includes('phase-three-notes.txt') && previewText.includes('phase three smoke workspace')) ||
        (previewText.includes('assets/smoke-image.png') &&
          previewText.includes('图片预览已加载。') &&
          previewPageImageEvidence.exists &&
          previewPageImageEvidence.src.startsWith('data:image/png;base64,')) ||
        (previewText.includes('docs/smoke-preview.pdf') &&
          previewText.includes('PDF 文件需要在文件工作台中预览。'))) &&
      filePreviewBeforeClick !== filePreviewAfterClick &&
      filePreviewAfterClick?.includes('changed in git') === true,
    workbenchDirectoryExpandable: directoryExpandEvidence,
    workbenchImagePreviewVisible:
      imagePreviewEvidence.exists &&
      imagePreviewEvidence.src.startsWith('data:image/png;base64,') &&
      imagePreviewEvidence.alt.includes('assets/smoke-image.png'),
    workbenchPdfPreviewVisible:
      pdfPreviewEvidence.src === 'roc-preview://workspace/pdf/docs%2Fsmoke-preview.pdf#toolbar=0&navpanes=0&scrollbar=0' &&
      pdfPreviewEvidence.hintExists === false &&
      pdfPreviewEvidence.frameHeight > 0 &&
      pdfPreviewEvidence.previewBodyHeight > 0 &&
      pdfPreviewEvidence.stageHeight >= pdfPreviewEvidence.frameHeight &&
      pdfPreviewEvidence.frameHeight >= pdfPreviewEvidence.previewBodyHeight - 48 &&
      pdfPreviewEvidence.title.includes('docs/smoke-preview.pdf'),
    workbenchBarCompact: pdfPreviewEvidence.workbenchBarHeight > 0 && pdfPreviewEvidence.workbenchBarHeight <= 48,
    workbenchImagePreviewFrameless:
      !imagePreviewEvidence.boardExists &&
      imagePreviewEvidence.imageBorderTopWidth === '0px' &&
      imagePreviewEvidence.imageBorderRadius === '0px' &&
      imagePreviewEvidence.imageBoxShadow === 'none',
    workbenchPreviewModeRemoved: workbenchPreviewModeButtonCount === 0 && workbenchCodeModeButtonCount === 0,
    workbenchFileSplitterResizable: Math.abs(filePaneWidthAfter.width - filePaneWidthBefore.width) >= 40,
    explorerHeaderTrimmed: explorerHideButtonCountBefore === 0 && explorerRefreshButtonCountBefore === 0,
    chatWorkbenchLayoutVisible,
    workbenchResizable: Math.abs(workbenchWidthAfter.width - workbenchWidthBefore.width) >= 48,
    workbenchFilePreviewClickable:
      filePreviewBeforeClick !== filePreviewAfterClick &&
      filePreviewAfterClick.includes('changed in git'),
    workbenchPreviewLayoutCompact:
      filePreviewLayoutEvidence.headerExists &&
      filePreviewLayoutEvidence.bodyExists &&
      ((filePreviewLayoutEvidence.metaStripExists &&
        filePreviewLayoutEvidence.metaStripHeight !== null &&
        filePreviewLayoutEvidence.metaStripHeight <= 48 &&
        filePreviewLayoutEvidence.gapAfterHeader !== null &&
        filePreviewLayoutEvidence.gapAfterMetaStrip !== null &&
        filePreviewLayoutEvidence.gapAfterHeader <= 2 &&
        filePreviewLayoutEvidence.gapAfterMetaStrip <= 2) ||
        (!filePreviewLayoutEvidence.metaStripExists &&
          filePreviewLayoutEvidence.gapAfterHeader !== null &&
          filePreviewLayoutEvidence.gapAfterHeader <= 2)),
    workbenchPreviewNoLargeTrailingGap:
      filePreviewLayoutEvidence.previewExists &&
      !filePreviewLayoutEvidence.footerExists &&
      !filePreviewLayoutEvidence.footerText.includes('F:\\Code\\Roc') &&
      filePreviewLayoutEvidence.contentGapToBody !== null &&
      filePreviewLayoutEvidence.contentGapToBody <= 48,
    workbenchPreviewStatsRemoved:
      filePreviewStatsEvidence.contentHeaderText.length === 0 &&
      filePreviewStatsEvidence.metaStripText.length === 0 &&
      !filePreviewStatsEvidence.footerText.includes('条搜索命中') &&
      !/\d+\s*项/u.test(filePreviewStatsEvidence.footerText),
    workbenchGitControlsVisible:
      gitCommitButtonCount === 1 &&
      gitCommitMessageCount === 1 &&
      gitRefreshPrimaryCount === 1 &&
      gitBatchStageCount === 1 &&
      gitBranchSelectCount === 1 &&
      gitSplitCount === 1 &&
      gitSidebarCount === 1 &&
      gitDetailPaneCount === 1 &&
      gitChangeActionCount === 0,
    workbenchGitVisualHierarchy:
      gitHeaderEvidence.splitColumns.includes('12px') &&
      gitHeaderEvidence.splitColumns.includes('px'),
    workbenchGitDetailControls:
      workbenchGitSelectionActionCountBeforeStage === 0 &&
      workbenchGitSelectionActionCountAfterManual === 0 &&
      workbenchGitSelectionActionCountAfterStage === 0,
    workbenchGitSelection:
      workbenchGitSelectionText?.includes('phase-three-notes.txt') === true &&
      workbenchGitSelectionPath?.includes('phase-three-notes.txt') === true &&
      workbenchGitSelectionText?.includes('changed in git line') === true &&
      workbenchGitSelectionAfterStage?.includes('已暂存') === true &&
      gitDiffScrollEvidenceBefore.exists &&
      gitDiffScrollEvidenceAfter.exists &&
      typeof gitDiffScrollEvidenceBefore.clientHeight === 'number' &&
      typeof gitDiffScrollEvidenceBefore.scrollHeight === 'number' &&
      gitDiffScrollEvidenceBefore.scrollHeight > gitDiffScrollEvidenceBefore.clientHeight &&
      typeof gitDiffScrollEvidenceBefore.scrollTop === 'number' &&
      typeof gitDiffScrollEvidenceAfter.scrollTop === 'number' &&
      gitDiffScrollEvidenceAfter.scrollTop > gitDiffScrollEvidenceBefore.scrollTop &&
      gitDiffScrollEvidenceBefore.overflowX === 'auto' &&
      gitDiffScrollEvidenceBefore.overflowY === 'auto',
    workbenchGitDiffPathDeduped:
      !workbenchGitSelectionText?.includes('phase-three-notes.txt → phase-three-notes.txt') &&
      !gitDiffScrollEvidenceBefore.toolbarText.includes('phase-three-notes.txt → phase-three-notes.txt'),
    workbenchGitActions:
      workbenchGitText?.includes('phase-three-notes.txt') === true &&
      gitCommitInitialState !== null &&
      gitCommitInitialState.disabled === true &&
      gitCommitInitialState.value === '' &&
      !gitCommitInitialState.className.includes('git-commit-button--ready') &&
      workbenchGitAfterBatchStage?.includes('待提交变更2') === true &&
      workbenchGitAfterBatchStage?.includes('phase-three-notes.txt已暂存') === true &&
      workbenchGitAfterBatchStage?.includes('batch-stage.txt已暂存') === true &&
      workbenchGitAfterBatchStage?.includes('工作区变更0') === true &&
      workbenchGitSelectedCountAfterManual?.includes('2 selected') === true &&
      workbenchGitSelectedCountAfterAll?.includes('2 selected') === true &&
      gitCommitReadyState !== null &&
      gitCommitReadyState.disabled === false &&
      gitCommitReadyState.className.includes('git-commit-button--ready') &&
      gitCurrentBranchAfterCreate?.includes('feature/smoke-branch') === true &&
      initialGitBranch !== null &&
      gitCurrentBranchAfterCheckout?.includes(initialGitBranch.trim()) === true &&
      Array.isArray(confirmMessages) &&
      confirmMessages.length === 0 &&
      nativeConfirmIpcSamples.length >= 2 &&
      gitLastCommitText?.includes('最近提交：smoke commit') === true &&
      gitCommitResetState !== null &&
      gitCommitResetState.disabled === true &&
      gitCommitResetState.value === '' &&
      !gitCommitResetState.className.includes('git-commit-button--ready') &&
      gitLastPushText?.includes('最近提交：smoke push commit') === true,
    terminalCommandRunnable:
      terminalLiveOutput?.includes('phase-three-notes.txt') === true &&
      terminalSecondOutput?.toLowerCase().includes(workspaceRoot.toLowerCase()) === true,
    terminalSessionPersistent:
      terminalLiveOutput?.includes('phase-three-notes.txt') === true &&
      terminalSecondOutput?.includes('phase-three-notes.txt') === true,
    terminalWorkbenchStyled:
      terminalWorkbenchStyleEvidence.frameVisible &&
      terminalWorkbenchStyleEvidence.borderRadius !== '0px' &&
      terminalWorkbenchStyleEvidence.xtermShellExists &&
      terminalWorkbenchStyleEvidence.shellFillRatio !== null &&
      terminalWorkbenchStyleEvidence.shellFillRatio >= 90,
    terminalWorkbenchHierarchy:
      terminalWorkbenchStyleEvidence.headerExists === false &&
      terminalWorkbenchStyleEvidence.badgeCount === 0 &&
      terminalWorkbenchStyleEvidence.scope.length === 0 &&
      terminalWorkbenchStyleEvidence.terminalSubtitle.length === 0 &&
      terminalWorkbenchStyleEvidence.footerSegments.length === 1 &&
      !terminalWorkbenchStyleEvidence.footerSegments.some((item) => item.includes('真实持续会话')) &&
      !terminalWorkbenchStyleEvidence.footerSegments.some((item) => item.includes('×')),
    rtkMissingVisible:
      rtkPanelText !== null &&
      rtkPanelText.includes('资源状态') &&
      rtkPanelText.includes(workspaceApiEvidence.rtk.resourceState === 'ready' ? 'ready' : '缺失降级'),
  };
}
