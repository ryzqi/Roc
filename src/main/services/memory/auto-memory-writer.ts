import type { RocPluginContext } from '../../kernel/types';
import type { MemoryScope } from '../../../shared/types';
import type { MemoryStoreRepository } from '../../plugins/memory/memory-store-repository';

export type AgentRunCompletedPayload = {
  runId: string;
  threadId: string | null;
  summary: string;
  assistantMessage: string;
};

type AutoMemoryWriterOptions = {
  repository: MemoryStoreRepository;
  targetScope: MemoryScope;
  logger: RocPluginContext['logger'];
};

export class AutoMemoryWriter {
  constructor(private readonly options: AutoMemoryWriterOptions) {}

  async handleAgentRunCompleted(payload: AgentRunCompletedPayload, createdAt?: string): Promise<void> {
    const summary = payload.summary.trim();
    if (summary.length === 0) {
      return;
    }
    const current = await this.options.repository.readFile({ scope: this.options.targetScope, kind: 'memory' });
    const bullet = `- Completed run ${payload.runId}: ${summary}`;
    const next = appendBullet(current === null ? '' : current, resolveDate(createdAt), bullet);
    if (next === null) {
      return;
    }
    const result = await this.options.repository.writeFile({
      scope: this.options.targetScope,
      kind: 'memory',
      content: next
    });
    if (!result.ok) {
      if (result.reason === 'capacity_exceeded') {
        this.options.logger.warn('memory_auto_write_skipped_capacity', {
          chars: result.chars,
          limit: result.limit
        });
        return;
      }
      if (result.reason === 'security_scan') {
        this.options.logger.warn('memory_auto_write_skipped_security');
      }
    }
  }
}

export function isAgentRunCompletedPayload(value: unknown): value is AgentRunCompletedPayload {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.runId === 'string' &&
    (typeof record.threadId === 'string' || record.threadId === null) &&
    typeof record.summary === 'string' &&
    typeof record.assistantMessage === 'string'
  );
}

function appendBullet(existing: string, date: string, bullet: string): string | null {
  if (existing.includes(bullet)) {
    return null;
  }
  const trimmed = existing.trimEnd();
  const heading = `## ${date}`;
  if (trimmed.length === 0) {
    return [heading, '', bullet].join('\n');
  }
  const lines = trimmed.split('\n');
  const headingIndex = lines.findIndex((line) => line.trim() === heading);
  if (headingIndex === -1) {
    return [trimmed, '', heading, '', bullet].join('\n');
  }
  const nextHeadingIndex = findNextDateHeading(lines, headingIndex + 1);
  const insertIndex = nextHeadingIndex === -1 ? lines.length : nextHeadingIndex;
  const before = lines.slice(0, insertIndex);
  const after = lines.slice(insertIndex);
  before.push(bullet);
  return [...before, ...after].join('\n');
}

function findNextDateHeading(lines: string[], start: number): number {
  for (let index = start; index < lines.length; index += 1) {
    if (/^## \d{4}-\d{2}-\d{2}$/u.test(lines[index])) {
      return index;
    }
  }
  return -1;
}

function resolveDate(createdAt: string | undefined): string {
  if (createdAt !== undefined) {
    const parsed = new Date(createdAt);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
  }
  return new Date().toISOString().slice(0, 10);
}
