import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { DatabaseService } from './database-service';
import { RocDomainError } from './errors';
import type {
  MemoryCandidate,
  MemoryConflict,
  MemoryDeleteResult,
  MemoryEntry,
  MemoryLayer,
  MemorySearchRequest,
  MemorySearchResult,
  MemoryStatus,
  MemoryType,
  SessionRecallEntry,
  SessionRecallWriteRequest,
  SessionSearchRequest,
  SessionSearchResult
} from '../../shared/types';
import type { RocPaths } from './paths';
import { conflict, db, fts, layerStats, markdown, operationsLog, routing, search, validation, WARM_FILES } from './memory';

export class MemoryService {
  constructor(
    private readonly paths: RocPaths,
    private readonly database: DatabaseService
  ) {}

  initialize(): void {
    markdown.ensureFile(join(this.paths.memoryDir, 'hot', 'hot_memory.md'), '# Hot Memory\n\n');
    for (const file of WARM_FILES) {
      markdown.ensureFile(join(this.paths.memoryDir, 'warm', file), `# ${basename(file, '.md')}\n\n`);
    }
    markdown.ensureFile(join(this.paths.memoryDir, 'cold', 'cold_index.md'), '# Cold Memory Index\n\n');
    markdown.ensureFile(join(this.paths.memoryDir, 'sessions', 'session_index.md'), '# Session Recall Index\n\n');
    markdown.ensureFile(join(this.paths.logsDir, 'memory_operations.log'), '');
  }

  status(): MemoryStatus {
    const fullTextReady = db.hasTable(this.database, 'memory_entries_fts') && db.hasTable(this.database, 'session_recall_fts');
    const degradedReasons = ['sqlite-vec embedding provider has not been configured; search falls back to FTS5 or Markdown.'];
    if (!fullTextReady) {
      degradedReasons.push('SQLite FTS5 is not available; search falls back to SQLite metadata and Markdown keyword matching.');
    }

    const layers: MemoryStatus['layers'] = {
      hot: layerStats.layerStats(this.database, 'hot', join(this.paths.memoryDir, 'hot')),
      warm: layerStats.layerStats(this.database, 'warm', join(this.paths.memoryDir, 'warm')),
      cold: layerStats.layerStats(this.database, 'cold', join(this.paths.memoryDir, 'cold')),
      session: layerStats.layerStats(this.database, 'session', join(this.paths.memoryDir, 'sessions')),
      candidate: layerStats.layerStats(this.database, 'candidate', join(this.paths.memoryDir, 'staging'))
    };

    return {
      root: this.paths.memoryDir,
      truthSource: 'markdown',
      indexSource: 'sqlite',
      vectorIndex: {
        enabled: false,
        healthy: false,
        status: 'not_configured'
      },
      fullTextIndex: {
        enabled: fullTextReady,
        healthy: fullTextReady,
        status: fullTextReady ? 'ready' : 'degraded'
      },
      layers,
      degradedReason: degradedReasons.join(' ')
    };
  }

  search(request: MemorySearchRequest): MemorySearchResult {
    const query = validation.requireText(
      request.query,
      'memory_query_empty',
      '记忆检索 query 不能为空。',
      '请输入要检索的关键词。'
    );

    if (request.source === 'session') {
      return {
        query,
        degraded: true,
        degradedReason: search.searchDegradedReason(this.database),
        items: search.searchSessionItems(this.database, { query, scope: request.scope })
      };
    }

    if (request.source === 'all') {
      const curatedItems = search.searchCuratedItems(this.database, request, query);
      const sessionItems = search.searchSessionItems(this.database, { query, scope: request.scope });
      return {
        query,
        degraded: true,
        degradedReason: search.searchDegradedReason(this.database),
        items: [...curatedItems, ...sessionItems]
      };
    }

    return {
      query,
      degraded: true,
      degradedReason: search.searchDegradedReason(this.database),
      items: search.searchCuratedItems(this.database, request, query)
    };
  }

  get(id: string): string {
    const memoryId = validation.requireText(id, 'memory_id_empty', '记忆 ID 不能为空。', '请提供要读取的记忆 ID。');
    const row = this.database.db
      .prepare('SELECT markdown_path FROM memory_entries_index WHERE id = ?')
      .get(memoryId) as { markdown_path: string } | undefined;

    if (row === undefined) {
      throw new RocDomainError({
        code: 'memory_not_found',
        message: `找不到记忆条目 ${memoryId}。`,
        category: 'not_found',
        retryable: false,
        userAction: '请刷新记忆中心或检查记忆 ID。'
      });
    }

    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    return readFileSync(row.markdown_path, 'utf8');
  }

  writeCandidate(entry: Omit<MemoryEntry, 'id' | 'layer' | 'status' | 'createdAt' | 'updatedAt'>): MemoryEntry {
    validation.validateCandidateInput(entry);
    const now = new Date().toISOString();
    const id = `mem_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const markdownPath = join(this.paths.memoryDir, 'staging', `${id}.md`);
    const fullEntry: MemoryEntry = {
      ...entry,
      id,
      layer: 'candidate',
      status: 'candidate',
      createdAt: now,
      updatedAt: now
    };
    const conflicts = conflict.detectConflicts(this.database, fullEntry);
    const candidateState: MemoryCandidate['state'] = conflicts.length > 0 ? 'conflict_detected' : 'new';
    const suggestedAction: MemoryCandidate['suggestedAction'] = conflicts.length > 0 ? 'review_conflict' : 'accept';

    writeFileSync(markdownPath, markdown.renderMemoryMarkdown(fullEntry), 'utf8');
    this.database.db
      .prepare(
        `INSERT INTO memory_entries_index
          (id, layer, type, scope, status, confidence, priority, source, source_ref, markdown_path, created_at, updated_at, access_count)
         VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
      )
      .run(
        fullEntry.id,
        fullEntry.layer,
        fullEntry.type,
        fullEntry.scope,
        fullEntry.status,
        fullEntry.confidence,
        fullEntry.priority,
        fullEntry.source,
        fullEntry.sourceRef,
        markdownPath,
        fullEntry.createdAt,
        fullEntry.updatedAt
      );
    this.database.db
      .prepare(
        `INSERT INTO memory_candidates (id, memory_id, state, suggested_action, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, id, candidateState, suggestedAction, now, now);

    for (const conflictEntry of conflicts) {
      this.database.db
        .prepare(
          `INSERT INTO memory_conflicts (id, candidate_id, active_memory_id, type, scope, reason, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`
        )
        .run(
          `memconf_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
          id,
          conflictEntry.activeMemoryId,
          fullEntry.type,
          fullEntry.scope,
          conflictEntry.reason,
          now
        );
    }

    operationsLog.appendOperation(this.database, this.paths, fullEntry.id, 'candidate_write', {
      source: fullEntry.source,
      sourceRef: fullEntry.sourceRef,
      candidateState
    });
    if (conflicts.length > 0) {
      operationsLog.appendOperation(this.database, this.paths, fullEntry.id, 'memory_conflict_detected', { conflicts });
    }

    return fullEntry;
  }

  listCandidates(): MemoryCandidate[] {
    const rows = this.database.db
      .prepare(
        `SELECT i.id, i.layer, i.type, i.scope, i.status, i.confidence, i.priority, i.source, i.source_ref, i.markdown_path,
                i.created_at, i.updated_at, c.state AS candidate_state, c.suggested_action
         FROM memory_candidates c
         JOIN memory_entries_index i ON i.id = c.memory_id
         ORDER BY c.updated_at DESC`
      )
      .all() as Array<import('./memory/types').CandidateRow>;

    return rows.map((row) => ({
      id: row.id,
      state: row.candidate_state,
      type: row.type,
      scope: row.scope,
      content: markdown.readMemoryBody(row.markdown_path),
      confidence: row.confidence,
      priority: row.priority,
      source: row.source,
      sourceRef: row.source_ref,
      suggestedAction: row.suggested_action,
      conflictCount: db.countCandidateConflicts(this.database, row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  listConflicts(): MemoryConflict[] {
    return this.database.db
      .prepare(
        `SELECT id, candidate_id, active_memory_id, type, scope, reason, status, created_at
         FROM memory_conflicts
         ORDER BY created_at DESC`
      )
      .all()
      .map((row) => {
        const conflictRow = row as {
          id: string;
          candidate_id: string;
          active_memory_id: string;
          type: MemoryType;
          scope: string;
          reason: string;
          status: MemoryConflict['status'];
          created_at: string;
        };
        return {
          id: conflictRow.id,
          candidateId: conflictRow.candidate_id,
          activeMemoryId: conflictRow.active_memory_id,
          type: conflictRow.type,
          scope: conflictRow.scope,
          reason: conflictRow.reason,
          status: conflictRow.status,
          createdAt: conflictRow.created_at
        };
      });
  }

  acceptCandidate(id: string): MemoryEntry {
    const candidateId = validation.requireText(id, 'memory_candidate_id_empty', '候选记忆 ID 不能为空。', '请提供要接受的候选 ID。');
    const candidate = db.getCandidateRow(this.database, candidateId);
    if (candidate.candidate_state === 'rejected') {
      throw new RocDomainError({
        code: 'memory_candidate_rejected',
        message: '已拒绝的候选记忆不能再接受。',
        category: 'conflict',
        retryable: false,
        userAction: '请重新创建候选记忆。'
      });
    }

    const now = new Date().toISOString();
    const layer = routing.targetLayer(candidate);
    const activeEntry: MemoryEntry = {
      id: candidate.id,
      layer,
      type: candidate.type,
      scope: candidate.scope,
      content: markdown.readMemoryBody(candidate.markdown_path),
      confidence: candidate.confidence,
      priority: candidate.priority,
      status: 'active',
      source: candidate.source,
      sourceRef: candidate.source_ref,
      createdAt: candidate.created_at,
      updatedAt: now
    };
    const markdownPath = routing.activeMarkdownPath(this.paths, activeEntry);

    writeFileSync(markdownPath, markdown.renderMemoryMarkdown(activeEntry), 'utf8');
    this.database.db
      .prepare(
        `UPDATE memory_entries_index
         SET layer = ?, status = 'active', markdown_path = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(layer, markdownPath, now, candidate.id);
    this.database.db
      .prepare(
        `UPDATE memory_candidates
         SET state = 'accepted', suggested_action = 'none', updated_at = ?, decided_at = ?
         WHERE memory_id = ?`
      )
      .run(now, now, candidate.id);
    fts.upsertMemoryFts(this.database, activeEntry, markdownPath);
    operationsLog.appendOperation(this.database, this.paths, activeEntry.id, 'candidate_accept', {
      layer,
      sourceRef: activeEntry.sourceRef
    });

    return activeEntry;
  }

  rejectCandidate(id: string): MemoryCandidate {
    const candidateId = validation.requireText(id, 'memory_candidate_id_empty', '候选记忆 ID 不能为空。', '请提供要拒绝的候选 ID。');
    const candidate = db.getCandidateRow(this.database, candidateId);
    const now = new Date().toISOString();
    this.database.db
      .prepare(
        `UPDATE memory_candidates
         SET state = 'rejected', suggested_action = 'none', updated_at = ?, decided_at = ?
         WHERE memory_id = ?`
      )
      .run(now, now, candidate.id);
    this.database.db.prepare("UPDATE memory_entries_index SET status = 'archived', updated_at = ? WHERE id = ?").run(now, candidate.id);
    fts.deleteMemoryFts(this.database, candidate.id);
    operationsLog.appendOperation(this.database, this.paths, candidate.id, 'candidate_reject', { sourceRef: candidate.source_ref });
    return this.listCandidates().filter((item) => item.id === candidate.id)[0];
  }

  writeSessionRecall(request: SessionRecallWriteRequest): SessionRecallEntry {
    const sessionId = validation.requireText(
      request.sessionId,
      'session_id_empty',
      '会话回忆 sessionId 不能为空。',
      '请提供要归档的 session ID。'
    );
    const title = validation.requireText(request.title, 'session_title_empty', '会话标题不能为空。', '请提供会话标题。');
    const summary = validation.requireText(request.summary, 'session_summary_empty', '会话摘要不能为空。', '请提供会话摘要。');
    const scope = validation.requireText(request.scope, 'session_scope_empty', '会话 scope 不能为空。', '请提供会话 scope。');
    const content = validation.requireText(request.content, 'session_content_empty', '会话全文不能为空。', '请提供会话全文。');
    const sourceRef = validation.requireText(request.sourceRef, 'session_source_ref_empty', '会话来源引用不能为空。', '请提供会话来源引用。');
    const now = new Date().toISOString();
    const datePart = now.slice(0, 10);
    const markdownPath = join(this.paths.memoryDir, 'sessions', datePart, `${sessionId}.md`);
    const markdownContent = [
      '---',
      `id: ${sessionId}`,
      `title: ${title}`,
      `scope: ${scope}`,
      `source_ref: ${sourceRef}`,
      `created_at: ${now}`,
      '---',
      '',
      `# ${title}`,
      '',
      summary,
      '',
      content,
      ''
    ].join('\n');

    mkdirSync(dirname(markdownPath), { recursive: true });
    writeFileSync(markdownPath, markdownContent, 'utf8');
    this.database.db
      .prepare(
        `INSERT OR REPLACE INTO session_recall_index (id, scope, title, summary, source_ref, markdown_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(sessionId, scope, title, summary, sourceRef, markdownPath, now);
    fts.upsertSessionFts(this.database, { id: sessionId, title, summary, scope, sourceRef, markdownPath, createdAt: now }, content);
    operationsLog.appendOperation(this.database, this.paths, sessionId, 'session_recall_write', { scope, sourceRef });

    return {
      id: sessionId,
      title,
      summary,
      scope,
      sourceRef,
      markdownPath,
      createdAt: now
    };
  }

  sessionSearch(request: SessionSearchRequest): SessionSearchResult {
    const query = validation.requireText(
      request.query,
      'session_query_empty',
      '会话回忆检索 query 不能为空。',
      '请输入要检索的会话关键词。'
    );
    return {
      query,
      items: search.searchSessionRows(this.database, { query, scope: request.scope }).map((row) => ({
        id: row.id,
        title: row.title,
        summary: row.summary,
        scope: row.scope,
        sourceRef: row.source_ref,
        reason: db.hasTable(this.database, 'session_recall_fts') ? 'SQLite FTS5 session match' : 'Markdown session keyword match'
      }))
    };
  }

  deleteMemory(id: string): MemoryDeleteResult {
    const memoryId = validation.requireText(id, 'memory_id_empty', '记忆 ID 不能为空。', '请提供要删除的记忆 ID。');
    const row = db.getMemoryRow(this.database, memoryId);
    if (row.status !== 'active') {
      throw new RocDomainError({
        code: 'memory_delete_invalid_state',
        message: '只有 active 记忆可以删除。',
        category: 'conflict',
        retryable: false,
        userAction: '请刷新记忆中心后重试。'
      });
    }
    const now = new Date().toISOString();
    this.database.db.prepare("UPDATE memory_entries_index SET status = 'archived', updated_at = ? WHERE id = ?").run(now, memoryId);
    fts.deleteMemoryFts(this.database, memoryId);
    operationsLog.appendOperation(this.database, this.paths, memoryId, 'memory_delete', { previousStatus: row.status, recoverable: true });
    return {
      id: memoryId,
      status: 'archived',
      recoverable: true
    };
  }

  restoreMemory(id: string): MemoryDeleteResult {
    const memoryId = validation.requireText(id, 'memory_id_empty', '记忆 ID 不能为空。', '请提供要恢复的记忆 ID。');
    const row = db.getMemoryRow(this.database, memoryId);
    if (row.status !== 'archived') {
      throw new RocDomainError({
        code: 'memory_restore_invalid_state',
        message: '只有 archived 记忆可以恢复。',
        category: 'conflict',
        retryable: false,
        userAction: '请刷新记忆中心后重试。'
      });
    }
    const now = new Date().toISOString();
    this.database.db.prepare("UPDATE memory_entries_index SET status = 'active', updated_at = ? WHERE id = ?").run(now, memoryId);
    const restoredEntry: MemoryEntry = {
      id: row.id,
      layer: row.layer,
      type: row.type,
      scope: row.scope,
      content: markdown.readMemoryBody(row.markdown_path),
      confidence: row.confidence,
      priority: row.priority,
      status: 'active',
      source: row.source,
      sourceRef: row.source_ref,
      createdAt: row.created_at,
      updatedAt: now
    };
    fts.upsertMemoryFts(this.database, restoredEntry, row.markdown_path);
    operationsLog.appendOperation(this.database, this.paths, memoryId, 'memory_restore', { previousStatus: row.status });
    return {
      id: memoryId,
      status: 'active',
      recoverable: false
    };
  }
}

// Unused import suppressor to keep MemoryLayer / RocPaths / DatabaseService surface available for downstream typing.
export type { MemoryLayer, RocPaths };
