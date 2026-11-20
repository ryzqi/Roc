import type {ZoteroAttachmentPicker} from './zotero-attachment-grant-store';

/** Only a trusted renderer owner can open the native single-file input panel. */
export const pickZoteroAttachment: ZoteroAttachmentPicker = async (context, path, signal) => {
  const owner = /^window:([0-9]+)$/u.exec(context.owner);
  if (owner === null) throw new Error('zotero_attachment_window_required');
  const {BrowserWindow, dialog, webContents} = await import('electron');
  const sender = webContents.fromId(Number(owner[1]));
  if (sender === undefined) throw new Error('zotero_attachment_window_required');
  const window = BrowserWindow.fromWebContents(sender);
  if (window === null || window.isDestroyed()) throw new Error('zotero_attachment_window_required');
  signal.throwIfAborted();
  const selection = dialog.showOpenDialog(window, {title: '授权读取 Zotero 附件', buttonLabel: '授权读取',
    defaultPath: path, message: `仅授权读取此附件文件：${path}`, properties: ['openFile']});
  let rejectCancelled!: (reason: unknown) => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancelled = reject;
  });
  const abort = () => rejectCancelled(signal.reason);
  signal.addEventListener('abort', abort, {once: true});
  try {
    const result = await Promise.race([selection, cancelled]);
    signal.throwIfAborted();
    if (result.canceled) return null;
    if (result.filePaths.length !== 1) throw new Error('zotero_attachment_single_file_required');
    return result.filePaths[0]!;
  } finally {signal.removeEventListener('abort', abort);}
};
