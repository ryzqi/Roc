import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseService } from '../database-service';
import type { RocPaths } from '../paths';

export function appendOperation(
  database: DatabaseService,
  paths: RocPaths,
  memoryId: string | null,
  operationType: string,
  payload: unknown
): void {
  const now = new Date().toISOString();
  const operationId = `memop_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  database.db
    .prepare(
      `INSERT INTO memory_operations (id, memory_id, operation_type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(operationId, memoryId, operationType, JSON.stringify(payload), now);
  appendFileSync(
    join(paths.logsDir, 'memory_operations.log'),
    `${JSON.stringify({ id: operationId, memoryId, operationType, payload, createdAt: now })}\n`,
    'utf8'
  );
}
