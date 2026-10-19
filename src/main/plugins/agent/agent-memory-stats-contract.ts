import type { Database as DatabaseConnection } from 'better-sqlite3';

/**
 * `memory.status` facts that live in the **agent** database.
 *
 * The memory panel reports three things it cannot read itself: how many session messages exist,
 * how old the oldest one is, and whether the full-text index behind `agent.sessions.search`
 * (`session_messages_fts`) is usable. `session_messages` belongs to `@roc/plugin-agent`, while the
 * memory plugin only owns `@roc/plugin-memory`, so the numbers cross plugin boundaries as a
 * contract — the same shape `AgentTaskHistoryContract` already uses for agent history.
 *
 * The point of the contract is that these are **facts, not placeholders**: the panel used to
 * report a hardcoded `0 rows` / `oldestAt: null` / `healthy: true`, which read as "the session
 * archive is empty and fine" no matter what the database actually held.
 */

export type AgentSessionStats = {
  totalRows: number;
  oldestAt: string | null;
};

/**
 * `status` is a discriminated companion to `healthy`, not a second opinion:
 *  - `ready`       — the index exists and answered a probe query;
 *  - `unavailable` — the index is missing or its shadow tables are inconsistent.
 *
 * It stays a small enum so the renderer has a stable machine-readable value to show, while the
 * boolean is what the panel colours.
 */
export type AgentFullTextIndexHealth = {
  healthy: boolean;
  status: 'ready' | 'unavailable';
};

/** A token with at least three code points, because `session_messages_fts` uses the trigram tokenizer. */
const fullTextProbeToken = 'roc';

export class AgentMemoryStatsContract {
  constructor(private readonly agentDb: DatabaseConnection) {}

  readSessionStats(): AgentSessionStats {
    const row = this.agentDb
      .prepare('SELECT COUNT(*) AS total_rows, MIN(created_at) AS oldest_at FROM session_messages')
      .get() as { total_rows: number; oldest_at: string | null } | undefined;
    return {
      totalRows: row === undefined ? 0 : row.total_rows,
      oldestAt: row === undefined ? null : row.oldest_at
    };
  }

  readFullTextIndexHealth(): AgentFullTextIndexHealth {
    return this.canQueryFullTextIndex()
      ? { healthy: true, status: 'ready' }
      : { healthy: false, status: 'unavailable' };
  }

  /**
   * Probes the index instead of only looking it up in `sqlite_master`: an FTS5 table whose shadow
   * tables were dropped still appears in `sqlite_master`, so existence alone would report a broken
   * index as healthy. A `MATCH` query goes through the shadow tables and throws when they disagree
   * with the content table.
   */
  private canQueryFullTextIndex(): boolean {
    try {
      this.agentDb
        .prepare('SELECT rowid FROM session_messages_fts WHERE session_messages_fts MATCH ? LIMIT 1')
        .get(fullTextProbeToken);
      return true;
    } catch {
      return false;
    }
  }
}
