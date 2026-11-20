import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {readFileSync, rmSync} from 'node:fs';
import {build} from 'esbuild';
import electron from 'electron';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {directory, EVAL_ROOT, ROOT} from './common.mjs';

// Protocol allowlist, mirrored by configured-retrieval.ts. Never relay native,
// credential, URL, response-body, or arbitrary provider error strings.
const codes = new Set([
  'roc_retrieval_options_invalid', 'roc_retrieval_database_unavailable', 'roc_retrieval_database_busy',
  'roc_retrieval_configuration_invalid', 'roc_retrieval_embedding_unavailable', 'roc_retrieval_embedding_disabled',
  'roc_retrieval_reranker_unavailable', 'roc_retrieval_reranker_disabled', 'roc_retrieval_credential_missing',
  'roc_retrieval_credential_unavailable', 'roc_retrieval_secret_storage_unavailable', 'roc_retrieval_input_invalid',
  'roc_retrieval_embedding_failed', 'roc_retrieval_reranker_failed', 'roc_retrieval_cancelled', 'roc_retrieval_timeout', 'roc_retrieval_closed',
  'roc_retrieval_protocol_invalid', 'roc_retrieval_host_failed', 'roc_retrieval_host_unavailable', 'roc_retrieval_host_timeout'
]);
const failure = code => Object.assign(new Error(code), {code});
const object = (value, keys, optional = false) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key)) && (optional || keys.every(key => Object.hasOwn(value, key)));
const text = (value, limit = 200) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/u.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const sameCorrelation = (a, b) => object(a, ['trialId', 'requestId', 'requestHash'])
  && ['trialId', 'requestId', 'requestHash'].every(key => a[key] === b[key]);

function correlation(value = {}) {
  if (!object(value, ['trialId', 'requestId', 'requestHash'], true)
    || ['trialId', 'requestId'].some(key => value[key] != null && !text(value[key], 256))
    || (value.requestHash != null && !digest(value.requestHash))) throw failure('roc_retrieval_input_invalid');
  return {trialId: value.trialId ?? null, requestId: value.requestId ?? null, requestHash: value.requestHash ?? null};
}
function selection({embeddingConfigId = null, mode = 'bm25', rerank = 'none'} = {}) {
  if ((embeddingConfigId !== null && !text(embeddingConfigId)) || !['bm25', 'hybrid'].includes(mode)
    || !['none', 'semantic'].includes(rerank)) throw failure('roc_retrieval_options_invalid');
  return {embeddingConfigId: embeddingConfigId?.trim() ?? null, mode, rerank};
}
function identity(value) {
  if (!object(value, ['embedding', 'reranker'])) throw failure('roc_retrieval_protocol_invalid');
  const e = value.embedding, r = value.reranker;
  if (e !== null && (!object(e, ['id', 'model', 'dimensions', 'revision', 'configurationHash'])
    || !text(e.id) || !text(e.model) || !positive(e.dimensions) || !positive(e.revision) || !digest(e.configurationHash))) {
    throw failure('roc_retrieval_protocol_invalid');
  }
  if (r !== null && (!object(r, ['model', 'configurationHash', 'timeoutMs']) || !text(r.model)
    || !digest(r.configurationHash) || !Number.isInteger(r.timeoutMs) || r.timeoutMs < 100 || r.timeoutMs > 10000)) {
    throw failure('roc_retrieval_protocol_invalid');
  }
  return Object.freeze({
    embedding: e === null ? null : Object.freeze({id: e.id, model: e.model, dimensions: e.dimensions,
      revision: e.revision, configurationHash: e.configurationHash}),
    reranker: r === null ? null : Object.freeze({model: r.model, configurationHash: r.configurationHash, timeoutMs: r.timeoutMs})
  });
}
function result(body, request, configuredIdentity) {
  if (request.type === 'embed') {
    if (!configuredIdentity.embedding || !Array.isArray(body) || body.length !== request.texts.length
      || body.some(vector => !Array.isArray(vector) || vector.length !== configuredIdentity.embedding.dimensions
        || vector.some(value => typeof value !== 'number' || !Number.isFinite(value)))) {
      throw failure('roc_retrieval_protocol_invalid');
    }
    return body;
  }
  if (!object(body, ['scores', 'receipt']) || !object(body.receipt, ['status', 'model', 'configHash', 'elapsedMs'])) {
    throw failure('roc_retrieval_protocol_invalid');
  }
  const {scores, receipt} = body, configured = configuredIdentity.reranker;
  if (!['not_requested', 'config_missing', 'disabled', 'timeout', 'failed', 'succeeded'].includes(receipt.status)
    || typeof receipt.elapsedMs !== 'number' || !Number.isFinite(receipt.elapsedMs) || receipt.elapsedMs < 0
    || receipt.model !== (configured?.model ?? null) || receipt.configHash !== (configured?.configurationHash ?? null)
    || (configured === null) !== (receipt.status === 'not_requested')
    || (scores === null ? receipt.status === 'succeeded' : receipt.status !== 'succeeded' || !Array.isArray(scores)
      || scores.length !== request.documents.length || scores.some(score => typeof score !== 'number'
        || !Number.isFinite(score) || score < 0 || score > 1))) throw failure('roc_retrieval_protocol_invalid');
  return {scores, receipt};
}
const cancellation = signal => signal?.reason?.name === 'TimeoutError' ? 'roc_retrieval_timeout' : 'roc_retrieval_cancelled';

/**
 * Stream/process seam for offline tests. Production callers use openRocRetrieval.
 * Correlation travels through IPC only; usage in every operation reply is null.
 * A request that fails or loses its host is never replayed automatically.
 */
export async function connectRocRetrieval(child, options = {}, closeHost = async () => {}) {
  if (!object(options, ['rocRoot', 'embeddingConfigId', 'mode', 'rerank', 'signal'], true)
    || typeof closeHost !== 'function' || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
    throw failure('roc_retrieval_options_invalid');
  }
  const configured = selection(options);
  if (typeof options.rocRoot !== 'string' || !options.rocRoot.trim()) throw failure('roc_retrieval_options_invalid');
  let nextId = 0, active = null, closed = false, closing, received = 0, configuredIdentity;
  const queue = [];
  const settle = (item, error, value) => {
    clearTimeout(item.timeout); clearTimeout(item.cancelTimeout);
    item.signal?.removeEventListener('abort', item.abort);
    item.done = true;
    if (item.delivered) return;
    item.delivered = true;
    if (error) item.reject(error); else item.resolve(value);
  };
  const rejectAll = code => {
    if (closed) return;
    closed = true;
    if (active) settle(active, failure(code));
    active = null;
    for (const item of queue.splice(0)) settle(item, failure(code));
    void close().catch(() => {});
  };
  const unavailable = () => rejectAll('roc_retrieval_host_unavailable');
  const countBytes = bytes => {
    received += bytes.length;
    if (received > 32 * 1024 * 1024) rejectAll('roc_retrieval_protocol_invalid');
  };
  child.once('error', unavailable); child.once('close', unavailable);
  child.stdin.on('error', unavailable); child.stdout.on('error', unavailable);
  child.stdout.on('end', unavailable); child.stdout.on('data', countBytes);
  const lines = createInterface({input: child.stdout});
  const write = value => {
    try { child.stdin.write(`${JSON.stringify(value)}\n`, error => {if (error) unavailable();}); }
    catch { unavailable(); }
  };
  const pump = () => {
    if (closed || active || queue.length === 0) return;
    active = queue.shift(); received = 0;
    active.timeout = setTimeout(() => rejectAll('roc_retrieval_host_timeout'), active.request.type === 'init' ? 30000 : 70000);
    active.timeout.unref();
    write(active.request);
  };
  const close = () => closing ??= (async () => {
    closed = true;
    if (active) settle(active, failure('roc_retrieval_closed'));
    active = null;
    for (const item of queue.splice(0)) settle(item, failure('roc_retrieval_closed'));
    let failed = false;
    try { child.stdin.end(); } catch { failed = true; }
    try { await closeHost(); }
    catch { failed = true; }
    finally {
      lines.close(); child.stdin.destroy(); child.stdout.destroy();
      // Retain the no-op error handlers on stopped streams/processes: an EPIPE
      // or delayed spawn error after cleanup must not become an uncaught error.
      child.removeListener('close', unavailable);
      child.stdout.removeListener('end', unavailable); child.stdout.removeListener('data', countBytes);
    }
    if (failed) throw failure('roc_retrieval_host_failed');
  })();
  lines.on('line', line => {
    if (closed) return;
    try {
      const message = JSON.parse(line), pending = active;
      if (object(message, ['type', 'id', 'usage', 'code']) && message.type === 'error' && message.id === null
        && message.usage === null) {
        rejectAll(codes.has(message.code) ? message.code : 'roc_retrieval_host_failed');
        return;
      }
      if (!pending || !object(message, message.type === 'ready' ? ['type', 'id', 'identity']
        : message.type === 'response' ? ['type', 'id', 'operation', 'correlation', 'usage', 'body']
          : ['type', 'id', 'operation', 'correlation', 'usage', 'code'])
        || message.id !== pending.request.id) throw failure('roc_retrieval_protocol_invalid');
      if (message.type === 'error') {
        if (message.operation !== pending.request.type || message.usage !== null
          || !sameCorrelation(message.correlation, pending.request.correlation ?? correlation())) throw failure('roc_retrieval_protocol_invalid');
        settle(pending, failure(codes.has(message.code) ? message.code : 'roc_retrieval_host_failed'));
      } else if (pending.request.type === 'init') {
        if (message.type !== 'ready') throw failure('roc_retrieval_protocol_invalid');
        configuredIdentity = identity(message.identity);
        if ((configured.mode === 'hybrid') !== (configuredIdentity.embedding !== null)
          || (configured.rerank === 'semantic') !== (configuredIdentity.reranker !== null)) throw failure('roc_retrieval_protocol_invalid');
        settle(pending, null, configuredIdentity);
      } else {
        if (message.type !== 'response' || message.operation !== pending.request.type || message.usage !== null
          || !sameCorrelation(message.correlation, pending.request.correlation)) throw failure('roc_retrieval_protocol_invalid');
        settle(pending, null, result(message.body, pending.request, configuredIdentity));
      }
      active = null; pump();
    } catch { rejectAll('roc_retrieval_protocol_invalid'); }
  });
  async function request(payload, signal) {
    if (closed) throw failure('roc_retrieval_closed');
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw failure('roc_retrieval_input_invalid');
    if (signal?.aborted) throw failure(cancellation(signal));
    let frozen;
    try {
      const serialized = JSON.stringify({...payload, id: ++nextId});
      if (Buffer.byteLength(serialized) > 16 * 1024 * 1024) throw failure('roc_retrieval_input_invalid');
      frozen = JSON.parse(serialized);
    } catch { throw failure('roc_retrieval_input_invalid'); }
    return await new Promise((resolveRequest, rejectRequest) => {
      const item = {request: frozen, signal, resolve: resolveRequest, reject: rejectRequest, done: false, delivered: false};
      item.abort = () => {
        if (item.done) return;
        const error = failure(cancellation(signal));
        if (active === item) {
          if (!item.delivered) {item.delivered = true; item.reject(error);}
          write({type: 'cancel', id: item.request.id});
          // Wait for its terminal reply before admitting the next queued call.
          item.cancelTimeout = setTimeout(() => rejectAll('roc_retrieval_host_unavailable'), 2000);
          item.cancelTimeout.unref();
        } else {
          const index = queue.indexOf(item);
          if (index >= 0) queue.splice(index, 1);
          settle(item, error);
        }
      };
      signal?.addEventListener('abort', item.abort, {once: true});
      queue.push(item); pump();
    });
  }
  try {
    await request({type: 'init', rocRoot: resolve(options.rocRoot), selection: configured}, options.signal);
    return {
      identity: configuredIdentity,
      embed: async (texts, signal, requestOptions) => {
        if (!Array.isArray(texts) || texts.some(value => typeof value !== 'string')) throw failure('roc_retrieval_input_invalid');
        return await request({type: 'embed', texts, correlation: correlation(requestOptions)}, signal);
      },
      rerank: async (query, documents, signal, requestOptions) => {
        if (typeof query !== 'string' || !Array.isArray(documents) || documents.some(value => typeof value !== 'string')) {
          throw failure('roc_retrieval_input_invalid');
        }
        return await request({type: 'rerank', query, documents, correlation: correlation(requestOptions)}, signal);
      },
      close
    };
  } catch (error) {
    try { await close(); } catch { /* Preserve the original redacted failure. */ }
    throw failure(codes.has(error?.code) ? error.code : 'roc_retrieval_host_failed');
  }
}

const applicationPackage = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const applicationName = applicationPackage.productName ?? applicationPackage.name;

/** Read-only production embedding/reranker transport in an isolated Electron host. */
export async function openRocRetrieval(options = {}) {
  if (!object(options, ['rocRoot', 'appName', 'embeddingConfigId', 'mode', 'rerank', 'signal'], true)) {
    throw failure('roc_retrieval_options_invalid');
  }
  const {rocRoot = process.env.ROC_DATA_ROOT ?? join(homedir(), '.roc'), appName = applicationName,
    embeddingConfigId = null, mode = 'bm25', rerank = 'none', signal} = options;
  selection({embeddingConfigId, mode, rerank});
  if (typeof rocRoot !== 'string' || !rocRoot.trim() || typeof appName !== 'string' || !appName.trim()
    || appName.length > 80 || /[\u0000-\u001f\u007f]/u.test(appName)
    || (signal !== undefined && !(signal instanceof AbortSignal))) throw failure('roc_retrieval_options_invalid');
  if (signal?.aborted) throw failure(cancellation(signal));
  let root, child;
  try {
    root = directory(join(EVAL_ROOT, '.runtime/retrieval-hosts'), 'host');
    const path = join(root, 'host.mjs');
    await build({entryPoints: [join(EVAL_ROOT, 'runtime/retrieval-host.ts')], outfile: path,
      bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent'});
    const {terminateProcessTreeWithRetry} = await importTypeScriptModule(join(ROOT, 'src/main/services/process-tree.ts'), {platform: 'node'});
    child = spawn(electron, [path, root, appName], {cwd: root, detached: true, stdio: ['pipe', 'pipe', 'ignore'],
      env: {PATH: '/usr/bin:/bin', HOME: homedir(), TMPDIR: root, LANG: 'en_US.UTF-8',
        LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false'}});
    return await connectRocRetrieval(child, {rocRoot, embeddingConfigId, mode, rerank, signal}, async () => {
      try { await terminateProcessTreeWithRetry(child); }
      finally { rmSync(root, {recursive: true, force: true}); }
    });
  } catch (error) {
    if (!child && root) {
      try {rmSync(root, {recursive: true, force: true});} catch {throw failure('roc_retrieval_host_failed');}
    }
    throw failure(codes.has(error?.code) ? error.code : 'roc_retrieval_host_failed');
  }
}
