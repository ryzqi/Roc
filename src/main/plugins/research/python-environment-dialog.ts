export type PythonEnvironmentPicker = (owner: string, signal: AbortSignal) => Promise<string | null>;

/** Preserve venv interpreter aliases: resolving them in the panel loses the selected prefix. */
export const pickPythonEnvironment: PythonEnvironmentPicker = async (owner, signal) => {
  const identity = /^window:([1-9][0-9]*)$/u.exec(owner);
  if (identity === null) throw new Error('research_python_selection_window_required');
  const { BrowserWindow, dialog, webContents } = await import('electron');
  const sender = webContents.fromId(Number(identity[1]));
  if (sender === undefined) throw new Error('research_python_selection_window_required');
  const window = BrowserWindow.fromWebContents(sender);
  if (window === null || window.isDestroyed()) throw new Error('research_python_selection_window_required');
  signal.throwIfAborted();
  const selection = dialog.showOpenDialog(window, {
    title: '选择此项目的 Python 环境', buttonLabel: '选择并核验',
    message: '选择已有 CPython 3.14 环境中 bin/python、python3 或 python3.14。核验会运行隔离探针；不会安装依赖。',
    properties: ['openFile', 'noResolveAliases', 'showHiddenFiles']
  });
  let rejectCancelled!: (reason: unknown) => void;
  const cancelled = new Promise<never>((_resolve, reject) => { rejectCancelled = reject; });
  const abort = () => rejectCancelled(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  try {
    const result = await Promise.race([selection, cancelled]);
    signal.throwIfAborted();
    if (result.canceled) return null;
    if (result.filePaths.length !== 1) throw new Error('research_python_selection_single_file_required');
    return result.filePaths[0]!;
  } finally { signal.removeEventListener('abort', abort); }
};
