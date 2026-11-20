import { randomUUID } from 'node:crypto';
import { deserialize, serialize } from 'node:v8';
import { Worker } from 'node:worker_threads';
import type { ResearchKnowledgeSearchResult } from '../../shared/types';
import {
  researchQueryLimits, researchQueryReplySchema, validateResearchQueryResult,
  fitsResearchQueryBudget,
  type ResearchQueryDatabase, type ResearchQueryInput, type ResearchQueryReply, type ResearchQueryWire
} from './research-query-protocol';

type ResultReply = Extract<ResearchQueryReply, { type: 'result' | 'error' | 'fallback' }>;
type Pending = {
  id: string;
  input: ResearchQueryInput;
  wire: ResearchQueryWire;
  size: number;
  failure?: Error;
  execution?: { resolve(value: ResultReply): void; reject(error: Error): void };
  timer: ReturnType<typeof setTimeout>;
  unsubscribe(): void;
  resolve(value: ResearchKnowledgeSearchResult | null): void;
  reject(error: Error): void;
};
type Session = {
  worker: Worker;
  ready: boolean;
  exited: boolean;
  failure?: Error;
  initialized: Promise<void>;
  resolveReady(): void;
  rejectReady(error: Error): void;
  exit: Promise<void>;
  resolveExit(): void;
};

export type ResearchQueryEvent = {
  type: 'spawn' | 'ready' | 'started' | 'result' | 'cancel' | 'exit' | 'fallback';
  requestId?: string;
  queryMs?: number;
  resultBytes?: number;
  snapshot?: { dataVersion: number; schema: number };
};
export type ResearchQueryClientOptions = {
  database: ResearchQueryDatabase;
  workerUrl: URL;
  idleMs?: number;
  deadlineMs?: number;
  maxPending?: number;
  now?: () => string;
  onEvent?: (event: ResearchQueryEvent) => void;
};

/** One lazy Worker and one in-flight query, with bounded Main-side backpressure. */
export class ResearchQueryClient {
  private readonly queue: Pending[] = [];
  private active: Pending | null = null;
  private session: Session | null = null;
  private retiring: Promise<void> | null = null;
  private pumping: Promise<void> | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private queuedBytes = 0;
  private starts = 0;
  private exits = 0;

  constructor(private readonly options: ResearchQueryClientOptions) {}

  snapshot(): { workers: number; active: string | null; queued: number; queuedBytes: number; starts: number; exits: number } {
    return { workers: this.session === null ? 0 : 1, active: this.active?.id ?? null,
      queued: this.queue.length, queuedBytes: this.queuedBytes, starts: this.starts, exits: this.exits };
  }

  async search(input: ResearchQueryInput, signal?: AbortSignal,
    deadline = Date.now() + (this.options.deadlineMs ?? researchQueryLimits.deadlineMs)): Promise<ResearchKnowledgeSearchResult | null> {
    if (this.closed) throw new Error('research_query_closed');
    signal?.throwIfAborted();
    if (deadline <= Date.now()) throw new Error('research_query_deadline_exceeded');
    const request = { capability: 'research.knowledge.search', scope: input.request.projectId,
      generatedAt: this.options.now?.() ?? new Date().toISOString(), input };
    // Public schemas deliberately have no query/content byte cap. Valid large
    // requests and results use the original path instead of changing that API.
    if (!fitsResearchQueryBudget(request, researchQueryLimits.requestBytes)) {
      this.emit({ type: 'fallback' });
      return null;
    }
    const encoded = serialize(request);
    if (encoded.byteLength > researchQueryLimits.requestBytes) {
      this.emit({ type: 'fallback' });
      return null;
    }
    if (this.queue.length + Number(this.active !== null) >= Math.min(this.options.maxPending ?? researchQueryLimits.pending, researchQueryLimits.pending) ||
        this.queuedBytes + encoded.byteLength > researchQueryLimits.queuedBytes) {
      throw new Error('research_query_queue_full');
    }
    this.clearIdle();
    return await new Promise<ResearchKnowledgeSearchResult | null>((resolve, reject) => {
      const id = randomUUID();
      const cancel = () => this.cancel(pending, abortError(signal));
      const pending: Pending = {
        id, input, size: encoded.byteLength,
        wire: { protocol: 1, type: 'search', requestId: id, deadline, bytes: new Uint8Array(encoded) },
        timer: setTimeout(() => this.cancel(pending, new Error('research_query_deadline_exceeded')), Math.max(0, deadline - Date.now())),
        unsubscribe: () => signal?.removeEventListener('abort', cancel),
        resolve, reject
      };
      pending.timer.unref();
      signal?.addEventListener('abort', cancel, { once: true });
      this.queue.push(pending);
      this.queuedBytes += pending.size;
      if (signal?.aborted) this.cancel(pending, abortError(signal));
      this.pump();
    });
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.clearIdle();
    for (const pending of [...this.queue]) this.cancel(pending, new Error('research_query_closed'));
    if (this.active !== null) this.cancel(this.active, new Error('research_query_closed'));
    await this.pumping;
    await this.retire();
  }

  private cancel(pending: Pending, error: Error): void {
    if (pending.failure !== undefined) return;
    const index = this.queue.indexOf(pending);
    if (index < 0 && this.active !== pending) return;
    pending.failure = error;
    this.emit({ type: 'cancel', requestId: pending.id });
    if (index >= 0) {
      this.queue.splice(index, 1);
      this.queuedBytes -= pending.size;
      this.release(pending);
      pending.reject(error);
      return;
    }
    pending.execution?.reject(error);
    // sqlite-vec/FTS are synchronous native calls. Terminate and await actual
    // exit before settling cancellation or admitting the next query.
    void this.retire();
  }

  private pump(): void {
    if (this.pumping !== null || this.closed || this.queue.length === 0) return;
    this.pumping = this.drain().finally(() => {
      this.pumping = null;
      if (this.queue.length > 0 && !this.closed) this.pump();
      else this.scheduleIdle();
    });
  }

  private async drain(): Promise<void> {
    while (!this.closed && this.queue.length > 0) {
      const pending = this.queue.shift()!;
      this.queuedBytes -= pending.size;
      this.active = pending;
      let value: ResearchKnowledgeSearchResult | null = null;
      let failure: Error | undefined;
      try {
        const session = await this.ensureWorker(pending);
        if (pending.failure !== undefined) throw pending.failure;
        const response = new Promise<ResultReply>((resolve, reject) => { pending.execution = { resolve, reject }; });
        try {
          session.worker.postMessage(pending.wire, [pending.wire.bytes.buffer as ArrayBuffer]);
        } catch (error) {
          session.failure = asError(error);
          pending.execution!.reject(session.failure);
        }
        const reply = await response;
        if (reply.type === 'error') throw new Error(reply.code);
        if (reply.type === 'result') {
          let decoded: unknown;
          try {
            decoded = deserialize(reply.bytes);
            validateResearchQueryResult(decoded, pending.input);
            value = decoded;
          } catch (error) {
            session.failure = asError(error);
            throw session.failure;
          }
          this.emit({ type: 'result', requestId: pending.id, queryMs: reply.queryMs,
            resultBytes: reply.bytes.byteLength, snapshot: reply.snapshot });
        } else {
          this.emit({ type: 'fallback', requestId: pending.id });
        }
      } catch (error) {
        failure = pending.failure ?? asError(error);
        if (pending.failure === undefined && readonlyUnavailable(failure)) {
          failure = undefined;
          this.emit({ type: 'fallback', requestId: pending.id });
        }
      } finally {
        if (pending.failure !== undefined || this.session?.failure !== undefined) await this.retire();
        // Includes a retirement started concurrently with cancellation/init.
        await this.retiring;
        failure = pending.failure ?? failure;
        this.release(pending);
        this.active = null;
      }
      if (failure === undefined) pending.resolve(value);
      else pending.reject(failure);
    }
  }

  private async ensureWorker(pending: Pending): Promise<Session> {
    await this.retiring;
    if (pending.failure !== undefined) throw pending.failure;
    if (this.closed) throw new Error('research_query_closed');
    if (this.session === null) {
      const worker = new Worker(this.options.workerUrl, { workerData: this.options.database });
      let resolveReady!: () => void, rejectReady!: (error: Error) => void, resolveExit!: () => void;
      const initialized = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      const exit = new Promise<void>(resolve => { resolveExit = resolve; });
      const session: Session = { worker, ready: false, exited: false, initialized, exit, resolveReady, rejectReady, resolveExit };
      this.session = session;
      this.starts++;
      worker.on('message', (raw: unknown) => this.message(session, raw));
      worker.on('error', error => {
        const failure = asError(error);
        session.failure = !session.ready && readonlyUnavailable(failure) ? new Error('research_query_readonly_unavailable') : failure;
        session.rejectReady(session.failure);
        this.active?.execution?.reject(session.failure);
        void this.retire();
      });
      worker.once('exit', () => {
        session.exited = true;
        this.exits++;
        this.emit({ type: 'exit' });
        if (this.session === session) this.session = null;
        const error = session.failure ?? new Error('research_query_worker_crashed');
        session.rejectReady(error);
        this.active?.execution?.reject(error);
        session.resolveExit();
      });
      this.emit({ type: 'spawn', requestId: pending.id });
    }
    const session = this.session;
    session.worker.ref();
    await session.initialized;
    if (session.exited) throw session.failure ?? new Error('research_query_worker_crashed');
    return session;
  }

  private message(session: Session, raw: unknown): void {
    if (this.session !== session || session.exited) return;
    try {
      const reply = researchQueryReplySchema.parse(raw);
      if (reply.type === 'ready') {
        const left = reply.database, right = this.options.database;
        if (session.ready || left.path !== right.path || left.device !== right.device ||
            left.inode !== right.inode || left.schema !== right.schema) throw new Error('research_query_database_changed');
        session.ready = true;
        session.resolveReady();
        this.emit({ type: 'ready' });
      } else if (reply.type === 'init-error') {
        session.failure = new Error(reply.code);
        session.rejectReady(session.failure);
        void this.retire();
      } else {
        const active = this.active;
        if (active?.failure !== undefined) return;
        if (!session.ready || active === null || active.id !== reply.requestId || active.execution === undefined) {
          throw new Error('research_query_reply_invalid');
        }
        if (reply.type === 'started') this.emit({ type: 'started', requestId: reply.requestId });
        else active.execution.resolve(reply);
      }
    } catch (error) {
      session.failure = asError(error);
      session.rejectReady(session.failure);
      this.active?.execution?.reject(session.failure);
      void this.retire();
    }
  }

  private retire(): Promise<void> {
    if (this.retiring !== null) return this.retiring;
    this.clearIdle();
    const session = this.session;
    if (session === null) return Promise.resolve();
    this.retiring = (async () => {
      if (!session.exited) await session.worker.terminate();
      await session.exit;
    })().finally(() => { this.retiring = null; });
    return this.retiring;
  }

  private release(pending: Pending): void {
    clearTimeout(pending.timer);
    pending.unsubscribe();
    pending.execution = undefined;
    pending.wire.bytes = new Uint8Array();
  }

  private scheduleIdle(): void {
    if (this.closed || this.active !== null || this.queue.length > 0 || this.session === null) return;
    this.session.worker.unref();
    this.idle = setTimeout(() => { void this.retire(); }, this.options.idleMs ?? researchQueryLimits.idleMs);
    this.idle.unref();
  }

  private clearIdle(): void {
    if (this.idle !== null) clearTimeout(this.idle);
    this.idle = null;
  }

  private emit(event: ResearchQueryEvent): void {
    try { this.options.onEvent?.(event); } catch { /* Observation cannot change query semantics. */ }
  }
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error('research_query_cancelled');
}
function asError(error: unknown): Error { return error instanceof Error ? error : new Error('research_query_failed'); }
function readonlyUnavailable(error: Error): boolean {
  return error.message === 'research_query_readonly_unavailable' ||
    ('code' in error && ['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ENOENT', 'EACCES'].includes(String(error.code)));
}
