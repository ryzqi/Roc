import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { LiteratureSearchInput, LiteratureSearchResult } from '../../../shared/schemas/literature-import';
import type { LiteratureExecutionContext } from '../../services/literature-context';
import type { LiteratureRequestAudit } from './literature-service';

export class LiteratureRequestAuditError extends Error {
  constructor(cause: unknown) { super('literature_request_audit_failed', {cause}); }
}

/** Execution/transport history survives candidate expiry, cancellation and process restart. */
export class LiteratureSearchLedger {
  constructor(private readonly db: Database, private readonly now: () => string) {}

  begin(context: LiteratureExecutionContext, request: LiteratureSearchInput): string {
    const id = `search_exec_${randomUUID()}`;
    this.db.prepare(`INSERT INTO research_literature_search_executions
      (id,owner,project_id,run_id,request_json,status,created_at) VALUES (?,?,?,?,?,'running',?)`)
      .run(id, context.owner, context.projectId, context.runId ?? null, JSON.stringify(request), this.now());
    return id;
  }

  audit(executionId: string): LiteratureRequestAudit {
    return (phase, source, receipt) => {
      try {
        if (phase === 'started') {
          this.db.prepare(`INSERT INTO research_literature_request_receipts
            (execution_id,source,attempt,state,receipt_json) VALUES (?,?,?,'dispatched',?)`)
            .run(executionId, source, receipt.attempt, JSON.stringify(receipt));
        } else {
          const updated = this.db.prepare(`UPDATE research_literature_request_receipts
            SET state='received',receipt_json=? WHERE execution_id=? AND source=? AND attempt=? AND state='dispatched'`)
            .run(JSON.stringify(receipt), executionId, source, receipt.attempt);
          if (updated.changes !== 1) throw new Error('literature_request_receipt_missing');
        }
      } catch (cause) { throw new LiteratureRequestAuditError(cause); }
    };
  }

  finish(id: string, status: LiteratureSearchResult['status'] | 'cancelled' | 'interrupted', searchId: string | null, errorCode: string | null): void {
    this.db.transaction(() => {
      const updated = this.db.prepare(`UPDATE research_literature_search_executions
        SET status=?,search_id=?,error_code=?,ended_at=? WHERE id=? AND status='running'`)
        .run(status, searchId, errorCode, this.now(), id);
      if (updated.changes !== 1) throw new Error('literature_search_execution_not_active');
      this.db.prepare(`UPDATE research_literature_request_receipts SET state='unknown'
        WHERE execution_id=? AND state='dispatched'`).run(id);
    })();
  }

  recover(): void {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE research_literature_request_receipts SET state='unknown'
        WHERE state='dispatched' AND execution_id IN (SELECT id FROM research_literature_search_executions WHERE status='running')`).run();
      this.db.prepare(`UPDATE research_literature_search_executions
        SET status='interrupted',error_code='literature_search_interrupted',ended_at=? WHERE status='running'`).run(this.now());
    })();
  }
}
