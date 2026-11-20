import { createHash } from 'node:crypto';
import type { Database as DatabaseConnection, Statement } from 'better-sqlite3';
import type { PerformanceObserverService } from '../services/performance-observer-service';

/**
 * Instrument execution, not consumer work. Keep the native statement object and its chainable
 * bind/pluck/raw APIs intact. Transactions still execute on the original connection.
 */
export function observeDatabase(
  db: DatabaseConnection,
  database: string,
  observer: PerformanceObserverService
): void {
  const prepare = db.prepare;
  db.prepare = function (sql: string): Statement {
    const statement = Reflect.apply(prepare, db, [sql]) as Statement;
    const hash = createHash('sha256').update(sql).digest('hex');
    for (const method of ['get', 'all', 'run'] as const) {
      const execute = statement[method];
      Object.defineProperty(statement, method, {
        configurable: true,
        writable: true,
        value: (...args: unknown[]) => observer.observeSql(database, hash, () => Reflect.apply(execute, statement, args))
      });
    }
    const iterate = statement.iterate;
    Object.defineProperty(statement, 'iterate', {
      configurable: true,
      writable: true,
      value: (...args: unknown[]) => {
        const iterator = Reflect.apply(iterate, statement, args) as IterableIterator<unknown>;
        return {
          [Symbol.iterator]() { return this; },
          next: () => observer.observeSql(database, hash, () => iterator.next()),
          return: () => iterator.return?.() ?? { done: true, value: undefined },
          throw: (error: unknown) => {
            if (iterator.throw !== undefined) return iterator.throw(error);
            throw error;
          }
        };
      }
    });
    return statement;
  } as DatabaseConnection['prepare'];
  const exec = db.exec;
  db.exec = (sql: string) => observer.observeSql(database, createHash('sha256').update(sql).digest('hex'),
    () => Reflect.apply(exec, db, [sql]) as DatabaseConnection);
}
