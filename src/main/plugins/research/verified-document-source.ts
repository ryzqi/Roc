import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, mkdtemp, open, rm, type FileHandle} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {researchPath} from './research-files';

export const documentSourceLimits = {
  sessions: 8, snapshotBytes: 1024 * 1024 * 1024, creating: 2,
  streams: 8, streamsPerSession: 2, rangeBytes: 1024 * 1024,
  bufferBytes: 64 * 1024, idleMs: 5 * 60 * 1000
} as const;

type Source = {key: string; size: number; sha256: string};
type Entry = Source & {
  id: string; file: FileHandle; touched: number; streams: number;
  retired: boolean; controller: AbortController; closed: Promise<void> | null;
  completion: ReturnType<typeof Promise.withResolvers<void>>;
};
type Limits = {[K in keyof typeof documentSourceLimits]: number};

/** Hash the bytes actually read; metadata is only a concurrent-change fence. */
async function readVerifiedSource(root: string, relativePath: string, source: Source, signal: AbortSignal,
  consume: (bytes: Buffer) => Promise<void> | void): Promise<void> {
  signal.throwIfAborted();
  const path = await researchPath(root, relativePath);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size !== source.size) throw new Error('research_document_source_changed');
    // Bind the opened descriptor to the protected path, including its ancestors.
    if (await researchPath(root, relativePath) !== path) throw new Error('research_path_outside_project');
    const identity = await lstat(path);
    if (identity.isSymbolicLink() || identity.dev !== before.dev || identity.ino !== before.ino) {
      throw new Error('research_path_symlink');
    }
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(Math.min(documentSourceLimits.bufferBytes, source.size + 1));
    let offset = 0;
    while (offset <= source.size) {
      signal.throwIfAborted();
      const {bytesRead} = await file.read(buffer, 0, Math.min(buffer.length, source.size + 1 - offset), offset);
      if (bytesRead === 0) break;
      const bytes = buffer.subarray(0, bytesRead);
      hash.update(bytes);
      await consume(bytes);
      offset += bytesRead;
    }
    const after = await file.stat();
    if (offset !== source.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs || hash.digest('hex') !== source.sha256) {
      throw new Error('research_document_source_changed');
    }
    signal.throwIfAborted();
  } finally {
    await file.close();
  }
}

export async function verifyDocumentSource(root: string, path: string, size: number, sha256: string,
  signal = new AbortController().signal): Promise<void> {
  await readVerifiedSource(root, path, {key: '', size, sha256}, signal, () => {});
}

/**
 * A lease names SHA-verified bytes in an unlinked read-only file. The mutable
 * library file is never trusted from stat metadata or a cross-request hash cache.
 */
export class VerifiedDocumentSources {
  private readonly entries = new Map<string, Entry>();
  private readonly creating = new Set<Promise<Entry>>();
  private readonly acquisitions = new Map<Promise<string>, {key: string; controller: AbortController}>();
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setInterval>;
  private reservedBytes = 0;
  private activeStreams = 0;
  private closed = false;
  private readonly counters = {hashBytes: 0, streamBytes: 0, peakSnapshotBytes: 0, peakStreams: 0};

  constructor(private readonly limits: Limits = documentSourceLimits) {
    this.timer = setInterval(() => {
      void this.expire().catch(error => console.error('research_pdf_expiry_failed', error));
    }, Math.min(limits.idleMs, 30_000));
    this.timer.unref();
  }

  metrics(): Readonly<Record<string, number>> {
    return {...this.counters, sessions: this.entries.size, creating: this.creating.size,
      snapshotBytes: this.reservedBytes, streams: this.activeStreams};
  }

  acquire(root: string, path: string, source: Source, parentSignal: AbortSignal): Promise<string> {
    const controller = new AbortController();
    const operation = this.openLease(root, path, source, AbortSignal.any([parentSignal, controller.signal]));
    this.acquisitions.set(operation, {key: source.key, controller});
    void operation.then(() => this.acquisitions.delete(operation), () => this.acquisitions.delete(operation));
    return operation;
  }

  private async openLease(root: string, path: string, source: Source, parentSignal: AbortSignal): Promise<string> {
    this.requireOpen();
    const signal = AbortSignal.any([parentSignal, this.controller.signal]);
    signal.throwIfAborted();
    if (!Number.isSafeInteger(source.size) || source.size < 0 || source.size > this.limits.snapshotBytes) {
      throw new Error('research_document_preview_busy');
    }
    if (this.creating.size >= this.limits.creating) throw new Error('research_document_preview_busy');
    // Each client owns its lease: closing one Reader cannot cancel another.
    while (this.entries.size + this.creating.size >= this.limits.sessions ||
           this.reservedBytes + source.size > this.limits.snapshotBytes) {
      const idle = [...this.entries.values()].filter(entry => !entry.retired && entry.streams === 0)
        .sort((a, b) => a.touched - b.touched)[0];
      if (idle === undefined) throw new Error('research_document_preview_busy');
      await this.retire(idle);
      this.requireOpen();
      signal.throwIfAborted();
    }
    // Reservations are synchronous and checked again after any eviction await.
    if (this.creating.size >= this.limits.creating) throw new Error('research_document_preview_busy');
    this.reservedBytes += source.size;
    this.counters.peakSnapshotBytes = Math.max(this.counters.peakSnapshotBytes, this.reservedBytes);
    const promise = this.snapshot(root, path, source, signal);
    this.creating.add(promise);
    let created: Entry | null = null;
    try {
      const entry = created = await promise;
      this.requireOpen();
      this.entries.set(entry.id, entry);
      return entry.id;
    } catch (error) {
      try {await created?.file.close();}
      finally {this.reservedBytes -= source.size;}
      throw error;
    } finally {
      this.creating.delete(promise);
    }
  }

  private async snapshot(root: string, path: string, source: Source, signal: AbortSignal): Promise<Entry> {
    const directory = await mkdtemp(join(tmpdir(), 'roc-verified-pdf-'));
    const snapshotPath = join(directory, 'source');
    let writer: FileHandle | null = null, reader: FileHandle | null = null;
    try {
      writer = await open(snapshotPath, 'wx', 0o600);
      await readVerifiedSource(root, path, source, signal, async bytes => {
        this.counters.hashBytes += bytes.length;
        let offset = 0;
        while (offset < bytes.length) {
          signal.throwIfAborted();
          const result = await writer!.write(bytes, offset, bytes.length - offset);
          if (result.bytesWritten === 0) throw new Error('research_document_snapshot_write_failed');
          offset += result.bytesWritten;
        }
      });
      await writer.close(); writer = null;
      reader = await open(snapshotPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      await rm(snapshotPath);
      // Finish fallible path cleanup before transferring ownership of the FD.
      await rm(directory, {recursive: true, force: true});
      signal.throwIfAborted();
      const entry: Entry = {...source, id: randomUUID(), file: reader, touched: Date.now(),
        streams: 0, retired: false, controller: new AbortController(), closed: null,
        completion: Promise.withResolvers<void>()};
      reader = null;
      return entry;
    } finally {
      try {await writer?.close();}
      finally {
        try {await reader?.close();}
        finally {await rm(directory, {recursive: true, force: true});}
      }
    }
  }

  has(id: string, key: string): boolean {
    const entry = this.entries.get(id);
    return entry !== undefined && entry.key === key && !entry.retired;
  }

  async release(id: string, key: string): Promise<void> {
    const entry = this.entries.get(id);
    if (entry === undefined || entry.key !== key) return;
    await this.retire(entry);
  }

  async releaseMatching(matches: (key: string) => boolean): Promise<void> {
    const pending = [...this.acquisitions].filter(([, task]) => matches(task.key));
    for (const [, task] of pending) task.controller.abort();
    await Promise.allSettled(pending.map(([promise]) => promise));
    await Promise.all([...this.entries.values()].filter(entry => matches(entry.key)).map(entry => this.retire(entry)));
  }

  stream(id: string, key: string, begin: number, end: number, parentSignal: AbortSignal,
    authorize: () => void, releaseAfter = false): ReadableStream<Uint8Array> {
    this.requireOpen();
    const entry = this.entries.get(id);
    if (entry === undefined || entry.key !== key || entry.retired) throw new Error('research_document_preview_expired');
    if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end < begin || end > entry.size) {
      throw new Error('research_document_range_invalid');
    }
    if (this.activeStreams >= this.limits.streams || entry.streams >= this.limits.streamsPerSession) {
      throw new Error('research_document_preview_busy');
    }
    entry.streams++; this.activeStreams++;
    this.counters.peakStreams = Math.max(this.counters.peakStreams, this.activeStreams);
    entry.touched = Date.now();
    const signal = AbortSignal.any([parentSignal, this.controller.signal, entry.controller.signal]);
    let offset = begin, finished = false, pending: Promise<void> = Promise.resolve(), settled: Promise<void> | null = null;
    const finish = (): Promise<void> => {
      if (settled !== null) return settled;
      finished = true;
      signal.removeEventListener('abort', abort);
      settled = pending.then(async () => {
        entry.streams--; this.activeStreams--;
        if (entry.streams === 0 && entry.retired) entry.completion.resolve();
        if (releaseAfter) await this.retire(entry);
      });
      return settled;
    };
    const finishReading = (): void => {void finish().catch(error => console.error('research_pdf_stream_close_failed', error));};
    let target: ReadableStreamDefaultController<Uint8Array>;
    const abort = (): void => {if (!finished) {target.error(signal.reason); finishReading();}};
    return new ReadableStream<Uint8Array>({
      start(controller) {
        target = controller;
        signal.addEventListener('abort', abort, {once: true});
        if (signal.aborted) abort();
      },
      pull: controller => {
        if (finished) return;
        pending = (async () => {
          try {
            signal.throwIfAborted(); authorize();
            if (offset === end) {controller.close(); finishReading(); return;}
            const bytes = Buffer.alloc(Math.min(this.limits.bufferBytes, end - offset));
            const {bytesRead} = await entry.file.read(bytes, 0, bytes.length, offset);
            signal.throwIfAborted(); authorize();
            if (bytesRead !== bytes.length) throw new Error('research_document_snapshot_changed');
            offset += bytesRead; this.counters.streamBytes += bytesRead; entry.touched = Date.now();
            controller.enqueue(bytes);
            if (offset === end) {controller.close(); finishReading();}
          } catch (error) {
            if (!finished) {controller.error(error); finishReading();}
          }
        })();
        return pending;
      },
      cancel: () => finish()
    }, {highWaterMark: 1});
  }

  private async expire(): Promise<void> {
    const now = Date.now();
    await Promise.all([...this.entries.values()].filter(entry => !entry.retired && entry.streams === 0 &&
      now - entry.touched >= this.limits.idleMs).map(entry => this.retire(entry)));
  }

  private async retire(entry: Entry): Promise<void> {
    if (!entry.retired) {
      entry.retired = true;
      entry.controller.abort(new Error('research_document_preview_expired'));
    }
    return entry.closed ??= (async () => {
      if (entry.streams > 0) await entry.completion.promise;
      await entry.file.close();
      this.entries.delete(entry.id);
      this.reservedBytes -= entry.size;
    })();
  }

  async shutdown(): Promise<void> {
    this.closed = true; clearInterval(this.timer); this.controller.abort();
    await Promise.allSettled(this.acquisitions.keys());
    await Promise.all([...this.entries.values()].map(entry => this.retire(entry)));
  }

  private requireOpen(): void {
    if (this.closed) throw new Error('research_documents_closed');
  }
}

export function documentSourceRange(value: string, size: number): [number, number] | null {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  if (match === null || (match[1] === '' && match[2] === '')) return null;
  const first = Number(match[1]), last = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return null;
  const begin = match[1] === '' ? Math.max(0, size - last) : first;
  const end = match[1] === '' || match[2] === '' ? size : Math.min(size, last + 1);
  return begin < end && end - begin <= documentSourceLimits.rangeBytes ? [begin, end] : null;
}
