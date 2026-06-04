import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { Database as DatabaseConnection } from 'better-sqlite3';

import type {
  MemoryFileMeta,
  MemoryFileWriteOutcome,
  MemoryFileWriteRequest,
  MemoryKind,
  MemoryScope,
  MemoryStatus
} from '../../../shared/types';

type MemoryRepositoryOptions = {
  db: DatabaseConnection;
  memoryRoot: string;
  workspace?: {
    path: string;
    label: string;
  } | null;
  charLimits?: Record<MemoryKind, number>;
  sessionRetentionDays?: number;
};

type MemoryEventRow = {
  summary: string;
  created_at: string;
};

const defaultCharLimits: Record<MemoryKind, number> = {
  user: 1375,
  agents: 800,
  memory: 2200
};

const globalFiles: Array<{ scope: 'global'; kind: MemoryKind }> = [
  { scope: 'global', kind: 'user' },
  { scope: 'global', kind: 'agents' },
  { scope: 'global', kind: 'memory' }
];

const workspaceFiles: Array<{ scope: 'workspace'; kind: Exclude<MemoryKind, 'user'> }> = [
  { scope: 'workspace', kind: 'agents' },
  { scope: 'workspace', kind: 'memory' }
];

export class MemoryRepository {
  private readonly charLimits: Record<MemoryKind, number>;
  private readonly sessionRetentionDays: number;

  constructor(private readonly options: MemoryRepositoryOptions) {
    this.charLimits = options.charLimits === undefined ? defaultCharLimits : options.charLimits;
    this.sessionRetentionDays = options.sessionRetentionDays === undefined ? 90 : options.sessionRetentionDays;
  }

  readFile(input: { scope: MemoryScope; kind: MemoryKind }): string | null {
    const resolved = this.resolveAbsolutePath(input.scope, input.kind);
    if (resolved === null || !existsSync(resolved)) {
      return null;
    }
    return readFileSync(resolved, 'utf8');
  }

  writeFile(request: MemoryFileWriteRequest): MemoryFileWriteOutcome {
    if (request.scope === 'workspace' && request.kind === 'user') {
      return {
        ok: false,
        reason: 'invalid_path',
        detail: 'USER.md lives only at /memory/global/USER.md.'
      };
    }
    const resolved = this.resolveAbsolutePath(request.scope, request.kind);
    if (resolved === null) {
      return {
        ok: false,
        reason: 'workspace_required',
        detail: 'No workspace selected; select a workspace before writing workspace-scoped memory.'
      };
    }
    const charCount = [...request.content].length;
    const limit = this.charLimits[request.kind];
    if (charCount > limit) {
      return {
        ok: false,
        reason: 'capacity_exceeded',
        detail: `Memory file exceeds ${limit} characters.`,
        chars: charCount,
        limit
      };
    }
    mkdirSync(dirname(resolved), { recursive: true });
    writeFileSync(resolved, request.content, 'utf8');
    return {
      ok: true,
      meta: this.buildMeta(request.scope, request.kind, resolved)
    };
  }

  status(): MemoryStatus {
    const files = [...globalFiles, ...workspaceFiles].map((slot) => {
      const resolved = this.resolveAbsolutePath(slot.scope, slot.kind);
      return this.buildSlotMeta(slot.scope, slot.kind, resolved);
    });
    let totalChars = 0;
    let totalLimit = 0;
    for (const file of files) {
      if (file.effective) {
        totalChars += file.charCount;
        totalLimit += file.charLimit;
      }
    }
    return {
      root: this.options.memoryRoot,
      workspaceHash: this.workspaceHash(),
      workspaceLabel: this.options.workspace === null || this.options.workspace === undefined ? null : this.options.workspace.label,
      files,
      snapshot: {
        enabled: true,
        totalChars,
        totalLimit
      },
      sessionMessages: {
        totalRows: 0,
        retentionDays: this.sessionRetentionDays,
        oldestAt: null
      },
      fullTextIndex: { healthy: true, status: 'ready' }
    };
  }

  buildSnapshotPreview(): { text: string } {
    const sections: string[] = [];
    for (const slot of globalFiles) {
      this.appendFileSection(sections, slot.scope, slot.kind);
    }
    for (const slot of workspaceFiles) {
      this.appendFileSection(sections, slot.scope, slot.kind);
    }
    const eventRows = this.options.db
      .prepare(
        `SELECT summary, created_at
         FROM memory_events
         ORDER BY created_at DESC, id DESC
         LIMIT 20`
      )
      .all() as MemoryEventRow[];
    if (eventRows.length > 0) {
      sections.push(
        [
          '# Recent Agent Memory Events',
          ...eventRows.map((row) => `- ${row.created_at}: ${row.summary}`)
        ].join('\n')
      );
    }
    return { text: sections.join('\n\n') };
  }

  recordMemoryEvent(input: { type: string; threadId?: string | null; runId?: string | null; summary: string; payload: unknown }): void {
    const threadId = input.threadId === undefined ? null : input.threadId;
    const runId = input.runId === undefined ? null : input.runId;
    this.options.db
      .prepare(
        `INSERT INTO memory_events (id, type, thread_id, run_id, summary, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(`mem_event_${randomUUID()}`, input.type, threadId, runId, input.summary, JSON.stringify(input.payload), new Date().toISOString());
  }

  private appendFileSection(sections: string[], scope: MemoryScope, kind: MemoryKind): void {
    const content = this.readFile({ scope, kind });
    if (content === null || content.trim().length === 0) {
      return;
    }
    sections.push(`# ${scope}/${this.filenameForKind(kind)}\n${content}`);
  }

  private buildSlotMeta(scope: MemoryScope, kind: MemoryKind, absolutePath: string | null): MemoryFileMeta {
    if (absolutePath === null) {
      return {
        scope,
        kind,
        exists: false,
        charCount: 0,
        charLimit: this.charLimits[kind],
        absolutePath: '',
        effective: false,
        updatedAt: null
      };
    }
    return this.buildMeta(scope, kind, absolutePath);
  }

  private buildMeta(scope: MemoryScope, kind: MemoryKind, absolutePath: string): MemoryFileMeta {
    if (!existsSync(absolutePath)) {
      return {
        scope,
        kind,
        exists: false,
        charCount: 0,
        charLimit: this.charLimits[kind],
        absolutePath,
        effective: this.isEffective(scope, kind),
        updatedAt: null
      };
    }
    const content = readFileSync(absolutePath, 'utf8');
    const stat = statSync(absolutePath);
    return {
      scope,
      kind,
      exists: true,
      charCount: [...content].length,
      charLimit: this.charLimits[kind],
      absolutePath,
      effective: this.isEffective(scope, kind),
      updatedAt: stat.mtime.toISOString()
    };
  }

  private resolveAbsolutePath(scope: MemoryScope, kind: MemoryKind): string | null {
    const filename = this.filenameForKind(kind);
    if (scope === 'global') {
      return join(this.options.memoryRoot, 'global', filename);
    }
    if (kind === 'user') {
      return null;
    }
    const hash = this.workspaceHash();
    if (hash === null) {
      return null;
    }
    return join(this.options.memoryRoot, 'workspaces', hash, filename);
  }

  private isEffective(scope: MemoryScope, kind: MemoryKind): boolean {
    return scope === 'global' || kind !== 'user';
  }

  private filenameForKind(kind: MemoryKind): string {
    switch (kind) {
      case 'user':
        return 'USER.md';
      case 'agents':
        return 'AGENTS.md';
      case 'memory':
        return 'MEMORY.md';
    }
  }

  private workspaceHash(): string | null {
    if (this.options.workspace === null || this.options.workspace === undefined) {
      return null;
    }
    const normalized = resolve(this.options.workspace.path).toLowerCase();
    return createHash('sha1').update(normalized).digest('hex').slice(0, 16);
  }
}
