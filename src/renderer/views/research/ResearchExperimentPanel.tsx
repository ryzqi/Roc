import { Play, Send, Square } from 'lucide-react';

import { Select, TextInput } from '../../components/ui';
import type { ResearchExperimentExecution, ResearchExperimentFileContent } from '../../../shared/types';
import { usePagedItems } from './research-list-page';

export type ResearchExperimentEngine = 'python' | 'r' | 'julia';
export type ResearchExperimentDraft = {
  label: string;
  engine: ResearchExperimentEngine;
  runtimeKind: 'bundled-python' | 'uv' | 'renv' | 'julia';
  rRootPath: string;
  rLibraryPath: string;
  juliaRootPath: string;
  juliaDepotPath: string;
  sourcePath: string;
  inputPaths: string;
  network: 'disabled' | 'enabled';
  timeoutMs: string;
};

export const emptyExperimentDraft: ResearchExperimentDraft = {
  label: '',
  engine: 'python',
  runtimeKind: 'bundled-python',
  rRootPath: '',
  rLibraryPath: 'renv/library',
  juliaRootPath: '',
  juliaDepotPath: '',
  sourcePath: '',
  inputPaths: '',
  network: 'disabled',
  timeoutMs: '60000'
};

const engineLabels: Record<ResearchExperimentExecution['request']['engine'], string> = {
  python: 'Python',
  r: 'R / renv',
  julia: 'Julia',
  matplotlib: '图稿'
};
const runtimeLabels: Record<ResearchExperimentExecution['request']['runtime']['kind'], string> = {
  'bundled-python': '随包 Python',
  uv: '项目 uv',
  renv: 'R 环境',
  julia: 'Julia'
};
const draftEngineLabels: Record<ResearchExperimentEngine, string> = {
  python: 'Python',
  r: 'R / renv',
  julia: 'Julia'
};

const statusLabels: Record<ResearchExperimentExecution['status'], string> = {
  preparing: '准备中',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断'
};

export function ResearchExperimentPanel({
  draft,
  experiments,
  log,
  onCancel,
  onChange,
  onPublish,
  onReadLog,
  onRefresh,
  onSelect,
  onStart,
  projectId,
  selectedRunId,
  working,
  readOnly = false
}: {
  draft: ResearchExperimentDraft;
  experiments: ResearchExperimentExecution[];
  log: ResearchExperimentFileContent | null;
  onCancel: (runId: string) => void;
  onChange: (draft: ResearchExperimentDraft) => void;
  onPublish: (runId: string) => void;
  onReadLog: (runId: string) => void;
  onRefresh: () => void;
  onSelect: (runId: string) => void;
  onStart: () => void;
  projectId: string | null;
  selectedRunId: string | null;
  working: boolean;
  readOnly?: boolean;
}): React.JSX.Element {
  const selected = experiments.find((item) => item.id === selectedRunId) ?? null;
  const runtimeLocked = draft.engine === 'r' || draft.engine === 'julia';
  const writeBlocked = working || readOnly;
  const experimentPage = usePagedItems(experiments, experiments.length.toString());
  return (
    <section className="research-tool-panel" data-testid="research-experiment-panel">
      <div className="research-tool-heading">
        <div>
          <h2>实验运行</h2>
        </div>
        <button className="action-button" disabled={working || projectId === null} type="button" data-testid="research-experiment-refresh" onClick={onRefresh}>刷新</button>
      </div>

      <div className="research-library-layout">
        <form className="research-idea-form" onSubmit={(event) => { event.preventDefault(); onStart(); }}>
          <label>
            引擎
            <Select data-testid="research-experiment-engine" value={draft.engine} onChange={(event) => onChange(changeEngine(draft, event.target.value as ResearchExperimentEngine))}>
              {Object.entries(draftEngineLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </Select>
          </label>
          {runtimeLocked ? null : (
            <label>
              Python 运行时
              <Select data-testid="research-experiment-runtime" value={draft.runtimeKind} onChange={(event) => onChange({ ...draft, runtimeKind: event.target.value === 'uv' ? 'uv' : 'bundled-python' })}>
                <option value="bundled-python">随包 Python</option>
                <option value="uv">项目 uv / .venv</option>
              </Select>
            </label>
          )}
          {draft.engine === 'r' ? (
            <>
              <label>
                R.home 绝对路径
                <TextInput data-testid="research-experiment-r-root" value={draft.rRootPath} onChange={(event) => onChange({ ...draft, rRootPath: event.target.value })} />
              </label>
              <label>
                项目库相对路径
                <TextInput data-testid="research-experiment-r-library" value={draft.rLibraryPath} onChange={(event) => onChange({ ...draft, rLibraryPath: event.target.value })} />
              </label>
            </>
          ) : null}
          {draft.engine === 'julia' ? (
            <>
              <label>
                Julia 根目录
                <TextInput data-testid="research-experiment-julia-root" value={draft.juliaRootPath} onChange={(event) => onChange({ ...draft, juliaRootPath: event.target.value })} />
              </label>
              <label>
                Depot 绝对路径
                <TextInput data-testid="research-experiment-julia-depot" value={draft.juliaDepotPath} onChange={(event) => onChange({ ...draft, juliaDepotPath: event.target.value })} />
              </label>
            </>
          ) : null}
          <label>
            运行标签
            <TextInput data-testid="research-experiment-label" value={draft.label} onChange={(event) => onChange({ ...draft, label: event.target.value })} />
          </label>
          <label>
            源文件
            <TextInput data-testid="research-experiment-source" value={draft.sourcePath} onChange={(event) => onChange({ ...draft, sourcePath: event.target.value })} placeholder={sourcePlaceholder(draft.engine)} />
          </label>
          <label>
            输入文件
            <TextInput data-testid="research-experiment-inputs" value={draft.inputPaths} onChange={(event) => onChange({ ...draft, inputPaths: event.target.value })} placeholder="data.csv, helper.py" />
          </label>
          <label>
            网络
            <Select data-testid="research-experiment-network" value={draft.network} onChange={(event) => onChange({ ...draft, network: event.target.value === 'enabled' ? 'enabled' : 'disabled' })}>
              <option value="disabled">禁用</option>
              <option value="enabled">允许</option>
            </Select>
          </label>
          <label>
            超时（毫秒）
            <TextInput data-testid="research-experiment-timeout" inputMode="numeric" value={draft.timeoutMs} onChange={(event) => onChange({ ...draft, timeoutMs: event.target.value })} />
          </label>
          <div className="research-form-actions">
            <button className="action-button action-button--primary" disabled={writeBlocked || projectId === null || draft.sourcePath.trim().length === 0} type="submit" data-testid="research-experiment-start">
              <Play aria-hidden="true" size={15} />
              启动
            </button>
          </div>
        </form>

        <div className="research-literature-list" data-testid="research-experiment-list">
          {experiments.length === 0 ? <div className="research-empty-inline" role="status">还没有实验运行。填写源文件后启动。</div> : experimentPage.visible.map((run) => (
            <article className={run.id === selectedRunId ? 'research-literature-row research-library-row--active' : 'research-literature-row'} key={run.id}>
              <button className="research-literature-row" type="button" data-testid={`research-experiment-select-${run.id}`} onClick={() => onSelect(run.id)}>
                <div className="research-literature-source">{statusLabels[run.status]} · {engineLabels[run.request.engine]}</div>
                <h3>{run.request.label}</h3>
                <p>{run.request.sourcePath}{run.error === null ? '' : ` · ${run.error}`}</p>
              </button>
              <div className="research-stage-actions">
                {['preparing', 'running'].includes(run.status) ? (
                  <button className="action-button" disabled={writeBlocked} type="button" data-testid={`research-experiment-cancel-${run.id}`} onClick={() => onCancel(run.id)}>
                    <Square aria-hidden="true" size={14} />
                    取消
                  </button>
                ) : null}
                {run.status === 'completed' ? (
                  <button className="action-button action-button--primary" disabled={writeBlocked} type="button" data-testid={`research-experiment-publish-${run.id}`} onClick={() => onPublish(run.id)}>
                    <Send aria-hidden="true" size={14} />
                    发布实验
                  </button>
                ) : null}
                {run.files.some((file) => file.area === 'log') ? (
                  <button className="action-button" disabled={working} type="button" data-testid={`research-experiment-log-${run.id}`} onClick={() => onReadLog(run.id)}>查看日志</button>
                ) : null}
              </div>
            </article>
          ))}
          {experimentPage.remaining === 0 ? null : (
            <button className="action-button" data-testid="research-experiment-more" type="button" onClick={experimentPage.showMore}>
              继续加载实验（剩余 {experimentPage.remaining}）
            </button>
          )}
        </div>
      </div>

      {selected === null ? null : (
        <aside className="research-reader" data-testid="research-experiment-detail">
          <div className="research-section-label">运行记录</div>
          <h3>{selected.request.label}</h3>
          <p>{engineLabels[selected.request.engine]} · {runtimeLabels[selected.request.runtime.kind]} · {selected.environment?.hash.slice(0, 12) ?? '尚未校验环境'}</p>
          {log === null ? <div className="research-empty-inline" role="status">选择一条运行并打开日志。</div> : (
            <pre className="research-reader-content" data-testid="research-experiment-log">{log.content}</pre>
          )}
        </aside>
      )}
    </section>
  );
}

function changeEngine(draft: ResearchExperimentDraft, engine: ResearchExperimentEngine): ResearchExperimentDraft {
  return {
    ...draft,
    engine,
    runtimeKind: engine === 'r' ? 'renv' : engine === 'julia' ? 'julia' : draft.runtimeKind === 'renv' || draft.runtimeKind === 'julia' ? 'bundled-python' : draft.runtimeKind,
    network: draft.network
  };
}

function sourcePlaceholder(engine: ResearchExperimentEngine): string {
  if (engine === 'r') return 'analysis.r';
  if (engine === 'julia') return 'analysis.jl';
  return 'run.py';
}
