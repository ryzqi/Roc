import {mkdirSync} from 'node:fs';
import {isAbsolute, join, resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import {
  openConfiguredRetrieval, redactedRetrievalCode, retrievalCorrelation, retrievalError, retrievalSelection,
  type ConfiguredRetrieval, type RetrievalSelection
} from './configured-retrieval';

const ipcId = z.number().int().positive();
const requestSchema = z.discriminatedUnion('type', [
  z.object({type: z.literal('init'), id: ipcId, rocRoot: z.string().min(1), selection: z.unknown().optional()}).strict(),
  z.object({type: z.literal('embed'), id: ipcId, texts: z.array(z.string()), correlation: z.unknown().optional()}).strict(),
  z.object({type: z.literal('rerank'), id: ipcId, query: z.string(), documents: z.array(z.string()),
    correlation: z.unknown().optional()}).strict(),
  z.object({type: z.literal('cancel'), id: ipcId}).strict(),
  z.object({type: z.literal('close')}).strict()
]);
type Request = z.infer<typeof requestSchema>;
type Operation = Exclude<Request, {type: 'cancel' | 'close'}>;
type Open = (root: string, selection: RetrievalSelection) => Promise<ConfiguredRetrieval>;

/**
 * Serializes operations while still reading cancel/close messages during a
 * pending fetch. The test seam uses in-memory streams and production clients
 * with fake fetch; it never needs Electron, a keychain, or a listening socket.
 */
export async function serveRetrievalHost(
  input: AsyncIterable<string>, send: (message: unknown) => void, open: Open
): Promise<void> {
  let retrieval: ConfiguredRetrieval | undefined, initialized = false, closed = false;
  let queue = Promise.resolve();
  const controllers = new Map<number, AbortController>(), seen = new Set<number>();
  const stop = (): void => {
    closed = true;
    for (const controller of controllers.values()) controller.abort();
  };
  const emit = (message: unknown): void => {
    try { send(message); } catch { stop(); }
  };
  const enqueue = (request: Operation): void => {
    const controller = new AbortController(), correlation = request.type === 'init'
      ? retrievalCorrelation() : retrievalCorrelation(request.correlation);
    controllers.set(request.id, controller);
    queue = queue.then(async () => {
      try {
        if (closed) throw retrievalError('roc_retrieval_closed');
        if (controller.signal.aborted) throw retrievalError('roc_retrieval_cancelled');
        if (request.type === 'init') {
          if (initialized) throw retrievalError('roc_retrieval_protocol_invalid');
          initialized = true;
          retrieval = await open(request.rocRoot, retrievalSelection(request.selection));
          if (closed || controller.signal.aborted) throw retrievalError('roc_retrieval_cancelled');
          emit({type: 'ready', id: request.id, identity: retrieval.identity});
        } else {
          if (!retrieval) throw retrievalError('roc_retrieval_host_unavailable');
          const body = request.type === 'embed'
            ? await retrieval.embed(request.texts, controller.signal, correlation)
            : await retrieval.rerank(request.query, request.documents, controller.signal, correlation);
          if (controller.signal.aborted) throw retrievalError('roc_retrieval_cancelled');
          emit({type: 'response', id: request.id, operation: request.type, correlation, usage: null, body});
        }
      } catch (error) {
        emit({type: 'error', id: request.id, operation: request.type, correlation, usage: null,
          code: redactedRetrievalCode(error)});
      } finally { controllers.delete(request.id); }
    });
  };
  try {
    for await (const line of input) {
      if (closed) break;
      let request: Request;
      try {
        if (Buffer.byteLength(line, 'utf8') > 16 * 1024 * 1024) throw retrievalError('roc_retrieval_protocol_invalid');
        request = requestSchema.parse(JSON.parse(line));
        if (request.type !== 'cancel' && request.type !== 'close') {
          if (seen.has(request.id)) throw retrievalError('roc_retrieval_protocol_invalid');
          seen.add(request.id);
        }
        if (request.type === 'close') break;
        if (request.type === 'cancel') controllers.get(request.id)?.abort();
        else enqueue(request);
      } catch {
        emit({type: 'error', id: null, code: 'roc_retrieval_protocol_invalid', usage: null});
        break;
      }
    }
  } catch { emit({type: 'error', id: null, code: 'roc_retrieval_host_failed', usage: null}); }
  finally {
    stop(); await queue;
    try { await retrieval?.close(); } catch { emit({type: 'error', id: null, code: 'roc_retrieval_host_failed', usage: null}); }
  }
}

type HostApplication = {
  setName(name: string): void;
  setPath(name: 'userData' | 'sessionData' | 'logs' | 'crashDumps', path: string): void;
  disableHardwareAcceleration(): void;
};
export function configureRetrievalApplication(application: HostApplication, root: string, appName: string): void {
  if (typeof root !== 'string' || !isAbsolute(root) || typeof appName !== 'string'
    || !appName.trim() || appName.length > 80 || /[\u0000-\u001f\u007f]/u.test(appName)) {
    throw retrievalError('roc_retrieval_options_invalid');
  }
  // macOS safeStorage derives its keychain namespace before app readiness.
  try {
    application.setName(appName);
    for (const name of ['userData', 'sessionData', 'logs', 'crashDumps'] as const) {
      const path = join(root, name);
      mkdirSync(path, {recursive: true, mode: 0o700}); application.setPath(name, path);
    }
    application.disableHardwareAcceleration();
  } catch {
    throw retrievalError('roc_retrieval_host_failed');
  }
}

async function main(): Promise<void> {
  // Never start Roc, a renderer, the plugin kernel, a production DB connection,
  // a trace sink, or credential write APIs. Raw provider/native errors stay here.
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) console[method] = () => {};
  const send = (message: unknown): void => { process.stdout.write(`${JSON.stringify(message)}\n`); };
  let lines: ReturnType<typeof createInterface> | undefined;
  let stopping = false;
  const stop = (): void => { stopping = true; lines?.close(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    const {app, safeStorage} = await import('electron');
    const root = resolve(process.argv[2]!);
    configureRetrievalApplication(app, root, process.argv[3]!);
    await app.whenReady(); app.dock?.hide();
    if (stopping) { app.exit(0); return; }
    lines = createInterface({input: process.stdin});
    await serveRetrievalHost(lines, send, (rocRoot, selection) => openConfiguredRetrieval(rocRoot, {
      isEncryptionAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
      encryptString: async () => {throw retrievalError('roc_retrieval_closed');},
      decryptString: async bytes => {
        const value = await safeStorage.decryptStringAsync(bytes);
        return {plaintext: value.result, shouldReEncrypt: false};
      }
    }, selection, {snapshotParent: root}));
    app.exit(0);
  } catch (error) {
    send({type: 'error', id: null, usage: null, code: redactedRetrievalCode(error)});
    const {app} = await import('electron');
    app.exit(2);
  } finally {
    lines?.close();
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
