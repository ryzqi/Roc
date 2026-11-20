import type {InferenceSession} from 'onnxruntime-node';

type Entry = {
  stage: string;
  open: () => Promise<InferenceSession>;
  session: InferenceSession | null;
  releasing: Promise<void> | null;
};

/** One parser owns this scope. Native sessions survive only within the current model stage. */
export class OcrStageSessions {
  private readonly entries: Entry[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(private readonly signal: AbortSignal) {}

  async create(stage: string, open: () => Promise<InferenceSession>) {
    const entry: Entry = {stage, open, session: null, releasing: null};
    this.entries.push(entry);
    // PaddleOCR needs real names and shapes at construction, before its first run.
    const metadata = await this.exclusive(async () => {
      const session = await this.activate(entry);
      return {inputNames: session.inputNames, outputNames: session.outputNames,
        inputMetadata: session.inputMetadata};
    });
    return {...metadata,
      run: (feeds: Parameters<InferenceSession['run']>[0]) => this.exclusive(async () => {
        const session = await this.activate(entry);
        const result = await session.run(feeds);
        this.signal.throwIfAborted();
        return result;
      }),
      release: () => this.exclusive(() => this.evict(entry))};
  }

  /** A page is finished: release its last stage before asset publication or another page. */
  releaseIdle(): Promise<void> { return this.exclusive(() => this.evictAll()); }

  release(): Promise<void> {
    this.closed = true;
    return this.releaseIdle();
  }

  private async activate(entry: Entry): Promise<InferenceSession> {
    if (this.closed) throw new Error('research_ocr_sessions_closed');
    this.signal.throwIfAborted();
    for (const previous of this.entries) {
      if (previous.releasing) await previous.releasing;
      if (previous.stage !== entry.stage) await this.evict(previous);
    }
    // A failed native release is never hidden by allocating a replacement.
    if (entry.releasing) await entry.releasing;
    this.signal.throwIfAborted();
    entry.session ??= await entry.open();
    this.signal.throwIfAborted();
    return entry.session;
  }

  private async evict(entry: Entry): Promise<void> {
    if (!entry.session) return;
    entry.releasing ??= Promise.resolve().then(() => entry.session!.release());
    await entry.releasing;
    entry.session = null;
    entry.releasing = null;
  }

  private async evictAll(): Promise<void> {
    const errors: unknown[] = [];
    for (const entry of this.entries) {
      try { await this.evict(entry); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'research_ocr_session_release_failed');
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
