import type { MemoryCharLimits, MemoryKind } from '../../../shared/types';

export type CapacityCheckResult = {
  ok: boolean;
  chars: number;
  limit: number;
};

export class CapacityService {
  constructor(private readonly limits: MemoryCharLimits) {}

  check(kind: MemoryKind, content: string): CapacityCheckResult {
    const chars = [...content].length;
    const limit = this.limits[kind];
    return { ok: chars <= limit, chars, limit };
  }

  formatOverflow(kind: MemoryKind, chars: number, limit: number): string {
    return [
      'Write blocked: capacity exceeded.',
      `  chars: ${chars}/${limit} (kind=${kind})`,
      'Read the file, merge or remove redundant entries via Edit, then retry after you consolidate.'
    ].join('\n');
  }
}
