import {errorMessage, type ActionOutcome} from '../app/loaded-state';

export type SearchIdentity = {key: string; generation: number};
export type SearchTicket<Result> = SearchIdentity & {outcome: ActionOutcome<Result>};
type Work<Request, Result> = SearchIdentity & {
  request: Request;
  waiters: Array<(ticket: SearchTicket<Result> | null) => void>;
};

/**
 * Bound IPC pressure to one running request and one latest waiting request. Invalidation settles
 * every caller immediately; the uncancellable old IPC may finish, but cannot publish or feed Ask.
 */
export class LatestSearchQueue<Request, Result> {
  private key: string | null = null;
  private generation = 0;
  private running: Work<Request, Result> | null = null;
  private waiting: Work<Request, Result> | null = null;
  private completed: SearchIdentity | null = null;

  constructor(
    private readonly execute: (request: Request) => Promise<ActionOutcome<Result>>,
    private readonly started: (identity: SearchIdentity) => void,
    private readonly finished: (ticket: SearchTicket<Result>) => void
  ) {}

  activate(key: string | null): void {
    if (this.key === key) return;
    this.invalidate();
    this.key = key;
  }

  invalidate(): void {
    this.generation += 1;
    this.key = null;
    this.completed = null;
    if (this.running) this.settle(this.running, null);
    if (this.waiting) this.settle(this.waiting, null);
    this.waiting = null;
  }

  isCurrent(identity: SearchIdentity): boolean {
    return this.key === identity.key && this.generation === identity.generation;
  }

  run(key: string, request: Request, force = false): Promise<SearchTicket<Result> | null> {
    if (key !== this.key) return Promise.resolve(null);
    if (!force && this.completed?.key === key && this.isCurrent(this.completed)) return Promise.resolve(null);
    const existing = [this.running, this.waiting].find(work => work && work.key === key && this.isCurrent(work));
    if (existing) return new Promise(resolve => existing.waiters.push(resolve));
    if (this.waiting) this.settle(this.waiting, null);
    return new Promise(resolve => {
      const work: Work<Request, Result> = {key, generation: this.generation, request, waiters: [resolve]};
      this.started(work);
      if (this.running) this.waiting = work;
      else this.start(work);
    });
  }

  private start(work: Work<Request, Result>): void {
    this.running = work;
    let operation: Promise<ActionOutcome<Result>>;
    try {operation = this.execute(work.request);}
    catch (error) {operation = Promise.resolve({ok: false, error: errorMessage(error)});}
    void operation.catch((error: unknown): ActionOutcome<Result> => ({ok: false, error: errorMessage(error)})).then(outcome => {
      this.running = null;
      if (this.isCurrent(work)) {
        const ticket = {key: work.key, generation: work.generation, outcome};
        // A scheduled debounce must not retry an explicit failure; explicit retry uses force.
        this.completed = {key: work.key, generation: work.generation};
        this.finished(ticket);
        this.settle(work, ticket);
      } else this.settle(work, null);
      const next = this.waiting;
      this.waiting = null;
      if (next && this.isCurrent(next)) this.start(next);
      else if (next) this.settle(next, null);
    });
  }

  private settle(work: Work<Request, Result>, ticket: SearchTicket<Result> | null): void {
    for (const resolve of work.waiters.splice(0)) resolve(ticket);
  }
}
