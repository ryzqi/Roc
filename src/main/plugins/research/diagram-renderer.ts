import {randomUUID} from 'node:crypto';
import {dirname, join, relative, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {BrowserWindow as ElectronWindow} from 'electron';
import {validateDiagramSource} from '../../../shared/research-diagram-policy';
import {acquireResearchUtility} from './process-runner';

export type DiagramRendering = {svg: string; png: Buffer; pdf: Buffer};
export async function renderResearchDiagram(source: string, sourceHash: string, projectId: string, signal: AbortSignal): Promise<DiagramRendering> {
  validateDiagramSource(source); signal.throwIfAborted();
  const lease = await acquireResearchUtility(projectId, signal);
  let window: ElectronWindow | null = null;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let monitor: ReturnType<typeof setInterval> | undefined;
  const abort = () => { if (window && !window.isDestroyed()) window.destroy(); };
  let deadlineReject: ((error: Error) => void) | undefined;
  const deadline = new Promise<never>((_, reject) => { deadlineReject = reject;
    timer = setTimeout(() => { expired = true; abort(); reject(new Error('research_diagram_timeout')); }, 30_000); });
  const onAbort = () => { expired = true; abort(); deadlineReject?.(new Error('research_diagram_cancelled')); };
  signal.addEventListener('abort', onAbort, {once: true});
  const work = async (): Promise<DiagramRendering> => {
    const {app, BrowserWindow, session} = await import('electron');
    await app.whenReady(); signal.throwIfAborted();
    if (expired) throw new Error('research_diagram_timeout');
    const isolated = session.fromPartition(`roc-diagram-${randomUUID()}`, {cache: false});
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.on('will-download', event => event.preventDefault());
    const rendererRoot = join(dirname(fileURLToPath(import.meta.url)), '../renderer');
    const development = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
    isolated.webRequest.onBeforeRequest((details, callback) => {
      let allowed = false;
      try {
        const url = new URL(details.url);
        if (development) allowed = url.origin === new URL(development).origin && ['mainFrame', 'script', 'stylesheet'].includes(details.resourceType);
        else if (url.protocol === 'file:') {
          const path = relative(rendererRoot, fileURLToPath(url));
          allowed = path !== '' && path !== '..' && !path.startsWith('../') && !isAbsolute(path) &&
            (path === 'diagram-worker.html' || path.startsWith('assets/') && /\.(?:js|css)$/u.test(path));
        }
      } catch { /* All unrecognized URLs are denied. */ }
      callback({cancel: !allowed});
    });
    window = new BrowserWindow({show: false, width: 800, height: 600, webPreferences: {session: isolated,
      sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false,
      backgroundThrottling: false, spellcheck: false, webgl: false}});
    const contents = window.webContents;
    contents.setWindowOpenHandler(() => ({action: 'deny'}));
    contents.on('will-navigate', event => event.preventDefault());
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.on('render-process-gone', () => deadlineReject?.(new Error('research_diagram_renderer_gone')));
    monitor = setInterval(() => {
      if (contents.isDestroyed()) return;
      const metrics = app.getAppMetrics().find(metric => metric.pid === contents.getOSProcessId());
      if (metrics && metrics.memory.workingSetSize > 1024 * 1024) { abort(); deadlineReject?.(new Error('research_diagram_memory_limit')); }
    }, 250);
    if (development) await window.loadURL(new URL('/diagram-worker.html', development).href);
    else await window.loadFile(join(rendererRoot, 'diagram-worker.html'));
    signal.throwIfAborted();
    const result: {svg: string; width: number; height: number} = await contents.executeJavaScript(
      `window.rocRenderDiagram(${JSON.stringify(source)}, ${JSON.stringify(sourceHash)})`);
    if (!result || typeof result.svg !== 'string' || result.svg.length > 4 * 1024 * 1024 ||
      !Number.isInteger(result.width) || !Number.isInteger(result.height) || result.width < 1 || result.height < 1 ||
      result.width > 4096 || result.height > 4096 || result.width * result.height > 12_000_000) throw new Error('research_diagram_output_limit');
    window.setContentSize(result.width, result.height);
    const png = (await contents.capturePage()).toPNG();
    const pdf = await contents.printToPDF({printBackground: true, pageSize: {width: Math.max(0.1, result.width / 96), height: Math.max(0.1, result.height / 96)}, margins: {top: 0, bottom: 0, left: 0, right: 0}});
    if (png.length > 32 * 1024 * 1024 || pdf.length > 32 * 1024 * 1024) throw new Error('research_diagram_output_limit');
    signal.throwIfAborted();
    return {svg: result.svg, png, pdf};
  };
  try { return await Promise.race([work(), deadline]); }
  finally { clearTimeout(timer); clearInterval(monitor); signal.removeEventListener('abort', onAbort); abort(); lease.release(); }
}
