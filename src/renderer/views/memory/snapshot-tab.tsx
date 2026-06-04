import { useEffect, useState } from 'react';
import type { RocClient } from '../../shared/roc-client';
import { createRocClient } from '../../shared/roc-client';

export function SnapshotTab({ client }: { client?: RocClient }): React.JSX.Element {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="memory-snapshot-shell">
      <div className="memory-file-actions">
        <button className="memory-chip-button primary" data-testid="memory-snapshot-refresh" onClick={() => void refresh()} type="button">
          刷新
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
          {text}
        </pre>
      ) : null}
    </div>
  );
}
