import type { AppSettings } from '../../../shared/types';
import type { DatabaseService } from '../database-service';

type PrecompactionSettings = Pick<
  AppSettings['memory'],
  'preCompactionFlushEnabled' | 'preCompactionTokenThreshold' | 'preCompactionContextWindowTokens'
>;

export class PrecompactionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly settings: () => PrecompactionSettings
  ) {}

  shouldTrigger(threadId: string, ratio: number, _tokensUsed: number): boolean {
    const settings = this.settings();
    if (!settings.preCompactionFlushEnabled) {
      return false;
    }
    if (ratio < settings.preCompactionTokenThreshold) {
      return false;
    }

    const row = this.database.db
      .prepare('SELECT flushed_at FROM memory_flush_marks WHERE thread_id = ?')
      .get(threadId) as { flushed_at: string } | undefined;
    if (row === undefined) {
      return true;
    }

    const last = new Date(row.flushed_at).getTime();
    const ageHours = (Date.now() - last) / 3_600_000;
    return ageHours >= 24;
  }

  contextWindowTokens(): number {
    return this.settings().preCompactionContextWindowTokens;
  }

  markFlushed(threadId: string, ratio: number, tokensUsed: number): void {
    this.database.db.prepare(
      `INSERT INTO memory_flush_marks (thread_id, flushed_at, ratio, tokens_used)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         flushed_at = excluded.flushed_at,
         ratio = excluded.ratio,
         tokens_used = excluded.tokens_used`
    ).run(threadId, new Date().toISOString(), ratio, tokensUsed);
  }

  buildFlushPrompt(input: { ratio: number; tokensUsed: number; contextWindow: number }): string {
    const pct = Math.round(input.ratio * 100);
    return [
      '<PRE_COMPACTION_FLUSH>',
      `Context usage: ${pct}% (${input.tokensUsed}/${input.contextWindow} tokens).`,
      'Compaction is imminent and older detail will be summarized away.',
      'This is your last chance to persist anything important to long-term memory:',
      '',
      '1. Critical user facts not yet in USER.md -> Edit /memory/global/USER.md',
      '2. Project decisions or knowledge not yet in MEMORY.md -> Edit /memory/workspaces/current/MEMORY.md',
      '3. New rules or patterns not yet in AGENTS.md -> Edit /memory/workspaces/current/AGENTS.md',
      '',
      'If nothing needs persisting, reply only with FLUSH_DONE.',
      'After all edits are done, reply only with the literal string FLUSH_DONE.',
      'The user will NOT see this turn.',
      '</PRE_COMPACTION_FLUSH>'
    ].join('\n');
  }
}
