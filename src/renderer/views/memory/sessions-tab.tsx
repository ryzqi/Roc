import { useState } from 'react';
import type { RocError, SessionMessageSearchRequest, SessionMessageSearchResult } from '../../../shared/types';
import type { RocClient } from '../../shared/roc-client';
import { createRocClient } from '../../shared/roc-client';

type WorkspaceScope = 'current' | 'all';

export function SessionsTab({ client, workspaceHash }: { client?: RocClient; workspaceHash: string | null }): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [workspaceScope, setWorkspaceScope] = useState<WorkspaceScope>('current');
  const [sinceDays, setSinceDays] = useState(30);
  const [result, setResult] = useState<SessionMessageSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function search(): Promise<void> {
    const normalizedQuery = query.trim();
    if (normalizedQuery.length === 0) {
      return;
    }
    setLoading(true);
    setError(null);
    const memoryClient = client ?? createRocClient();
    const request: SessionMessageSearchRequest = {
      query: normalizedQuery,
      workspaceScope,
      sinceDays,
      limit: 50
    };
    if (workspaceScope === 'current') {
      request.workspaceHash = workspaceHash;
    }
    const response = await memoryClient.api.sessions.search(request);
    setLoading(false);
    if (response.ok) {
      setResult(response.data);
      return;
    }
    setResult(null);
    setError(formatIpcError(response.error));
  }

  return (
    <div className="memory-sessions-shell">
      <div className="memory-session-searchbar">
        <label className="memory-session-field">
          <span>关键词</span>
          <input
            className="memory-session-input"
            data-testid="memory-session-query"
            onChange={(event) => setQuery(event.currentTarget.value)}
            value={query}
          />
        </label>
        <label className="memory-session-field compact">
          <span>范围</span>
          <select
            className="memory-session-input"
            data-testid="memory-session-scope"
            onChange={(event) => setWorkspaceScope(readWorkspaceScope(event.currentTarget.value))}
            value={workspaceScope}
          >
            <option value="current">current</option>
            <option value="all">all</option>
          </select>
        </label>
        <label className="memory-session-field compact">
          <span>天数</span>
          <input
            className="memory-session-input"
            data-testid="memory-session-since-days"
            min={1}
            onChange={(event) => setSinceDays(readPositiveInteger(event.currentTarget.value))}
            type="number"
            value={sinceDays}
          />
        </label>
        <button
          className="memory-chip-button primary"
          data-testid="memory-session-search"
          disabled={loading || query.trim().length === 0}
          onClick={() => void search()}
          type="button"
        >
          {loading ? '搜索中' : '搜索'}
        </button>
      </div>

      {error === null ? null : (
        <div className="memory-error-banner" data-testid="memory-session-error">
          {error}
        </div>
      )}

      {result === null ? (
        <div className="section-empty-state" data-testid="memory-session-empty">
          <strong>输入关键词后搜索</strong>
        </div>
      ) : (
        <div className="memory-session-results" data-testid="memory-session-results">
          <div className="memory-session-summary">
            Found {result.total} for "{result.query}"
          </div>
          {result.items.map((item) => (
            <article className="memory-session-result" key={item.id}>
              <div className="memory-session-result-meta">
                <span>{item.createdAt}</span>
                <span>{item.threadTitle === null ? item.threadId : item.threadTitle}</span>
              </div>
              <div className="memory-session-result-body">
                <strong>{item.role}</strong>
                <span>{item.snippet}</span>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function readWorkspaceScope(value: string): WorkspaceScope {
  if (value === 'all') {
    return 'all';
  }
  return 'current';
}

function readPositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return 30;
  }
  return parsed;
}

function formatIpcError(error: RocError): string {
  if (error.userAction !== undefined && error.userAction.length > 0) {
    return `${error.message}\n${error.userAction}`;
  }
  return error.message;
}
