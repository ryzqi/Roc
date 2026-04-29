import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { DatabaseService } from './database-service';
import { RocDomainError } from './errors';
import type {
  MemoryCandidate,
  MemoryConflict,
  MemoryDeleteResult,
  MemoryEntry,
  MemoryLayer,
  MemoryPriority,
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

const warmFiles = ['preferences.md', 'feedback.md', 'project_context.md', 'process_skills.md', 'knowledge_notes.md'];

type MemoryIndexRow = {
  id: string;
  layer: MemoryLayer;
  type: MemoryType;
  scope: string;
  status: MemoryEntry['status'];
  confidence: number;
  priority: MemoryPriority;
  source: string;
  source_ref: string;
  markdown_path: string;
  created_at: string;
  updated_at: string;
};

type CandidateRow = MemoryIndexRow & {
  candidate_state: MemoryCandidate['state'];
  suggested_action: MemoryCandidate['suggestedAction'];
};

type SessionRecallRow = {
  id: string;
  scope: string;
  title: string;
  summary: string;
  source_ref: string;
  markdown_path: string;
  created_at: string;
};

export class MemoryService {
  constructor(
    private readonly paths: RocPaths,
    private readonly database: DatabaseService
  ) {}

  initialize(): void {
    this.ensureFile(join(this.paths.memoryDir, 'hot', 'hot_memory.md'), '# Hot Memory\n\n');
    for (const file of warmFiles) {
      this.ensureFile(join(this.paths.memoryDir, 'warm', file), `# ${basename(file, '.md')}\n\n`);
    }
    this.ensureFile(join(this.paths.memoryDir, 'cold', 'cold_index.md'), '# Cold Memory Index\n\n');
    this.ensureFile(join(this.paths.memoryDir, 'sessions', 'session_index.md'), '# Session Recall Index\n\n');
    this.ensureFile(join(this.paths.logsDir, 'memory_operations.log'), '');
  }

  status(): MemoryStatus {
    const fullTextReady = this.hasTable('memory_entries_fts') && this.hasTable('session_recall_fts');
    const degradedReasons = ['sqlite-vec embedding provider has not been configured; search falls back to FTS5 or Markdown.'];
    if (!fullTextReady) {
      degradedReasons.push('SQLite FTS5 is not available; search falls back to SQLite metadata and Markdown keyword matching.');
    }

    const layers: MemoryStatus['layers'] = {
      hot: this.layerStats('hot', join(this.paths.memoryDir, 'hot')),
      warm: this.layerStats('warm', join(this.paths.memoryDir, 'warm')),
      cold: this.layerStats('cold', join(this.paths.memoryDir, 'cold')),
      session: this.layerStats('session', join(this.paths.memoryDir, 'sessions')),
      candidate: this.layerStats('candidate', join(this.paths.memoryDir, 'staging'))
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
    const query = this.requireText(
      request.query,
      'memory_query_empty',
      '记忆检索 query 不能为空。',
      '请输入要检索的关键词。'
    );

    if (request.source === 'session') {
      return {
        query,
        degraded: true,
        degradedReason: this.searchDegradedReason(),
        items: this.searchSessionItems({ query, scope: request.scope })
      };
    }

    if (request.source === 'all') {
      const curatedItems = this.searchCuratedItems(request, query);
      const sessionItems = this.searchSessionItems({ query, scope: request.scope });
      return {
        query,
        degraded: true,
        degradedReason: this.searchDegradedReason(),
        items: [...curatedItems, ...sessionItems]
      };
    }

    return {
      query,
      degraded: true,
      degradedReason: this.searchDegradedReason(),
      items: this.searchCuratedItems(request, query)
    };
  }

  get(id: string): string {
    const memoryId = this.requireText(id, 'memory_id_empty', '记忆 ID 不能为空。', '请提供要读取的记忆 ID。');
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

    return readFileSync(row.markdown_path, 'utf8');
  }

  writeCandidate(entry: Omit<MemoryEntry, 'id' | 'layer' | 'status' | 'createdAt' | 'updatedAt'>): MemoryEntry {
    this.validateCandidateInput(entry);
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
    const conflicts = this.detectConflicts(fullEntry);
    const candidateState: MemoryCandidate['state'] = conflicts.length > 0 ? 'conflict_detected' : 'new';
    const suggestedAction: MemoryCandidate['suggestedAction'] = conflicts.length > 0 ? 'review_conflict' : 'accept';

    writeFileSync(markdownPath, this.renderMemoryMarkdown(fullEntry), 'utf8');
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

    for (const conflict of conflicts) {
      this.database.db
        .prepare(
          `INSERT INTO memory_conflicts (id, candidate_id, active_memory_id, type, scope, reason, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`
        )
        .run(
          `memconf_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
          id,
          conflict.activeMemoryId,
          fullEntry.type,
          fullEntry.scope,
          conflict.reason,
          now
        );
    }

    this.appendOperation(fullEntry.id, 'candidate_write', {
      source: fullEntry.source,
      sourceRef: fullEntry.sourceRef,
      candidateState
    });
    if (conflicts.length > 0) {
      this.appendOperation(fullEntry.id, 'memory_conflict_detected', { conflicts });
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
      .all() as CandidateRow[];

    return rows.map((row) => ({
      id: row.id,
      state: row.candidate_state,
      type: row.type,
      scope: row.scope,
      content: this.readMemoryBody(row.markdown_path),
      confidence: row.confidence,
      priority: row.priority,
      source: row.source,
      sourceRef: row.source_ref,
      suggestedAction: row.suggested_action,
      conflictCount: this.countCandidateConflicts(row.id),
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
        const conflict = row as {
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
          id: conflict.id,
          candidateId: conflict.candidate_id,
          activeMemoryId: conflict.active_memory_id,
          type: conflict.type,
          scope: conflict.scope,
          reason: conflict.reason,
          status: conflict.status,
          createdAt: conflict.created_at
        };
      });
  }

  acceptCandidate(id: string): MemoryEntry {
    const candidateId = this.requireText(id, 'memory_candidate_id_empty', '候选记忆 ID 不能为空。', '请提供要接受的候选 ID。');
    const candidate = this.getCandidateRow(candidateId);
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
    const layer = this.targetLayer(candidate);
    const activeEntry: MemoryEntry = {
      id: candidate.id,
      layer,
      type: candidate.type,
      scope: candidate.scope,
      content: this.readMemoryBody(candidate.markdown_path),
      confidence: candidate.confidence,
      priority: candidate.priority,
      status: 'active',
      source: candidate.source,
      sourceRef: candidate.source_ref,
      createdAt: candidate.created_at,
      updatedAt: now
    };
    const markdownPath = this.activeMarkdownPath(activeEntry);

    writeFileSync(markdownPath, this.renderMemoryMarkdown(activeEntry), 'utf8');
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
    this.upsertMemoryFts(activeEntry, markdownPath);
    this.appendOperation(activeEntry.id, 'candidate_accept', { layer, sourceRef: activeEntry.sourceRef });

    return activeEntry;
  }

  rejectCandidate(id: string): MemoryCandidate {
    const candidateId = this.requireText(id, 'memory_candidate_id_empty', '候选记忆 ID 不能为空。', '请提供要拒绝的候选 ID。');
    const candidate = this.getCandidateRow(candidateId);
    const now = new Date().toISOString();
    this.database.db
      .prepare(
        `UPDATE memory_candidates
         SET state = 'rejected', suggested_action = 'none', updated_at = ?, decided_at = ?
         WHERE memory_id = ?`
      )
      .run(now, now, candidate.id);
    this.database.db.prepare("UPDATE memory_entries_index SET status = 'archived', updated_at = ? WHERE id = ?").run(now, candidate.id);
    this.deleteMemoryFts(candidate.id);
    this.appendOperation(candidate.id, 'candidate_reject', { sourceRef: candidate.source_ref });
    return this.listCandidates().filter((item) => item.id === candidate.id)[0];
  }

  writeSessionRecall(request: SessionRecallWriteRequest): SessionRecallEntry {
    const sessionId = this.requireText(
      request.sessionId,
      'session_id_empty',
      '会话回忆 sessionId 不能为空。',
      '请提供要归档的 session ID。'
    );
    const title = this.requireText(request.title, 'session_title_empty', '会话标题不能为空。', '请提供会话标题。');
    const summary = this.requireText(request.summary, 'session_summary_empty', '会话摘要不能为空。', '请提供会话摘要。');
    const scope = this.requireText(request.scope, 'session_scope_empty', '会话 scope 不能为空。', '请提供会话 scope。');
    const content = this.requireText(request.content, 'session_content_empty', '会话全文不能为空。', '请提供会话全文。');
    const sourceRef = this.requireText(request.sourceRef, 'session_source_ref_empty', '会话来源引用不能为空。', '请提供会话来源引用。');
    const now = new Date().toISOString();
    const datePart = now.slice(0, 10);
    const markdownPath = join(this.paths.memoryDir, 'sessions', datePart, `${sessionId}.md`);
    const markdown = [
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
    writeFileSync(markdownPath, markdown, 'utf8');
    this.database.db
      .prepare(
        `INSERT OR REPLACE INTO session_recall_index (id, scope, title, summary, source_ref, markdown_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(sessionId, scope, title, summary, sourceRef, markdownPath, now);
    this.upsertSessionFts({ id: sessionId, title, summary, scope, sourceRef, markdownPath, createdAt: now }, content);
    this.appendOperation(sessionId, 'session_recall_write', { scope, sourceRef });

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
    const query = this.requireText(
      request.query,
      'session_query_empty',
      '会话回忆检索 query 不能为空。',
      '请输入要检索的会话关键词。'
    );
    return {
      query,
      items: this.searchSessionRows({ query, scope: request.scope }).map((row) => ({
        id: row.id,
        title: row.title,
        summary: row.summary,
        scope: row.scope,
        sourceRef: row.source_ref,
        reason: this.hasTable('session_recall_fts') ? 'SQLite FTS5 session match' : 'Markdown session keyword match'
      }))
    };
  }

  deleteMemory(id: string): MemoryDeleteResult {
    const memoryId = this.requireText(id, 'memory_id_empty', '记忆 ID 不能为空。', '请提供要删除的记忆 ID。');
    const row = this.getMemoryRow(memoryId);
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
    this.deleteMemoryFts(memoryId);
    this.appendOperation(memoryId, 'memory_delete', { previousStatus: row.status, recoverable: true });
    return {
      id: memoryId,
      status: 'archived',
      recoverable: true
    };
  }

  restoreMemory(id: string): MemoryDeleteResult {
    const memoryId = this.requireText(id, 'memory_id_empty', '记忆 ID 不能为空。', '请提供要恢复的记忆 ID。');
    const row = this.getMemoryRow(memoryId);
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
      content: this.readMemoryBody(row.markdown_path),
      confidence: row.confidence,
      priority: row.priority,
      status: 'active',
      source: row.source,
      sourceRef: row.source_ref,
      createdAt: row.created_at,
      updatedAt: now
    };
    this.upsertMemoryFts(restoredEntry, row.markdown_path);
    this.appendOperation(memoryId, 'memory_restore', { previousStatus: row.status });
    return {
      id: memoryId,
      status: 'active',
      recoverable: false
    };
  }

  private searchCuratedItems(request: MemorySearchRequest, query: string): MemorySearchResult['items'] {
    const byId = new Map<string, MemorySearchResult['items'][number]>();
    for (const item of this.searchMemoryFts(request, query)) {
      byId.set(item.id, item);
    }
    for (const item of this.searchMemoryFallback(request, query)) {
      if (!byId.has(item.id)) {
        byId.set(item.id, item);
      }
    }
    return [...byId.values()];
  }

  private searchMemoryFts(request: MemorySearchRequest, query: string): MemorySearchResult['items'] {
    if (!this.hasTable('memory_entries_fts')) {
      return [];
    }

    const includeCold = request.includeCold === true;
    const rows =
      request.scope === undefined
        ? (this.database.db
            .prepare(
              `SELECT i.id, i.layer, i.scope, i.confidence, i.source_ref, i.markdown_path
               FROM memory_entries_fts f
               JOIN memory_entries_index i ON i.id = f.memory_id
               WHERE memory_entries_fts MATCH ?
                 AND i.status = 'active'
                 AND (i.layer IN ('hot', 'warm') OR (? = 1 AND i.layer = 'cold'))
               ORDER BY rank
               LIMIT 20`
            )
            .all(query, includeCold ? 1 : 0) as Array<{
            id: string;
            layer: MemoryLayer;
            scope: string;
            confidence: number;
            source_ref: string;
            markdown_path: string;
          }>)
        : (this.database.db
            .prepare(
              `SELECT i.id, i.layer, i.scope, i.confidence, i.source_ref, i.markdown_path
               FROM memory_entries_fts f
               JOIN memory_entries_index i ON i.id = f.memory_id
               WHERE memory_entries_fts MATCH ?
                 AND i.status = 'active'
                 AND i.scope = ?
                 AND (i.layer IN ('hot', 'warm') OR (? = 1 AND i.layer = 'cold'))
               ORDER BY rank
               LIMIT 20`
            )
            .all(query, request.scope, includeCold ? 1 : 0) as Array<{
            id: string;
            layer: MemoryLayer;
            scope: string;
            confidence: number;
            source_ref: string;
            markdown_path: string;
          }>);

    return rows.map((row) => ({
      id: row.id,
      layer: row.layer,
      scope: row.scope,
      confidence: row.confidence,
      sourceRef: row.source_ref,
      reason: 'SQLite FTS5 keyword match',
      summary: this.summarize(this.readMemoryBody(row.markdown_path))
    }));
  }

  private searchMemoryFallback(request: MemorySearchRequest, query: string): MemorySearchResult['items'] {
    const includeCold = request.includeCold === true;
    const rows =
      request.scope === undefined
        ? (this.database.db
            .prepare(
              `SELECT id, layer, scope, confidence, source_ref, markdown_path
               FROM memory_entries_index
               WHERE status = 'active'
                 AND (layer IN ('hot', 'warm') OR (? = 1 AND layer = 'cold'))
               ORDER BY updated_at DESC
               LIMIT 50`
            )
            .all(includeCold ? 1 : 0) as Array<{
            id: string;
            layer: MemoryLayer;
            scope: string;
            confidence: number;
            source_ref: string;
            markdown_path: string;
          }>)
        : (this.database.db
            .prepare(
              `SELECT id, layer, scope, confidence, source_ref, markdown_path
               FROM memory_entries_index
               WHERE status = 'active'
                 AND scope = ?
                 AND (layer IN ('hot', 'warm') OR (? = 1 AND layer = 'cold'))
               ORDER BY updated_at DESC
               LIMIT 50`
            )
            .all(request.scope, includeCold ? 1 : 0) as Array<{
            id: string;
            layer: MemoryLayer;
            scope: string;
            confidence: number;
            source_ref: string;
            markdown_path: string;
          }>);

    const loweredQuery = query.toLocaleLowerCase();
    return rows
      .map((row) => ({ row, content: this.readMemoryBody(row.markdown_path) }))
      .filter(({ content }) => content.toLocaleLowerCase().includes(loweredQuery))
      .map(({ row, content }) => ({
        id: row.id,
        layer: row.layer,
        scope: row.scope,
        confidence: row.confidence,
        sourceRef: row.source_ref,
        reason: 'Markdown fallback keyword match',
        summary: this.summarize(content)
      }));
  }

  private searchSessionItems(request: SessionSearchRequest): MemorySearchResult['items'] {
    return this.searchSessionRows(request).map((row) => ({
      id: row.id,
      layer: 'session',
      scope: row.scope,
      confidence: 1,
      sourceRef: row.source_ref,
      reason: this.hasTable('session_recall_fts') ? 'SQLite FTS5 session match' : 'Markdown session keyword match',
      summary: this.summarize(row.summary)
    }));
  }

  private searchSessionRows(request: SessionSearchRequest): SessionRecallRow[] {
    const query = this.requireText(
      request.query,
      'session_query_empty',
      '会话回忆检索 query 不能为空。',
      '请输入要检索的会话关键词。'
    );
    const rowsById = new Map<string, SessionRecallRow>();

    if (this.hasTable('session_recall_fts')) {
      const ftsRows =
        request.scope === undefined
          ? (this.database.db
              .prepare(
                `SELECT s.id, s.scope, s.title, s.summary, s.source_ref, s.markdown_path, s.created_at
                 FROM session_recall_fts f
                 JOIN session_recall_index s ON s.id = f.session_id
                 WHERE session_recall_fts MATCH ?
                 ORDER BY rank
                 LIMIT 20`
              )
              .all(query) as SessionRecallRow[])
          : (this.database.db
              .prepare(
                `SELECT s.id, s.scope, s.title, s.summary, s.source_ref, s.markdown_path, s.created_at
                 FROM session_recall_fts f
                 JOIN session_recall_index s ON s.id = f.session_id
                 WHERE session_recall_fts MATCH ?
                   AND s.scope = ?
                 ORDER BY rank
                 LIMIT 20`
              )
              .all(query, request.scope) as SessionRecallRow[]);
      for (const row of ftsRows) {
        rowsById.set(row.id, row);
      }
    }

    const fallbackRows =
      request.scope === undefined
        ? (this.database.db
            .prepare(
              `SELECT id, scope, title, summary, source_ref, markdown_path, created_at
               FROM session_recall_index
               ORDER BY created_at DESC
               LIMIT 50`
            )
            .all() as SessionRecallRow[])
        : (this.database.db
            .prepare(
              `SELECT id, scope, title, summary, source_ref, markdown_path, created_at
               FROM session_recall_index
               WHERE scope = ?
               ORDER BY created_at DESC
               LIMIT 50`
            )
            .all(request.scope) as SessionRecallRow[]);
    const loweredQuery = query.toLocaleLowerCase();
    for (const row of fallbackRows) {
      const content = this.readMemoryBody(row.markdown_path);
      const searchable = `${row.title}\n${row.summary}\n${content}`.toLocaleLowerCase();
      if (searchable.includes(loweredQuery) && !rowsById.has(row.id)) {
        rowsById.set(row.id, row);
      }
    }

    return [...rowsById.values()];
  }

  private layerStats(layer: MemoryLayer, directory: string): { entries: number; characters: number; path: string } {
    const rows = this.database.db
      .prepare('SELECT markdown_path FROM memory_entries_index WHERE layer = ? AND status != ?')
      .all(layer, 'archived') as Array<{ markdown_path: string }>;

    let characters = 0;
    for (const row of rows) {
      if (existsSync(row.markdown_path)) {
        characters += readFileSync(row.markdown_path, 'utf8').length;
      }
    }

    if (rows.length === 0 && existsSync(directory)) {
      if (layer === 'hot') {
        const hotPath = join(directory, 'hot_memory.md');
        characters = existsSync(hotPath) ? readFileSync(hotPath, 'utf8').length : 0;
      }
    }

    return { entries: rows.length, characters, path: directory };
  }

  private appendOperation(memoryId: string | null, operationType: string, payload: unknown): void {
    const now = new Date().toISOString();
    const operationId = `memop_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    this.database.db
      .prepare(
        `INSERT INTO memory_operations (id, memory_id, operation_type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(operationId, memoryId, operationType, JSON.stringify(payload), now);
    appendFileSync(
      join(this.paths.logsDir, 'memory_operations.log'),
      `${JSON.stringify({ id: operationId, memoryId, operationType, payload, createdAt: now })}\n`,
      'utf8'
    );
  }

  private validateCandidateInput(entry: Omit<MemoryEntry, 'id' | 'layer' | 'status' | 'createdAt' | 'updatedAt'>): void {
    this.requireText(entry.type, 'memory_type_empty', '记忆 type 不能为空。', '请选择记忆类型。');
    this.requireText(entry.scope, 'memory_scope_empty', '记忆 scope 不能为空。', '请选择记忆作用范围。');
    this.requireText(entry.content, 'memory_content_empty', '记忆内容不能为空。', '请输入要保存的记忆内容。');
    this.requireText(entry.priority, 'memory_priority_empty', '记忆 priority 不能为空。', '请选择记忆优先级。');
    this.requireText(entry.source, 'memory_source_empty', '记忆 source 不能为空。', '请提供记忆来源。');
    this.requireText(entry.sourceRef, 'memory_source_ref_empty', '记忆 sourceRef 不能为空。', '请提供可追溯来源。');
    if (entry.confidence < 0 || entry.confidence > 1) {
      throw new RocDomainError({
        code: 'memory_confidence_invalid',
        message: '记忆 confidence 必须在 0 到 1 之间。',
        category: 'validation',
        retryable: false,
        userAction: '请使用 0 到 1 之间的置信度。'
      });
    }
  }

  private requireText(value: string, code: string, message: string, userAction: string): string {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new RocDomainError({
        code,
        message,
        category: 'validation',
        retryable: false,
        userAction
      });
    }
    return trimmed;
  }

  private detectConflicts(entry: MemoryEntry): Array<{ activeMemoryId: string; reason: string }> {
    const rows = this.database.db
      .prepare(
        `SELECT id, markdown_path
         FROM memory_entries_index
         WHERE status = 'active' AND type = ? AND scope = ?`
      )
      .all(entry.type, entry.scope) as Array<{ id: string; markdown_path: string }>;
    const conflicts: Array<{ activeMemoryId: string; reason: string }> = [];
    for (const row of rows) {
      const activeContent = this.readMemoryBody(row.markdown_path);
      if (this.isConflicting(activeContent, entry.content)) {
        conflicts.push({
          activeMemoryId: row.id,
          reason: 'same_type_scope_contradiction_or_duplicate'
        });
      }
    }
    return conflicts;
  }

  private isConflicting(activeContent: string, candidateContent: string): boolean {
    const activeNormalized = this.normalizeForConflict(activeContent);
    const candidateNormalized = this.normalizeForConflict(candidateContent);
    if (activeNormalized.length === 0 || candidateNormalized.length === 0) {
      return false;
    }
    if (activeNormalized === candidateNormalized) {
      return true;
    }
    const activeNegation = this.hasNegation(activeContent);
    const candidateNegation = this.hasNegation(candidateContent);
    return activeNegation !== candidateNegation && this.tokenOverlap(activeContent, candidateContent) >= 0.6;
  }

  private normalizeForConflict(content: string): string {
    return content
      .replace(/^---[\s\S]*?---/m, '')
      .replaceAll('不', '')
      .replaceAll('不要', '')
      .replaceAll('不能', '')
      .replace(/\bnot\b/g, '')
      .replace(/\bdoes\s+not\b/g, '')
      .replace(/[，。！？、；：,.!?:;\s]/g, '')
      .toLocaleLowerCase();
  }

  private hasNegation(content: string): boolean {
    return content.includes('不') || content.toLocaleLowerCase().includes('not ');
  }

  private tokenOverlap(left: string, right: string): number {
    const leftTokens = this.significantTokens(left);
    const rightTokens = this.significantTokens(right);
    if (leftTokens.length === 0 || rightTokens.length === 0) {
      return 0;
    }
    const rightSet = new Set(rightTokens);
    const overlapCount = leftTokens.filter((token) => rightSet.has(token)).length;
    return overlapCount / Math.max(leftTokens.length, rightTokens.length);
  }

  private significantTokens(content: string): string[] {
    return content
      .toLocaleLowerCase()
      .replace(/[，。！？、；：,.!?:;()\[\]{}]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length > 2 && token !== 'not' && token !== 'does');
  }

  private getMemoryRow(id: string): MemoryIndexRow {
    const row = this.database.db
      .prepare(
        `SELECT id, layer, type, scope, status, confidence, priority, source, source_ref, markdown_path, created_at, updated_at
         FROM memory_entries_index
         WHERE id = ?`
      )
      .get(id) as MemoryIndexRow | undefined;

    if (row === undefined) {
      throw new RocDomainError({
        code: 'memory_not_found',
        message: `找不到记忆条目 ${id}。`,
        category: 'not_found',
        retryable: false,
        userAction: '请刷新记忆中心或检查记忆 ID。'
      });
    }
    return row;
  }

  private getCandidateRow(id: string): CandidateRow {
    const row = this.database.db
      .prepare(
        `SELECT i.id, i.layer, i.type, i.scope, i.status, i.confidence, i.priority, i.source, i.source_ref, i.markdown_path,
                i.created_at, i.updated_at, c.state AS candidate_state, c.suggested_action
         FROM memory_candidates c
         JOIN memory_entries_index i ON i.id = c.memory_id
         WHERE c.memory_id = ?`
      )
      .get(id) as CandidateRow | undefined;

    if (row === undefined) {
      throw new RocDomainError({
        code: 'memory_candidate_not_found',
        message: `找不到候选记忆 ${id}。`,
        category: 'not_found',
        retryable: false,
        userAction: '请刷新候选记忆列表。'
      });
    }
    return row;
  }

  private countCandidateConflicts(candidateId: string): number {
    const row = this.database.db
      .prepare("SELECT COUNT(*) AS count FROM memory_conflicts WHERE candidate_id = ? AND status = 'open'")
      .get(candidateId) as { count: number };
    return row.count;
  }

  private targetLayer(row: CandidateRow): MemoryLayer {
    const canEnterHot =
      row.scope === 'global' &&
      (row.priority === 'critical' || row.priority === 'high') &&
      (row.source === 'user_explicit' || row.source === 'consolidation');
    return canEnterHot ? 'hot' : 'warm';
  }

  private activeMarkdownPath(entry: MemoryEntry): string {
    if (entry.layer === 'hot') {
      return join(this.paths.memoryDir, 'hot', `${entry.id}.md`);
    }
    if (entry.layer === 'warm') {
      return join(this.paths.memoryDir, 'warm', this.warmFileForType(entry.type));
    }
    if (entry.layer === 'cold') {
      return join(this.paths.memoryDir, 'cold', 'archive', `${entry.id}.md`);
    }
    return join(this.paths.memoryDir, entry.layer, `${entry.id}.md`);
  }

  private warmFileForType(type: MemoryType): string {
    if (type === 'preference') {
      return 'preferences.md';
    }
    if (type === 'feedback') {
      return 'feedback.md';
    }
    if (type === 'project_context') {
      return 'project_context.md';
    }
    if (type === 'process_skill') {
      return 'process_skills.md';
    }
    return 'knowledge_notes.md';
  }

  private upsertMemoryFts(entry: MemoryEntry, markdownPath: string): void {
    if (!this.hasTable('memory_entries_fts')) {
      return;
    }
    const content = this.readMemoryBody(markdownPath);
    this.deleteMemoryFts(entry.id);
    this.database.db
      .prepare(
        `INSERT INTO memory_entries_fts (memory_id, content, summary, scope, layer)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(entry.id, content, this.summarize(content), entry.scope, entry.layer);
  }

  private deleteMemoryFts(id: string): void {
    if (!this.hasTable('memory_entries_fts')) {
      return;
    }
    this.database.db.prepare('DELETE FROM memory_entries_fts WHERE memory_id = ?').run(id);
  }

  private upsertSessionFts(entry: SessionRecallEntry, content: string): void {
    if (!this.hasTable('session_recall_fts')) {
      return;
    }
    this.database.db.prepare('DELETE FROM session_recall_fts WHERE session_id = ?').run(entry.id);
    this.database.db
      .prepare(
        `INSERT INTO session_recall_fts (session_id, title, summary, content, scope)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(entry.id, entry.title, entry.summary, content, entry.scope);
  }

  private searchDegradedReason(): string {
    const fullTextStatus = this.hasTable('memory_entries_fts') ? 'FTS5 is available.' : 'FTS5 is unavailable.';
    return `Vector index is not configured. ${fullTextStatus} Search falls back to deterministic local indexes.`;
  }

  private summarize(content: string): string {
    return content.replace(/\s+/g, ' ').trim().slice(0, 180);
  }

  private renderMemoryMarkdown(entry: MemoryEntry): string {
    return [
      '---',
      `id: ${entry.id}`,
      `type: ${entry.type}`,
      `scope: ${entry.scope}`,
      `layer: ${entry.layer}`,
      `confidence: ${entry.confidence}`,
      `priority: ${entry.priority}`,
      `status: ${entry.status}`,
      `source: ${entry.source}`,
      `source_ref: ${entry.sourceRef}`,
      `created_at: ${entry.createdAt}`,
      `updated_at: ${entry.updatedAt}`,
      '---',
      '',
      entry.content,
      ''
    ].join('\n');
  }

  private readMemoryBody(markdownPath: string): string {
    if (!existsSync(markdownPath)) {
      return '';
    }
    const content = readFileSync(markdownPath, 'utf8');
    if (!content.startsWith('---')) {
      return content;
    }
    const closingIndex = content.indexOf('\n---', 3);
    if (closingIndex === -1) {
      return content;
    }
    return content.slice(closingIndex + 4).trim();
  }

  private hasTable(table: string): boolean {
    const row = this.database.db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = ?")
      .get(table) as { name: string } | undefined;
    return row !== undefined;
  }

  private ensureFile(path: string, content: string): void {
    if (!existsSync(path)) {
      writeFileSync(path, content, 'utf8');
    }
  }
}
