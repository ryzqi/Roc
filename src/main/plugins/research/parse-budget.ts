/**
 * 解析并发预算（提案 §6「文献解析与项目文件索引共享全局解析并发预算，初始并发 1」）。
 *
 * 为什么要有它：ONNX Runtime/CoreML 模型会占用统一内存，公式识别还会加载约 309 MB 权重。
 * 并行解析会重复占用模型与页面缓冲，因此文献解析和项目索引继续共享并发预算 1。
 *
 * 排队规则只有一条：**显式用户解析优先于后台索引**。后台任务不会饿死——它每次只让出一个
 * 位置，用户解析释放后立刻回来拿。
 */
export type ParsePriority = 'user' | 'background';

type Waiter = { priority: ParsePriority; grant: () => void; fail: (error: Error) => void };

export class ResearchParseBudget {
  private readonly waiters: Waiter[] = [];
  private readonly leases = new Map<string, ParsePriority>();
  private nextId = 0;

  constructor(private readonly concurrency = 1) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('research_parse_budget_invalid');
  }

  /** 当前在跑的租约数（诊断与测试用）。 */
  get active(): number { return this.leases.size; }
  get queued(): number { return this.waiters.length; }

  /**
   * 取得一个解析槽。返回的 token 必须交给 `release`，否则整个预算会永久漏掉一个位置。
   * `signal` 中止只是放弃排队，不会吊销已取得的槽。
   */
  async acquire(priority: ParsePriority, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted === true) throw new Error('research_parse_cancelled');
    if (this.leases.size < this.concurrency && this.waiters.length === 0) return this.grant(priority);
    const token = await new Promise<string>((grant, fail) => {
      const waiter: Waiter = {
        priority,
        grant: () => {
          signal?.removeEventListener('abort', onAbort);
          grant(this.grant(priority));
        },
        fail: (error) => { signal?.removeEventListener('abort', onAbort); fail(error); }
      };
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        waiter.fail(new Error('research_parse_cancelled'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      // 用户任务插到所有后台任务前面，但排在已有用户任务之后（先到先得，不插队）。
      const at = priority === 'user' ? this.waiters.findIndex((entry) => entry.priority === 'background') : -1;
      if (at < 0) this.waiters.push(waiter);
      else this.waiters.splice(at, 0, waiter);
    });
    return token;
  }

  release(token: string): void {
    if (!this.leases.delete(token)) return;
    this.drain();
  }

  private drain(): void {
    while (this.leases.size < this.concurrency && this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter === undefined) return;
      waiter.grant();
    }
  }

  private grant(priority: ParsePriority): string {
    const token = `slot_${this.nextId++}`;
    this.leases.set(token, priority);
    return token;
  }
}
