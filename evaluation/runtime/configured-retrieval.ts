import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readSync, realpathSync, rmSync, writeSync, type BigIntStats
} from 'node:fs';
import {tmpdir} from 'node:os';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';
import {z} from 'zod';
import {ConfigStore} from '../../src/main/infrastructure/config-store';
import {SecretManager} from '../../src/main/infrastructure/secret-manager';
import type {SafeStorageBackend} from '../../src/main/infrastructure/safe-storage-backend';
import {OpenAICompatibleEmbeddingClient, type EmbeddingFetch} from '../../src/main/plugins/research/embedding-client';
import {ResearchKnowledgeRepository} from '../../src/main/plugins/research/knowledge-repository';
import {ResearchRerankerService} from '../../src/main/plugins/research/reranker-service';
import {rerankerSettingsSchema, type RerankerReceipt} from '../../src/shared/schemas/research-reranker';
import type {ResearchEmbeddingConfig} from '../../src/shared/types/research';

export const retrievalErrorCodes = [
  'roc_retrieval_options_invalid', 'roc_retrieval_database_unavailable', 'roc_retrieval_database_busy',
  'roc_retrieval_configuration_invalid', 'roc_retrieval_embedding_unavailable', 'roc_retrieval_embedding_disabled',
  'roc_retrieval_reranker_unavailable', 'roc_retrieval_reranker_disabled', 'roc_retrieval_credential_missing',
  'roc_retrieval_credential_unavailable', 'roc_retrieval_secret_storage_unavailable', 'roc_retrieval_input_invalid',
  'roc_retrieval_embedding_failed', 'roc_retrieval_reranker_failed', 'roc_retrieval_cancelled', 'roc_retrieval_timeout', 'roc_retrieval_closed',
  'roc_retrieval_protocol_invalid', 'roc_retrieval_host_failed', 'roc_retrieval_host_unavailable',
  'roc_retrieval_host_timeout'
] as const;
export type RetrievalErrorCode = typeof retrievalErrorCodes[number];

class RetrievalError extends Error {
  constructor(readonly code: RetrievalErrorCode) { super(code); }
}
export const retrievalError = (code: RetrievalErrorCode): Error => new RetrievalError(code);
export function redactedRetrievalCode(error: unknown, fallback: RetrievalErrorCode = 'roc_retrieval_host_failed'): RetrievalErrorCode {
  return error instanceof RetrievalError ? error.code : fallback;
}

const publicString = z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/u);
const correlationString = z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/u)
  .refine(value => value.trim().length > 0);
const secretReference = z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/u);
const endpoint = z.url().refine(value => {
  const url = new URL(value);
  return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.hash;
});
const selectionSchema = z.object({
  embeddingConfigId: publicString.nullable().default(null),
  mode: z.enum(['bm25', 'hybrid']).default('bm25'),
  rerank: z.enum(['none', 'semantic']).default('none')
}).strict();
export type RetrievalSelection = z.input<typeof selectionSchema>;
export type RetrievalIdentity = {
  embedding: {id: string; model: string; dimensions: number; revision: number; configurationHash: string} | null;
  reranker: {model: string; configurationHash: string; timeoutMs: number} | null;
};
export type RetrievalCorrelation = {trialId: string | null; requestId: string | null; requestHash: string | null};
const correlationSchema = z.object({
  trialId: correlationString.nullable().default(null),
  requestId: correlationString.nullable().default(null),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable().default(null)
}).strict();
export function retrievalCorrelation(value: unknown = {}): RetrievalCorrelation {
  const parsed = correlationSchema.safeParse(value);
  if (!parsed.success) throw retrievalError('roc_retrieval_input_invalid');
  return parsed.data;
}
export function retrievalSelection(value: unknown = {}): z.output<typeof selectionSchema> {
  const parsed = selectionSchema.safeParse(value);
  if (!parsed.success) throw retrievalError('roc_retrieval_options_invalid');
  return parsed.data;
}

export type ConfiguredRetrieval = {
  readonly identity: RetrievalIdentity;
  embed(texts: readonly string[], signal?: AbortSignal, correlation?: Partial<RetrievalCorrelation>): Promise<number[][]>;
  rerank(query: string, documents: readonly string[], signal?: AbortSignal, correlation?: Partial<RetrievalCorrelation>): Promise<{
    scores: number[] | null; receipt: RerankerReceipt
  }>;
  close(): Promise<void>;
};
export type ConfiguredRetrievalDependencies = {
  embeddingFetch?: EmbeddingFetch;
  rerankerFetch?: typeof fetch;
  snapshotParent?: string;
};
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pluginId = '@roc/plugin-research';
const storedRerankerSchema = rerankerSettingsSchema.extend({endpoint, model: publicString, secretKey: secretReference});
const embeddingRowSchema = z.object({
  id: publicString, name: z.string(), base_url: endpoint, model: publicString,
  dimensions: z.number().int().positive(), api_key_secret_key: secretReference,
  enabled: z.union([z.literal(0), z.literal(1)]), updated_at: z.string(), revision: z.number().int().positive()
}).strict();

function signature(stat: BigIntStats | null): string {
  return stat === null ? 'absent' : [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}
function sourceStat(path: string, optional = false): BigIntStats | null {
  try {
    const stat = lstatSync(path, {bigint: true});
    if (!stat.isFile() || stat.isSymbolicLink()) throw retrievalError('roc_retrieval_database_unavailable');
    return stat;
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw retrievalError('roc_retrieval_database_unavailable');
  }
}
function copyDescriptor(source: number, destination: string, bytes: bigint): void {
  if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) throw retrievalError('roc_retrieval_database_unavailable');
  const limit = Number(bytes);
  const target = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (let offset = 0; offset < limit;) {
      const count = readSync(source, buffer, 0, Math.min(buffer.length, limit - offset), offset);
      if (count === 0) throw retrievalError('roc_retrieval_database_busy');
      let written = 0;
      while (written < count) written += writeSync(target, buffer, written, count - written);
      offset += count;
    }
  } finally { closeSync(target); }
}

// Never open SQLite on a production path: even mode=ro can create/rebuild -shm.
// Copy stable DB + WAL bytes using O_RDONLY descriptors, then let SQLite read
// only the private copies. Refuse a racing checkpoint/commit or hot journal.
function snapshotDatabase(source: string, destination: string): void {
  for (let attempt = 0; attempt < 3; attempt++) {
    const paths = [source, `${source}-wal`, `${source}-journal`];
    const before = paths.map((path, index) => sourceStat(path, index !== 0));
    if (before[2] !== null && before[2]!.size > 0n) throw retrievalError('roc_retrieval_database_busy');
    const descriptors: number[] = [];
    let stable = false;
    try {
      for (let index = 0; index < 2; index++) {
        if (before[index] === null) continue;
        const fd = openSync(paths[index]!, constants.O_RDONLY | constants.O_NOFOLLOW);
        descriptors.push(fd);
        if (signature(fstatSync(fd, {bigint: true})) !== signature(before[index]!)) break;
        copyDescriptor(fd, index === 0 ? destination : `${destination}-wal`, before[index]!.size);
      }
      const after = paths.map((path, index) => sourceStat(path, index !== 0));
      stable = descriptors.length === before.slice(0, 2).filter(stat => stat !== null).length
        && before.every((stat, index) => signature(stat) === signature(after[index]!))
        && descriptors.every(fd => {
          const stat = fstatSync(fd, {bigint: true});
          return before.some(entry => signature(entry) === signature(stat));
        });
    } catch (error) {
      throw retrievalError(redactedRetrievalCode(error, 'roc_retrieval_database_unavailable'));
    } finally {
      for (const fd of descriptors) {
        try { closeSync(fd); } catch { throw retrievalError('roc_retrieval_database_unavailable'); }
      }
    }
    if (stable) return;
    rmSync(destination, {force: true}); rmSync(`${destination}-wal`, {force: true});
  }
  throw retrievalError('roc_retrieval_database_busy');
}
function productionPath(root: string, components: string[]): string {
  let path = root;
  for (const component of components.slice(0, -1)) {
    path = join(path, component);
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw retrievalError('roc_retrieval_database_unavailable');
  }
  return join(path, components.at(-1)!);
}
function outside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * Privileged factory used only by retrieval-host. Reads a frozen production
 * configuration and plugin secrets without initialization, migrations,
 * caches, trace sinks, credential rotation, or dimension probes.
 */
export async function openConfiguredRetrieval(
  rocRoot: string, storage: SafeStorageBackend, rawSelection: RetrievalSelection = {}, dependencies: ConfiguredRetrievalDependencies = {}
): Promise<ConfiguredRetrieval> {
  if (typeof rocRoot !== 'string' || !rocRoot.trim()) throw retrievalError('roc_retrieval_options_invalid');
  const selection = retrievalSelection(rawSelection);
  let embeddingConfig: ResearchEmbeddingConfig | null = null, embeddingKey: string | null = null;
  let rerankerConfig: z.infer<typeof storedRerankerSchema> | null = null, rerankerKey: string | null = null;
  const identity: RetrievalIdentity = {embedding: null, reranker: null};
  if (selection.mode === 'hybrid' || selection.rerank === 'semantic') {
    let scratch: string | undefined;
    let failure: RetrievalErrorCode | undefined;
    const databases: Database.Database[] = [];
    try {
      const root = realpathSync(resolve(rocRoot));
      const parent = realpathSync(dependencies.snapshotParent ?? tmpdir());
      if (!outside(root, parent)) throw retrievalError('roc_retrieval_options_invalid');
      scratch = mkdtempSync(join(parent, 'roc-retrieval-'));
      // mkdtemp is private; SQLite auxiliaries remain beneath this directory.
      mkdirSync(join(scratch, 'databases'), {mode: 0o700});
      const readDatabase = (parts: string[], name: string): Database.Database => {
        const copy = join(scratch!, 'databases', name);
        snapshotDatabase(productionPath(root, parts), copy);
        const db = new Database(copy, {readonly: true, fileMustExist: true});
        databases.push(db); db.pragma('query_only = ON');
        return db;
      };
      const core = readDatabase(['data', 'core.db'], 'core.db');
      const readonlyStorage: SafeStorageBackend = {
        isEncryptionAvailable: async () => {
          try {
            if (!await storage.isEncryptionAvailable()) throw retrievalError('roc_retrieval_secret_storage_unavailable');
            return true;
          } catch (error) { throw retrievalError(redactedRetrievalCode(error, 'roc_retrieval_credential_unavailable')); }
        },
        encryptString: async () => { throw retrievalError('roc_retrieval_closed'); },
        decryptString: async encrypted => {
          try {
            const result = await storage.decryptString(encrypted);
            if (typeof result.plaintext !== 'string') throw retrievalError('roc_retrieval_credential_unavailable');
            // SecretManager otherwise performs an UPDATE when keys rotate.
            return {plaintext: result.plaintext, shouldReEncrypt: false};
          } catch { throw retrievalError('roc_retrieval_credential_unavailable'); }
        }
      };
      const secrets = new SecretManager(core, readonlyStorage).createPluginSecretFacade(pluginId);
      const requireSecret = async (key: string): Promise<string> => {
        const value = await secrets.get(key);
        if (value === null || !value.trim()) throw retrievalError('roc_retrieval_credential_missing');
        return value;
      };
      if (selection.mode === 'hybrid') {
        const db = readDatabase(['data', 'plugins', '@roc', 'plugin-research.db'], 'research.db');
        const repository = new ResearchKnowledgeRepository(db, () => {
          throw retrievalError('roc_retrieval_input_invalid');
        }, () => { throw retrievalError('roc_retrieval_closed'); });
        const rows = repository.listEmbeddingConfigRows();
        const selected = selection.embeddingConfigId === null
          ? rows.find(row => row.enabled === 1) : rows.find(row => row.id === selection.embeddingConfigId);
        if (!selected) throw retrievalError('roc_retrieval_embedding_unavailable');
        if (selected.enabled !== 1) throw retrievalError('roc_retrieval_embedding_disabled');
        const row = embeddingRowSchema.parse(repository.requireEmbeddingConfig(selected.id, selected.revision));
        embeddingKey = await requireSecret(row.api_key_secret_key);
        embeddingConfig = {id: row.id, name: row.name, baseUrl: row.base_url, model: row.model,
          dimensions: row.dimensions, keyConfigured: true, enabled: true, updatedAt: row.updated_at};
        identity.embedding = {id: row.id, model: row.model, dimensions: row.dimensions, revision: row.revision,
          configurationHash: hash({id: row.id, baseUrl: row.base_url, model: row.model, dimensions: row.dimensions,
            revision: row.revision, secretKey: row.api_key_secret_key})};
      }
      if (selection.rerank === 'semantic') {
        let config: unknown;
        try { config = new ConfigStore(core).createPluginConfigFacade(pluginId).get<unknown>('research.reranker'); }
        catch { throw retrievalError('roc_retrieval_configuration_invalid'); }
        if (config === null) throw retrievalError('roc_retrieval_reranker_unavailable');
        rerankerConfig = storedRerankerSchema.parse(config);
        if (!rerankerConfig.enabled) throw retrievalError('roc_retrieval_reranker_disabled');
        rerankerKey = await requireSecret(rerankerConfig.secretKey);
        identity.reranker = {model: rerankerConfig.model, configurationHash: hash(rerankerConfig),
          timeoutMs: rerankerConfig.timeoutMs};
      }
    } catch (error) {
      embeddingKey = null; rerankerKey = null;
      failure = redactedRetrievalCode(error,
        error instanceof z.ZodError ? 'roc_retrieval_configuration_invalid' : 'roc_retrieval_database_unavailable');
    } finally {
      for (const db of databases) {
        try { db.close(); } catch { failure ??= 'roc_retrieval_database_unavailable'; }
      }
      if (scratch) {
        try { rmSync(scratch, {recursive: true, force: true}); }
        catch { failure ??= 'roc_retrieval_database_unavailable'; }
      }
    }
    if (failure) {
      embeddingKey = null; rerankerKey = null;
      throw retrievalError(failure);
    }
  }
  Object.freeze(identity.embedding); Object.freeze(identity.reranker); Object.freeze(identity);
  const embeddings = new OpenAICompatibleEmbeddingClient(dependencies.embeddingFetch);
  const reranker = new ResearchRerankerService({
    config: {get: <T,>() => rerankerConfig as T | null, set: () => {throw retrievalError('roc_retrieval_closed');}},
    secrets: {get: async key => key === rerankerConfig?.secretKey ? rerankerKey : null,
      set: async () => {throw retrievalError('roc_retrieval_closed');}, clear: () => {throw retrievalError('roc_retrieval_closed');}},
    logger: {info: () => {}, warn: () => {}, error: () => {}}
  }, dependencies.rerankerFetch);
  const lifetime = new AbortController(), tasks = new Set<Promise<unknown>>();
  let closed = false, closing: Promise<void> | undefined;
  const execute = async <T,>(
    kind: 'embed' | 'rerank', signal: AbortSignal | undefined, operation: (active: AbortSignal) => Promise<T>
  ): Promise<T> => {
    if (closed) throw retrievalError('roc_retrieval_closed');
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw retrievalError('roc_retrieval_input_invalid');
    const active = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    const task = (async () => {
      try {
        active.throwIfAborted();
        const value = await operation(active);
        active.throwIfAborted();
        return value;
      }
      catch (error) {
        const code = closed ? 'roc_retrieval_closed' : active.aborted
          ? active.reason instanceof DOMException && active.reason.name === 'TimeoutError' ? 'roc_retrieval_timeout' : 'roc_retrieval_cancelled'
          : redactedRetrievalCode(error, kind === 'embed' ? 'roc_retrieval_embedding_failed' : 'roc_retrieval_reranker_failed');
        throw retrievalError(code);
      }
    })();
    tasks.add(task);
    try { return await task; } finally { tasks.delete(task); }
  };
  return {
    identity,
    embed: (texts, signal, correlation) => execute('embed', signal, async active => {
      retrievalCorrelation(correlation);
      if (!Array.isArray(texts) || Array.from(texts).some(text => typeof text !== 'string')) throw retrievalError('roc_retrieval_input_invalid');
      if (!embeddingConfig || !embeddingKey) throw retrievalError('roc_retrieval_embedding_unavailable');
      return await embeddings.embed({config: embeddingConfig, apiKey: embeddingKey, texts: [...texts], signal: active});
    }),
    rerank: (query, documents, signal, correlation) => execute('rerank', signal, async active => {
      retrievalCorrelation(correlation);
      if (typeof query !== 'string' || !Array.isArray(documents) || Array.from(documents).some(text => typeof text !== 'string')) {
        throw retrievalError('roc_retrieval_input_invalid');
      }
      if (selection.rerank === 'none') return {scores: null, receipt: {
        status: 'not_requested', model: null, configHash: null, elapsedMs: 0
      }};
      return await reranker.rank(query, [...documents], active);
    }),
    close: () => closing ??= (async () => {
      closed = true; lifetime.abort(); await Promise.allSettled([...tasks]);
      embeddingKey = null; rerankerKey = null;
    })()
  };
}
