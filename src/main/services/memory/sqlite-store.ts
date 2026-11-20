import { BaseStore } from '@langchain/langgraph';
import type {
  GetOperation,
  Item,
  ListNamespacesOperation,
  MatchCondition,
  Operation,
  OperationResults,
  PutOperation,
  SearchOperation
} from '@langchain/langgraph';
import type { Database as DatabaseConnection, Statement } from 'better-sqlite3';
import { memoryMutationsFor, type MemoryMutationCoordinator } from './memory-mutations';

const namespaceDelimiter = '\x1f';

type StoreValue = Record<string, unknown>;

type StoreRow = {
  namespace_json: string;
  namespace_key: string;
  key: string;
  value_json: string;
  created_at: string;
  updated_at: string;
};

export class RocSqliteStore extends BaseStore {
  readonly memoryMutations: MemoryMutationCoordinator;
  private readonly statements = new Map<string, Statement>();
  private readonly queryStrategy: 'sql' | 'legacy';

  constructor(private readonly db: DatabaseConnection, options: { queryStrategy?: 'sql' | 'legacy' } = {}) {
    super();
    this.memoryMutations = memoryMutationsFor(db);
    this.queryStrategy = options.queryStrategy ?? (process.env.ROC_PERF_MEMORY_SQL_V2 === '0' ? 'legacy' : 'sql');
  }

  override async get(namespace: string[], key: string): Promise<Item | null> {
    return (await this.batch([{ namespace, key }]))[0];
  }

  override async search(
    namespacePrefix: string[],
    options: { filter?: Record<string, unknown>; limit?: number; offset?: number; query?: string } = {}
  ): Promise<Item[]> {
    return (
      await this.batch([
        {
          namespacePrefix,
          filter: options.filter,
          limit: options.limit,
          offset: options.offset,
          query: options.query
        }
      ])
    )[0];
  }

  override async put(
    namespace: string[],
    key: string,
    value: Record<string, unknown>,
    index?: false | string[]
  ): Promise<void> {
    await this.batch([{ namespace, key, value, index }]);
  }

  override async delete(namespace: string[], key: string): Promise<void> {
    await this.batch([{ namespace, key, value: null }]);
  }

  override async listNamespaces(options: {
    prefix?: string[];
    suffix?: string[];
    maxDepth?: number;
    limit?: number;
    offset?: number;
  } = {}): Promise<string[][]> {
    const matchConditions: MatchCondition[] = [];
    if (options.prefix !== undefined) {
      matchConditions.push({ matchType: 'prefix', path: options.prefix });
    }
    if (options.suffix !== undefined) {
      matchConditions.push({ matchType: 'suffix', path: options.suffix });
    }
    return (
      await this.batch([
        {
          matchConditions: matchConditions.length === 0 ? undefined : matchConditions,
          maxDepth: options.maxDepth,
          limit: options.limit === undefined ? 100 : options.limit,
          offset: options.offset === undefined ? 0 : options.offset
        }
      ])
    )[0];
  }

  async batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    const results: unknown[] = [];
    for (const operation of operations) {
      if (isSearchOperation(operation)) {
        results.push(this.searchSync(operation));
        continue;
      }
      if (isPutOperation(operation)) {
        if (operation.value === null) {
          this.deleteSync(operation.namespace, operation.key);
        } else {
          this.putSync(operation.namespace, operation.key, operation.value);
        }
        results.push(undefined);
        continue;
      }
      if (isGetOperation(operation)) {
        results.push(this.getSync(operation.namespace, operation.key));
        continue;
      }
      if (isListNamespacesOperation(operation)) {
        results.push(this.listNamespacesSync(operation));
        continue;
      }
      throw new Error('unsupported_store_operation');
    }
    return results as OperationResults<Op>;
  }

  private getSync(namespace: readonly string[], key: string): Item | null {
    validateNamespace(namespace);
    validateKey(key);
    const row = this.db
      .prepare(
        `SELECT namespace_json, namespace_key, key, value_json, created_at, updated_at
         FROM langgraph_store_items
         WHERE namespace_key = ? AND key = ?`
      )
      .get(toNamespaceKey(namespace), key) as StoreRow | undefined;
    if (row === undefined) {
      return null;
    }
    return rowToItem(row);
  }

  private putSync(namespace: readonly string[], key: string, value: StoreValue): void {
    validateNamespace(namespace);
    validateKey(key);
    validateStoreValue(value);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO langgraph_store_items (namespace_key, namespace_json, key, value_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(namespace_key, key) DO UPDATE SET
           namespace_json = excluded.namespace_json,
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`
      )
      .run(toNamespaceKey(namespace), JSON.stringify(namespace), key, JSON.stringify(value), now, now);
  }

  private deleteSync(namespace: readonly string[], key: string): void {
    validateNamespace(namespace);
    validateKey(key);
    this.db
      .prepare('DELETE FROM langgraph_store_items WHERE namespace_key = ? AND key = ?')
      .run(toNamespaceKey(namespace), key);
  }

  private searchSync(operation: SearchOperation): Item[] {
    if (this.queryStrategy === 'legacy') return this.searchLegacy(operation);
    validateNamespacePrefix(operation.namespacePrefix);
    const range = namespaceRange(operation.namespacePrefix);
    const statement = this.statement(
      `SELECT namespace_json, namespace_key, key, value_json, created_at, updated_at
       FROM langgraph_store_items ${range.where} ORDER BY namespace_key, key`
    );
    const items: Item[] = [];
    const offset = operation.offset ?? 0;
    const limit = operation.limit ?? 10;
    let matched = 0;
    let filterFailure: { error: unknown } | undefined;
    let queryFailure: { error: unknown } | undefined;
    for (const row of statement.iterate(...range.parameters) as IterableIterator<StoreRow>) {
      // Parsing used to precede every filter/query. A later parse/filter error must still
      // take precedence over an earlier query error, even after the requested page is full.
      const item = rowToItem(row);
      if (!hasNamespacePrefix(item.namespace, operation.namespacePrefix) || filterFailure !== undefined) continue;
      let filtered: boolean;
      try {
        filtered = matchesFilter(item.value, operation.filter);
      } catch (error) {
        filterFailure = { error };
        continue;
      }
      if (!filtered || queryFailure !== undefined) continue;
      try {
        if (!matchesQuery(item.value, operation.query)) continue;
      } catch (error) {
        queryFailure = { error };
        continue;
      }
      if (matched >= offset && items.length < limit) items.push(item);
      matched += 1;
    }
    if (filterFailure !== undefined) throw filterFailure.error;
    if (queryFailure !== undefined) throw queryFailure.error;
    // Preserve lazy request validation: filter/query errors precede pagination errors.
    applyPagination([], operation.offset, operation.limit);
    return items;
  }

  private listNamespacesSync(operation: ListNamespacesOperation): string[][] {
    if (this.queryStrategy === 'legacy') return this.listNamespacesLegacy(operation);
    const first = operation.matchConditions?.[0];
    // Only the first valid prefix can be safely narrowed without hiding errors in
    // earlier conditions. Wildcards retain their existing matching semantics.
    const prefix = first?.matchType === 'prefix' && Array.isArray(first.path) &&
      first.path.every((label) => isValidNamespaceLabel(label, true))
      ? first.path.slice(0, first.path.indexOf('*') < 0 ? first.path.length : first.path.indexOf('*')) : [];
    const range = namespaceRange(prefix);
    const statement = this.statement(
      `SELECT namespace_json, namespace_key, MIN(rowid) AS first_rowid
       FROM langgraph_store_items ${range.where}
       GROUP BY namespace_json, namespace_key ORDER BY first_rowid`
    );
    const unique = new Map<string, string[]>();
    for (const row of statement.iterate(...range.parameters) as IterableIterator<Pick<StoreRow, 'namespace_json' | 'namespace_key'>>) {
      const namespace = parseNamespace(row.namespace_json);
      if (matchesNamespaceConditions(namespace, operation.matchConditions)) unique.set(toNamespaceKey(namespace), namespace);
    }
    if (operation.maxDepth !== undefined) {
      validateMaxDepth(operation.maxDepth);
      const truncated = new Map<string, string[]>();
      for (const namespace of unique.values()) {
        const value = namespace.slice(0, operation.maxDepth);
        truncated.set(toNamespaceKey(value), value);
      }
      return applyPagination([...truncated.values()].sort(compareNamespaces), operation.offset, operation.limit);
    }
    return applyPagination([...unique.values()].sort(compareNamespaces), operation.offset, operation.limit);
  }

  private statement(sql: string): Statement {
    let statement = this.statements.get(sql);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private searchLegacy(operation: SearchOperation): Item[] {
    validateNamespacePrefix(operation.namespacePrefix);
    const rows = this.db
      .prepare(
        `SELECT namespace_json, namespace_key, key, value_json, created_at, updated_at
         FROM langgraph_store_items
         ORDER BY namespace_key, key`
      )
      .all() as StoreRow[];
    const items = rows
      .map(rowToItem)
      .filter((item) => hasNamespacePrefix(item.namespace, operation.namespacePrefix))
      .filter((item) => matchesFilter(item.value, operation.filter))
      .filter((item) => matchesQuery(item.value, operation.query));
    return applyPagination(items, operation.offset, operation.limit);
  }

  private listNamespacesLegacy(operation: ListNamespacesOperation): string[][] {
    const rows = this.db.prepare('SELECT DISTINCT namespace_json, namespace_key FROM langgraph_store_items').all() as Array<
      Pick<StoreRow, 'namespace_json' | 'namespace_key'>
    >;
    let namespaces = rows
      .map((row) => parseNamespace(row.namespace_json))
      .filter((namespace) => matchesNamespaceConditions(namespace, operation.matchConditions));
    if (operation.maxDepth !== undefined) {
      validateMaxDepth(operation.maxDepth);
      namespaces = namespaces.map((namespace) => namespace.slice(0, operation.maxDepth));
    }
    const unique = new Map<string, string[]>();
    for (const namespace of namespaces) {
      unique.set(toNamespaceKey(namespace), namespace);
    }
    const sorted = [...unique.values()].sort(compareNamespaces);
    return applyPagination(sorted, operation.offset, operation.limit);
  }
}

function namespaceRange(prefix: readonly string[]): { where: string; parameters: string[] } {
  if (prefix.length === 0) return { where: '', parameters: [] };
  const encoded = toNamespaceKey(prefix);
  return { where: 'WHERE namespace_key = ? OR (namespace_key >= ? AND namespace_key < ?)',
    parameters: [encoded, encoded + namespaceDelimiter, encoded + '\x20'] };
}

function isValidNamespaceLabel(label: string, allowWildcard: boolean): boolean {
  return allowWildcard && label === '*' ||
    typeof label === 'string' && label.length > 0 && !label.includes('.') && !label.includes(namespaceDelimiter);
}

function isSearchOperation(operation: Operation): operation is SearchOperation {
  return 'namespacePrefix' in operation;
}

function isPutOperation(operation: Operation): operation is PutOperation {
  return 'namespace' in operation && 'key' in operation && Object.prototype.hasOwnProperty.call(operation, 'value');
}

function isGetOperation(operation: Operation): operation is GetOperation {
  return 'namespace' in operation && 'key' in operation && !Object.prototype.hasOwnProperty.call(operation, 'value');
}

function isListNamespacesOperation(operation: Operation): operation is ListNamespacesOperation {
  return !('namespacePrefix' in operation) && !('namespace' in operation);
}

function validateNamespace(namespace: readonly string[]): void {
  if (!Array.isArray(namespace) || namespace.length === 0) {
    throw new Error('invalid_store_namespace');
  }
  for (const label of namespace) {
    validateNamespaceLabel(label, false);
  }
  if (namespace[0] === 'langgraph') {
    throw new Error('invalid_store_namespace');
  }
}

function validateNamespacePrefix(namespace: readonly string[]): void {
  if (!Array.isArray(namespace)) {
    throw new Error('invalid_store_namespace');
  }
  for (const label of namespace) {
    validateNamespaceLabel(label, false);
  }
}

function validateNamespaceLabel(label: string, allowWildcard: boolean): void {
  if (allowWildcard && label === '*') {
    return;
  }
  if (typeof label !== 'string' || label.length === 0 || label.includes('.') || label.includes(namespaceDelimiter)) {
    throw new Error('invalid_store_namespace');
  }
}

function validateKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('invalid_store_key');
  }
}

function validateStoreValue(value: StoreValue): void {
  if (!isPlainRecord(value)) {
    throw new Error('invalid_store_value');
  }
}

function validateMaxDepth(maxDepth: number): void {
  if (!Number.isInteger(maxDepth) || maxDepth <= 0) {
    throw new Error('invalid_store_max_depth');
  }
}

function toNamespaceKey(namespace: readonly string[]): string {
  return namespace.join(namespaceDelimiter);
}

function rowToItem(row: StoreRow): Item {
  return {
    key: row.key,
    namespace: parseNamespace(row.namespace_json),
    value: parseValue(row.value_json),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at)
  };
}

function parseNamespace(raw: string): string[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error('invalid_store_namespace_json');
  }
  return parsed;
}

function parseValue(raw: string): StoreValue {
  const parsed = JSON.parse(raw) as unknown;
  if (!isPlainRecord(parsed)) {
    throw new Error('invalid_store_value_json');
  }
  return parsed;
}

function hasNamespacePrefix(namespace: readonly string[], prefix: readonly string[]): boolean {
  if (prefix.length > namespace.length) {
    return false;
  }
  return prefix.every((label, index) => namespace[index] === label);
}

function matchesNamespaceConditions(namespace: readonly string[], conditions: readonly MatchCondition[] | undefined): boolean {
  if (conditions === undefined || conditions.length === 0) {
    return true;
  }
  return conditions.every((condition) => matchesNamespaceCondition(namespace, condition));
}

function matchesNamespaceCondition(namespace: readonly string[], condition: MatchCondition): boolean {
  for (const label of condition.path) {
    validateNamespaceLabel(label, true);
  }
  if (condition.matchType === 'prefix') {
    if (condition.path.length > namespace.length) {
      return false;
    }
    return condition.path.every((label, index) => label === '*' || namespace[index] === label);
  }
  if (condition.matchType === 'suffix') {
    if (condition.path.length > namespace.length) {
      return false;
    }
    const offset = namespace.length - condition.path.length;
    return condition.path.every((label, index) => label === '*' || namespace[offset + index] === label);
  }
  throw new Error('unsupported_namespace_match_type');
}

function matchesFilter(value: StoreValue, filter: Record<string, unknown> | undefined): boolean {
  if (filter === undefined) {
    return true;
  }
  return Object.entries(filter).every(([key, expected]) => matchesFilterValue(value[key], expected));
}

function matchesFilterValue(actual: unknown, expected: unknown): boolean {
  if (isPlainRecord(expected)) {
    return Object.entries(expected).every(([operator, operand]) => matchesFilterOperator(actual, operator, operand));
  }
  return valuesEqual(actual, expected);
}

function matchesFilterOperator(actual: unknown, operator: string, operand: unknown): boolean {
  if (operator === '$eq') {
    return valuesEqual(actual, operand);
  }
  if (operator === '$ne') {
    return !valuesEqual(actual, operand);
  }
  if (operator === '$gt') {
    return compareOrdered(actual, operand, (left, right) => left > right);
  }
  if (operator === '$gte') {
    return compareOrdered(actual, operand, (left, right) => left >= right);
  }
  if (operator === '$lt') {
    return compareOrdered(actual, operand, (left, right) => left < right);
  }
  if (operator === '$lte') {
    return compareOrdered(actual, operand, (left, right) => left <= right);
  }
  throw new Error('unsupported_store_filter_operator');
}

function compareOrdered(actual: unknown, operand: unknown, compare: (left: number, right: number) => boolean): boolean {
  if (typeof actual !== 'number' || typeof operand !== 'number') {
    return false;
  }
  return compare(actual, operand);
}

function matchesQuery(value: StoreValue, query: string | undefined): boolean {
  if (query === undefined || query.length === 0) {
    return true;
  }
  return JSON.stringify(value).toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function applyPagination<T>(items: T[], offset: number | undefined, limit: number | undefined): T[] {
  const start = offset === undefined ? 0 : offset;
  const count = limit === undefined ? 10 : limit;
  if (!Number.isInteger(start) || start < 0 || !Number.isInteger(count) || count < 0) {
    throw new Error('invalid_store_pagination');
  }
  return items.slice(start, start + count);
}

function compareNamespaces(left: readonly string[], right: readonly string[]): number {
  return toNamespaceKey(left).localeCompare(toNamespaceKey(right));
}

function isPlainRecord(value: unknown): value is StoreValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
