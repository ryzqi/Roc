export type CachedLiteratureResponse = {body: string; fetchedAt: string; responseHash: string};
type CachePolicy = {maxEntries: number; maxBytes: number; ttlMs: number};
type CacheEntry = CachedLiteratureResponse & {expiresAt: number; size: number};

/** Only public Provider response bodies enter this process-local, project-scoped cache. */
export class LiteratureResponseCache {
  private readonly entries = new Map<string, CacheEntry>();
  private bytes = 0;

  constructor(private readonly policy: CachePolicy, private readonly now: () => number) {}

  get(key: string): CachedLiteratureResponse | null {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt <= this.now()) {
      this.remove(key, entry);
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return {body: entry.body, fetchedAt: entry.fetchedAt, responseHash: entry.responseHash};
  }

  put(key: string, response: CachedLiteratureResponse): void {
    const previous = this.entries.get(key);
    if (previous !== undefined) this.remove(key, previous);
    const size = Buffer.byteLength(response.body, 'utf8');
    if (size > this.policy.maxBytes) return;
    for (const [entryKey, entry] of this.entries) {
      if (entry.expiresAt <= this.now()) this.remove(entryKey, entry);
    }
    while (this.entries.size >= this.policy.maxEntries || this.bytes + size > this.policy.maxBytes) {
      const oldest = this.entries.entries().next().value as [string, CacheEntry];
      this.remove(...oldest);
    }
    this.entries.set(key, {...response, size, expiresAt: this.now() + this.policy.ttlMs});
    this.bytes += size;
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  private remove(key: string, entry: CacheEntry): void {
    this.entries.delete(key);
    this.bytes -= entry.size;
  }
}
