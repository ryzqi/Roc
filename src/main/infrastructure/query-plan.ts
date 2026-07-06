import type { Database as DatabaseConnection } from 'better-sqlite3';

export type QueryPlanRow = {
  id: number;
  parent: number;
  notused: number;
  detail: string;
};

export function explainQueryPlan(
  db: DatabaseConnection,
  sql: string,
  params: readonly unknown[] = []
): QueryPlanRow[] {
  if (sql.trim().length === 0) {
    throw new Error('query_plan_sql_empty');
  }
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as QueryPlanRow[];
}

export function assertUsesIndex(plan: readonly QueryPlanRow[], indexName: string): void {
  if (indexName.trim().length === 0) {
    throw new Error('query_plan_index_empty');
  }
  if (!plan.some((row) => row.detail.includes(indexName))) {
    throw new Error(`query_plan_index_not_used:${indexName}`);
  }
}
