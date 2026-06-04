import { useEffect, useMemo, useState } from 'react';
import type { MemoryFileMeta, MemoryFileWriteOutcome, MemoryStatus, RocError } from '../../../shared/types';
import type { RocClient } from '../../shared/roc-client';
import { createRocClient } from '../../shared/roc-client';

type FileTabError =
  | MemoryFileWriteOutcome
  | {
      ok: false;
      reason: 'invalid_path';
      detail: string;
    };

export function FilesTab({ client, initialStatus }: { client?: RocClient; initialStatus: MemoryStatus }): React.JSX.Element {
  const [status, setStatus] = useState<MemoryStatus>(initialStatus);
  const [selected, setSelected] = useState<MemoryFileMeta | null>(null);
  const [buffer, setBuffer] = useState('');
  const [error, setError] = useState<FileTabError | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void refreshStatus();
  }, []);

  async function refreshStatus(): Promise<void> {
    const memoryClient = client ?? createRocClient();
    const result = await memoryClient.api.memory.status();
    if (result.ok) {
      setStatus(result.data);
      setSelected((current) => syncSelectedMeta(current, result.data.files));
    }
  }

  async function loadFile(file: MemoryFileMeta): Promise<void> {
    setSelected(file);
    setError(null);
    setLoading(true);
    const memoryClient = client ?? createRocClient();
    const result = await memoryClient.api.memory.readFile({ scope: file.scope, kind: file.kind });
    setLoading(false);
    if (!result.ok) {
      setBuffer('');
      setError({ ok: false, reason: 'invalid_path', detail: formatIpcError(result.error) });
      return;
    }
    setBuffer(result.data === null ? '' : result.data);
  }

  async function save(): Promise<void> {
    if (selected === null) {
      return;
    }
    setSaving(true);
    setError(null);
    const memoryClient = client ?? createRocClient();
    const result = await memoryClient.api.memory.writeFile({
      scope: selected.scope,
      kind: selected.kind,
      content: buffer
    });
    setSaving(false);
    if (!result.ok) {
      setError({ ok: false, reason: 'invalid_path', detail: formatIpcError(result.error) });
      return;
    }
    if (result.data.ok) {
      setSelected(result.data.meta);
      await refreshStatus();
      return;
    }
    setError(result.data);
  }

  const files = status.files;
  const charCount = useMemo(() => [...buffer].length, [buffer]);
  const overLimit = selected !== null && charCount > selected.charLimit;

  return (
    <div className="memory-files-layout">
      <aside className="memory-files-list" aria-label="记忆文件">
        {files.map((file) => (
          <button
            aria-pressed={selected !== null && selected.scope === file.scope && selected.kind === file.kind}
            className={selected !== null && selected.scope === file.scope && selected.kind === file.kind ? 'memory-file-row active' : 'memory-file-row'}
            data-testid={`memory-file-row-${file.scope}-${file.kind}`}
            key={`${file.scope}-${file.kind}`}
            onClick={() => void loadFile(file)}
            type="button"
          >
            <span className="memory-file-row-main">
              <strong>{formatKind(file.kind)}</strong>
              <span>{file.scope}</span>
            </span>
            <span className="memory-file-row-sub">
              {file.charCount} / {file.charLimit}
              {file.effective ? ' · effective' : ''}
            </span>
          </button>
        ))}
      </aside>
      <main className="memory-file-editor-shell">
        {selected === null ? (
          <div className="section-empty-state" data-testid="memory-file-empty">
            <strong>选择一个记忆文件</strong>
            <p>全局与当前工作区文件会写入磁盘；安全扫描和容量限制会在保存时执行。</p>
          </div>
        ) : (
          <>
            <div className="memory-file-editor-head">
              <div>
                <h2 className="section-title">{formatKind(selected.kind)} · {selected.scope}</h2>
                <p className="muted">{selected.absolutePath}</p>
              </div>
              <span className={overLimit ? 'memory-count memory-count--bad' : 'memory-count'}>
                {charCount} / {selected.charLimit}
              </span>
            </div>
            <textarea
              className="memory-file-textarea"
              data-testid="memory-file-editor"
              disabled={loading}
              onChange={(event) => setBuffer(event.currentTarget.value)}
              value={buffer}
            />
            <div className="memory-file-actions">
              <button
                className="memory-chip-button primary"
                data-testid="memory-file-save"
                disabled={saving}
                onClick={() => void save()}
                type="button"
              >
                {saving ? '保存中' : '保存'}
              </button>
              {selected.effective ? <span className="muted">改动会在下个 session 生效</span> : null}
            </div>
            {error !== null && !error.ok ? (
              <div className="memory-error-banner" data-testid="memory-write-error">
                {error.detail}
              </div>
            ) : null}
          </>
        )}
      </main>
    </div>
  );
}

function formatKind(kind: MemoryFileMeta['kind']): string {
  if (kind === 'user') {
    return 'USER.md';
  }
  if (kind === 'agents') {
    return 'AGENTS.md';
  }
  return 'MEMORY.md';
}

function syncSelectedMeta(current: MemoryFileMeta | null, files: MemoryFileMeta[]): MemoryFileMeta | null {
  if (current === null) {
    return null;
  }
  const next = files.find((file) => file.scope === current.scope && file.kind === current.kind);
  return next === undefined ? current : next;
}

function formatIpcError(error: RocError): string {
  if (error.userAction !== undefined && error.userAction.length > 0) {
    return `${error.message}\n${error.userAction}`;
  }
  return error.message;
}
