import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import {
  BaseStore,
  type GetOperation,
  type Item,
  type ListNamespacesOperation,
  type MatchCondition,
  type Operation,
  type OperationResults,
  type PutOperation,
  type SearchOperation
} from '@langchain/langgraph';
import type { DatabaseService } from '../database-service';

type StoreGetOperation = GetOperation;
type StoreSearchOperation = SearchOperation;
type StorePutOperation = PutOperation;
type StoreListNamespacesOperation = ListNamespacesOperation;
type StoreBatchOperation = Operation;

type StoreRow = {
  namespace_json: string;
  item_key: string;
  value_json: string;
  created_at: string;
  updated_at: string;
};

type NamespaceRow = {
  namespace_json: string;
};

const NAMESPACE_SEPARATOR = '\u001f';
/** @deprecated Only used when migrating legacy projections from the pre-3.2 namespace. */
export const DEEP_AGENT_MEMORY_NAMESPACE = ['roc', 'memory', 'filesystem'] as const;

export function buildDeepAgentMemoryNamespace(workspacePath: string | null): readonly string[] {
  if (workspacePath === null) {
    return ['roc', 'memory', 'global'];
  }
  const normalizedPath = resolve(workspacePath).toLowerCase();
  const stableWorkspaceKey = createHash('sha1').update(normalizedPath).digest('hex');
  return ['roc', 'memory', 'workspace', stableWorkspaceKey];
}

export function buildStoreNamespaceKey(namespace: readonly string[]): string {
  return namespace.join(NAMESPACE_SEPARATOR);
}

function decodeNamespace(namespaceJson: string): string[] {
  const parsed = JSON.parse(namespaceJson) as unknown;
  if (!Array.isArray(parsed) || parsed.some((segment) => typeof segment !== 'string')) {
    throw new Error('Stored namespace is invalid.');
  }
  return parsed;
}

function createPrefixLike(namespace: string[]): string {
  return `${buildStoreNamespaceKey(namespace)}${NAMESPACE_SEPARATOR}%`;
}

export function buildDeepAgentMemoryKey(memoryId: string): string {
  return `/${memoryId}.md`;
}

export function createDeepAgentStoreFileValue(input: {
  content: string;
  createdAt: string;
  updatedAt: string;
  mimeType?: string;
}): Record<string, unknown> {
  return {
    content: input.content,
    created_at: input.createdAt,
    modified_at: input.updatedAt,
    mimeType: input.mimeType ?? 'text/markdown'
  };
}

function isGetOperation(operation: StoreBatchOperation): operation is StoreGetOperation {
  return 'namespace' in operation && 'key' in operation && !('value' in operation);
}

function isSearchOperation(operation: StoreBatchOperation): operation is StoreSearchOperation {
  return 'namespacePrefix' in operation;
}

function isPutOperation(operation: StoreBatchOperation): operation is StorePutOperation {
  return 'namespace' in operation && 'key' in operation && 'value' in operation;
}

function isListNamespacesOperation(operation: StoreBatchOperation): operation is StoreListNamespacesOperation {
  return 'matchConditions' in operation || 'maxDepth' in operation || (!('namespace' in operation) && !('namespacePrefix' in operation));
}

function matchesNamespacePrefix(namespace: string[], prefix: string[]): boolean {
  if (prefix.length > namespace.length) {
    return false;
  }
  return prefix.every((segment, index) => namespace[index] === segment);
}

function matchesNamespaceSuffix(namespace: string[], suffix: string[]): boolean {
  if (suffix.length > namespace.length) {
    return false;
  }
  return suffix.every((segment, index) => namespace[namespace.length - suffix.length + index] === segment);
}

function matchesFilter(value: Record<string, unknown>, filter?: Record<string, unknown>): boolean {
  if (filter === undefined) {
    return true;
  }
  return Object.entries(filter).every(([key, expected]) => JSON.stringify(value[key]) === JSON.stringify(expected));
}

function matchesQuery(value: Record<string, unknown>, query?: string): boolean {
  if (query === undefined || query.trim().length === 0) {
    return true;
  }
  return JSON.stringify(value).toLowerCase().includes(query.trim().toLowerCase());
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class SqliteLangGraphStore extends BaseStore {
  constructor(private readonly database: DatabaseService) {
    super();
  }

  async batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    const results: unknown[] = [];
    for (const operation of operations) {
      if (isGetOperation(operation)) {
        results.push(this.getItem(operation.namespace, operation.key));
        continue;
      }
      if (isSearchOperation(operation)) {
        results.push(this.searchItems(operation));
        continue;
      }
      if (isPutOperation(operation)) {
        this.putItem(operation.namespace, operation.key, operation.value);
        results.push(undefined);
        continue;
      }
      if (isListNamespacesOperation(operation)) {
        results.push(this.listNamespacesInternal(operation));
        continue;
      }
      throw new Error('Unsupported LangGraph store operation.');
    }
    return results as OperationResults<Op>;
  }

  private getItem(namespace: string[], key: string): Item | null {
    const row = this.database.db
      .prepare(
        `SELECT namespace_json, item_key, value_json, created_at, updated_at
         FROM langgraph_store_items
         WHERE namespace_key = ? AND item_key = ?`
      )
      .get(buildStoreNamespaceKey(namespace), key) as StoreRow | undefined;

    if (row === undefined) {
      return null;
    }

    return this.rowToItem(row);
  }

  private searchItems(operation: StoreSearchOperation): Item[] {
    const rows = this.database.db
      .prepare(
        `SELECT namespace_json, item_key, value_json, created_at, updated_at
         FROM langgraph_store_items
         WHERE namespace_key = ? OR namespace_key LIKE ?
         ORDER BY namespace_key ASC, item_key ASC`
      )
      .all(
        buildStoreNamespaceKey(operation.namespacePrefix),
        createPrefixLike(operation.namespacePrefix)
      ) as StoreRow[];

    const filtered = rows
      .map((row) => this.rowToItem(row))
      .filter((item) => matchesFilter(item.value, operation.filter) && matchesQuery(item.value, operation.query));

    const offset = operation.offset ?? 0;
    const limit = operation.limit ?? 10;
    return filtered.slice(offset, offset + limit);
  }

  private putItem(namespace: string[], key: string, value: Record<string, unknown> | null): void {
    const namespaceKey = buildStoreNamespaceKey(namespace);
    if (value === null) {
      this.database.db
        .prepare('DELETE FROM langgraph_store_items WHERE namespace_key = ? AND item_key = ?')
        .run(namespaceKey, key);
      return;
    }

    const now = new Date().toISOString();
    const existing = this.database.db
      .prepare('SELECT created_at FROM langgraph_store_items WHERE namespace_key = ? AND item_key = ?')
      .get(namespaceKey, key) as { created_at: string } | undefined;
    const createdAt = existing?.created_at ?? now;

    this.database.db
      .prepare(
        `INSERT INTO langgraph_store_items (namespace_key, namespace_json, item_key, value_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(namespace_key, item_key) DO UPDATE SET
           namespace_json = excluded.namespace_json,
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`
      )
      .run(namespaceKey, JSON.stringify(namespace), key, JSON.stringify(value), createdAt, now);
  }

  private listNamespacesInternal(operation: StoreListNamespacesOperation): string[][] {
    const rows = this.database.db
      .prepare(
        `SELECT DISTINCT namespace_json
         FROM langgraph_store_items
         ORDER BY namespace_key ASC`
      )
      .all() as NamespaceRow[];

    const namespaces = rows
      .map((row) => decodeNamespace(row.namespace_json))
      .filter((namespace) => {
        if (operation.matchConditions === undefined || operation.matchConditions.length === 0) {
          return true;
        }
        return operation.matchConditions.every((condition: MatchCondition) => {
          if (condition.matchType === 'prefix') {
            return matchesNamespacePrefix(namespace, condition.path);
          }
          return matchesNamespaceSuffix(namespace, condition.path);
        });
      })
      .map((namespace) =>
        operation.maxDepth === undefined ? namespace : namespace.slice(0, operation.maxDepth)
      );

    const unique = Array.from(new Set(namespaces.map((namespace) => JSON.stringify(namespace))))
      .map((encoded) => JSON.parse(encoded) as string[])
      .sort((left, right) => left.join(':').localeCompare(right.join(':')));

    const offset = operation.offset ?? 0;
    const limit = operation.limit ?? 100;
    return unique.slice(offset, offset + limit);
  }

  private rowToItem(row: StoreRow): Item {
    const value = JSON.parse(row.value_json) as unknown;
    if (!isRecordValue(value)) {
      throw new Error('Stored LangGraph item value must be a JSON object.');
    }
    return {
      value: value as Item['value'],
      key: row.item_key,
      namespace: decodeNamespace(row.namespace_json),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }
}
