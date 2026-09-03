import { useEffect, useState } from 'react';
import type { RocClient } from '../../shared/roc-client';
import { createRocClient } from '../../shared/roc-client';

export function SnapshotTab({ client }: { client?: RocClient }): React.JSX.Element {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh(): Promise<void> {
    const memoryClient = client ?? createRocClient();
    const result = await memoryClient.api.memory.snapshotPreview();
    if (result.ok) {
      setText(result.data.text);
      setError(null);
      return;
    }
    setText('');
    setError(result.error.message);
  }

  async function copyToClipboard(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard write failed, ignore
    }
  }

  function formatText(raw: string): string {
    try {
      const parsed = JSON.parse(raw);
      return JSON.stringify(parsed, null, 2);
    } catch {
      // Not JSON, return as-is
      return raw;
    }
  }

  const displayText = text.length > 0 ? formatText(text) : '';

  return (
    <div className="memory-snapshot-shell">
      <div className="memory-file-actions">
        <button className="memory-chip-button primary" data-testid="memory-snapshot-refresh" onClick={() => void refresh()} type="button">
          刷新
        </button>
        <button
          className="memory-chip-button"
          data-testid="memory-snapshot-copy"
          disabled={text.length === 0}
          onClick={() => void copyToClipboard()}
          type="button"
        >
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      {error === null ? null : (
        <div className="memory-error-banner" data-testid="memory-snapshot-error">
          {error}
        </div>
      )}
      {text.length === 0 && error === null ? (
        <div className="section-empty-state" data-testid="memory-snapshot-empty">
          <strong>当前快照为空</strong>
        </div>
      ) : null}
      {text.length > 0 ? (
        <pre className="memory-snapshot-preview" data-testid="memory-snapshot-preview">
          {displayText}
        </pre>
      ) : null}
    </div>
  );
}
