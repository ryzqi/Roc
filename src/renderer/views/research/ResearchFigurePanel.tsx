import { Play, Send, Square } from 'lucide-react';

import { Select, TextInput } from '../../components/ui';
import type { ResearchExperimentExecution, ResearchExperimentFileContent } from '../../../shared/types';
import { usePagedItems } from './research-list-page';

export type ResearchFigureDraft = {
  label: string;
  runtimeKind: 'bundled-python' | 'uv';
  sourcePath: string;
  inputPaths: string;
  timeoutMs: string;
  widthInches: string;
  heightInches: string;
  dpi: string;
  seed: string;
};

export const emptyFigureDraft: ResearchFigureDraft = {
  label: '',
  runtimeKind: 'bundled-python',
  sourcePath: '',
  inputPaths: '',
  timeoutMs: '60000',
  widthInches: '6',
  heightInches: '4',
  dpi: '150',
  seed: '1'
};

const statusLabels: Record<ResearchExperimentExecution['status'], string> = {
  preparing: '准备中',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断'
};

const runtimeLabels: Record<ResearchFigureDraft['runtimeKind'], string> = {
  'bundled-python': '内置 Python',
  uv: 'uv'
};

export function ResearchFigurePanel({
  draft,
  log,
  onCancel,
  onChange,
  onPublish,
  onReadLog,
  onRefresh,
  onSelect,
  onStart,
  projectId,
  runs,
  selectedRunId,
  working,
  readOnly = false
}: {
  draft: ResearchFigureDraft;
  log: ResearchExperimentFileContent | null;
  onCancel: (runId: string) => void;
  onChange: (draft: ResearchFigureDraft) => void;
  onPublish: (runId: string) => void;
  onReadLog: (runId: string) => void;
  onRefresh: () => void;
  onSelect: (runId: string) => void;
  onStart: () => void;
  projectId: string | null;
  runs: ResearchExperimentExecution[];
  selectedRunId: string | null;
  working: boolean;
  readOnly?: boolean;
}): React.JSX.Element {
  const selected = runs.find((item) => item.id === selectedRunId) ?? null;
  const writeBlocked = working || readOnly;
  const page = usePagedItems(runs, runs.length.toString());
  return (
    <section className="research-tool-panel" data-testid="research-figure-panel">
      <div className="research-tool-heading">
        <div>
          <h2>图稿渲染</h2>
          <p>选择 Python 源与数据后渲染图稿，完成后再发布为阶段产物。</p>
        </div>
        <button className="action-button" disabled={working || projectId === null} type="button" data-testid="research-figure-refresh" onClick={onRefresh}>刷新</button>
      </div>
      <div className="research-library-layout">
        <form className="research-idea-form" onSubmit={(event) => { event.preventDefault(); onStart(); }}>
          <label>
            标签
            <TextInput data-testid="research-figure-label" value={draft.label} onChange={(event) => onChange({ ...draft, label: event.target.value })} />
          </label>
          <label>
            运行时
            <Select data-testid="research-figure-runtime" value={draft.runtimeKind} onChange={(event) => onChange({ ...draft, runtimeKind: event.target.value as ResearchFigureDraft['runtimeKind'] })}>
              <option value="bundled-python">内置 Python</option>
              <option value="uv">uv</option>
            </Select>
          </label>
          <label>
            源文件
            <TextInput data-testid="research-figure-source" value={draft.sourcePath} onChange={(event) => onChange({ ...draft, sourcePath: event.target.value })} placeholder="plot.py" />
          </label>
          <label>
            输入文件
            <TextInput data-testid="research-figure-inputs" value={draft.inputPaths} onChange={(event) => onChange({ ...draft, inputPaths: event.target.value })} placeholder="data.csv" />
          </label>
          <label>
            超时（毫秒）
            <TextInput data-testid="research-figure-timeout" inputMode="numeric" value={draft.timeoutMs} onChange={(event) => onChange({ ...draft, timeoutMs: event.target.value })} />
          </label>
          <div className="research-form-actions">
            <button className="action-button action-button--primary" disabled={writeBlocked || projectId === null || draft.sourcePath.trim().length === 0} type="submit" data-testid="research-figure-start">
              <Play aria-hidden="true" size={15} />
              渲染
            </button>
          </div>
        </form>
        <div className="research-literature-list" data-testid="research-figure-list">
          {runs.length === 0 ? <div className="research-loading">还没有图稿运行。填写源文件后渲染。</div> : page.visible.map((run) => (
            <article className={run.id === selectedRunId ? 'research-literature-row research-library-row--active' : 'research-literature-row'} key={run.id}>
              <button className="research-literature-row" type="button" data-testid={`research-figure-select-${run.id}`} onClick={() => onSelect(run.id)}>
                <div className="research-literature-source">{statusLabels[run.status]}</div>
                <h3>{run.request.label}</h3>
                <p>{run.request.sourcePath}{run.error === null ? '' : ` · ${run.error}`}</p>
              </button>
              <div className="research-stage-actions">
                {['preparing', 'running'].includes(run.status) ? (
                  <button className="action-button" disabled={writeBlocked} type="button" data-testid={`research-figure-cancel-${run.id}`} onClick={() => onCancel(run.id)}>
                    <Square aria-hidden="true" size={14} />
                    取消
                  </button>
                ) : null}
                {run.status === 'completed' ? (
                  <button className="action-button action-button--primary" disabled={writeBlocked} type="button" data-testid={`research-figure-publish-${run.id}`} onClick={() => onPublish(run.id)}>
                    <Send aria-hidden="true" size={14} />
                    发布图稿
                  </button>
                ) : null}
                {run.files.some((file) => file.area === 'log') ? (
                  <button className="action-button" disabled={working} type="button" data-testid={`research-figure-log-${run.id}`} onClick={() => onReadLog(run.id)}>查看日志</button>
                ) : null}
              </div>
            </article>
          ))}
          {page.remaining === 0 ? null : (
            <button className="action-button" data-testid="research-figure-more" type="button" onClick={page.showMore}>
              继续加载图稿（剩余 {page.remaining}）
            </button>
          )}
        </div>
      </div>
      {selected === null ? null : (
        <aside className="research-reader" data-testid="research-figure-detail">
          <div className="research-section-label">运行记录</div>
          <h3>{selected.request.label}</h3>
          <p>{runtimeLabels[selected.request.runtime.kind === 'uv' ? 'uv' : 'bundled-python']} · {selected.environment?.hash.slice(0, 12) ?? '尚未校验环境'}</p>
          {log === null ? <div className="research-loading">选择一条运行并打开日志。</div> : (
            <pre className="research-reader-content" data-testid="research-figure-log">{log.content}</pre>
          )}
        </aside>
      )}
    </section>
  );
}
