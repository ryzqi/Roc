export const nativeFeelScorecard = Object.freeze({
  target: 'windows-electron-native-feel',
  scope: 'current Windows Electron Roc.exe',
  checks: [
    { id: 'cold_launch_ready_to_show', status: 'measured', evidence: 'timing.ready_to_show' },
    { id: 'packaged_exe_startup', status: 'measured', evidence: 'smokeTarget' },
    { id: 'close_minimize_tray', status: 'guarded', evidence: 'WindowsHostService close policy tests' },
    { id: 'global_hotkey', status: 'guarded', evidence: 'WindowsHostService globalShortcut tests' },
    { id: 'single_instance', status: 'guarded', evidence: 'WindowsHostService second-instance tests' },
    { id: 'native_window_drag', status: 'guarded', evidence: 'smoke windowDragWorks without renderer setBounds IPC' },
    { id: 'caption_buttons', status: 'guarded', evidence: 'renderer native-feel CSS test' },
    { id: 'mica_acrylic_fallback', status: 'planned', evidence: 'Phase 2' },
    { id: 'cursor_selection_scroll', status: 'guarded', evidence: 'renderer native-feel CSS test' },
    { id: 'native_context_menu_dialog', status: 'planned', evidence: 'Phase 3' },
    { id: 'keyboard_ime', status: 'manual-required', evidence: 'Phase 3/6 manual record' },
    { id: 'process_metrics', status: 'measured', evidence: 'diagnostics.samplePerformance.electron' },
    { id: 'notification_url_file_association', status: 'planned', evidence: 'Phase 6' },
    { id: 'taskbar_jump_list_progress', status: 'planned', evidence: 'Phase 6' },
    { id: 'signing_installer_updater_crash', status: 'planned', evidence: 'Phase 6' },
    { id: 'narrator_large_font_forced_colors', status: 'manual-required', evidence: 'Phase 6 manual record' }
  ]
});

export function latestTimingDurationMs(sample, phase) {
  const matches = sample.timing?.samples?.filter((item) => item.phase === phase) ?? [];
  const latest = matches.at(-1);
  return typeof latest?.durationMs === 'number' ? Math.round(latest.durationMs) : null;
}

export function summarizeProcessMetrics(sample) {
  const electron = sample.electron ?? {
    browserWindowCount: 0,
    processCount: 0,
    processMetrics: []
  };
  const processTypes = {};
  let totalWorkingSetMb = 0;
  for (const metric of electron.processMetrics) {
    processTypes[metric.type] = (processTypes[metric.type] ?? 0) + 1;
    totalWorkingSetMb += metric.memory.workingSetSizeMb;
  }

  return {
    browserWindowCount: electron.browserWindowCount,
    processCount: electron.processCount,
    processTypes,
    totalWorkingSetMb: Math.round(totalWorkingSetMb * 10) / 10
  };
}

export function buildNativeFeelSummary({
  sample,
  smokeTarget,
  rendererReadyMs,
  mainInputReadyMs,
  nativeModuleProbe = null
}) {
  return {
    nativeFeelScorecard,
    smokeTarget,
    readyTiming: {
      mainReadyMs: latestTimingDurationMs(sample, 'main_ready'),
      readyToShowMs: latestTimingDurationMs(sample, 'ready_to_show'),
      rendererLoadedMs: latestTimingDurationMs(sample, 'renderer_loaded'),
      rendererReadyMs,
      mainInputReadyMs
    },
    processMetricsSummary: summarizeProcessMetrics(sample),
    nativeModuleProbe
  };
}

export function buildNativeFeelSoftWarnings({
  initialSample,
  finalSample,
  quickOpenMs,
  warmQuickReopenMs,
  trayOpenMs
}) {
  const warnings = [];
  const readyToShowMs =
    latestTimingDurationMs(finalSample, 'ready_to_show') ?? latestTimingDurationMs(initialSample, 'ready_to_show');
  if (typeof readyToShowMs === 'number' && readyToShowMs > 800) {
    warnings.push(`main ready-to-show took ${readyToShowMs} ms`);
  }
  if (quickOpenMs > 500) {
    warnings.push(`quick entry opened in ${quickOpenMs} ms`);
  }
  if (warmQuickReopenMs > 200) {
    warnings.push(`warm quick entry reopened in ${warmQuickReopenMs} ms`);
  }
  if (trayOpenMs > 1000) {
    warnings.push(`tray entry opened in ${trayOpenMs} ms`);
  }
  return warnings;
}
