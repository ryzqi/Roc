import { useState } from 'react';
import { ChevronDown, CircleHelp, FileText, FolderOpen, FolderTree, ListChecks, Loader2, RotateCcw, type LucideIcon } from 'lucide-react';
import type { AppViewId } from '../app/routes';
import { useAsyncResource } from '../app/use-async-resource';
import { readRecentProjectIds } from '../app/ui-state';
import { SessionListView, type SessionListViewProps } from '../assistant/SessionListView';
import { FileSidebarPanel } from '../canvas/files/FileSidebarPanel';
import { LibraryList } from '../literature/LibraryList';
import { useLiterature } from '../literature/literature-scope';
import type { RocClient } from '../shared/roc-client';
import type { BoundWorkspace } from '../workspace/use-bound-workspace';
import { listTree } from '../workspace/workspace-store';
import { EmptyState } from './EmptyState';
import type { ProjectOption } from './WindowChrome';
import './chrome.css';

type ContextDrawerProps = SessionListViewProps & Parameters<typeof WritingFiles>[0] & {
  view: AppViewId;
  projects: readonly ProjectOption[];
  onOpenProject: (projectId: string) => void;
  onOpenLiterature: (libraryItemId: string | null) => void;
  onOpenTasks: () => void;
  onOpenHelp: () => void;
  onOpenWriting: () => void;
  taskLabel?: string;
  taskSummary?: string;
};

const headings = { overview: '项目概览', library: '文献资料', writing: '项目文件', runs: '会话与任务' } satisfies Record<AppViewId, string>;

const entryTypeLabels: Readonly<Record<string, string>> = {
  article: '期刊论文', 'article-journal': '期刊论文', inproceedings: '会议论文', 'paper-conference': '会议论文',
  book: '图书', inbook: '图书章节', incollection: '图书章节', chapter: '图书章节', thesis: '学位论文',
  phdthesis: '学位论文', mastersthesis: '学位论文', report: '报告', techreport: '报告', misc: '其他'
};

function WritingFiles({
  client,
  projectId,
  binding,
  writable,
  openFile,
  onOpenFile,
  onSelectWorkspace,
  workspacePending,
  workspaceError,
  previewRequest,
  onPreviewRequestConsumed
}: {
  client: RocClient;
  projectId: string | null;
  binding: BoundWorkspace;
  writable: boolean;
  openFile: string | null;
  onOpenFile: (relativePath: string) => void;
  onSelectWorkspace: () => void;
  workspacePending: boolean;
  workspaceError: string | null;
  previewRequest: { relativePath: string; nonce: number } | null;
  onPreviewRequestConsumed?: () => void;
}): React.JSX.Element {
  if (binding.desiredPath === null) {
    return (
      <>
        <EmptyState
          compact
          icon={FolderTree}
          title="未选择工作区"
          action={{ label: '选择目录', onClick: onSelectWorkspace, disabled: workspacePending }}
          testId="sidebar-files-no-workspace"
        />
        {workspaceError === null ? null : (
          <p
            role="alert"
            className="px-3 pb-2 text-[var(--st-bad)] text-[length:var(--font-micro-size)]"
            data-testid="sidebar-files-workspace-error"
          >
            {workspaceError}
          </p>
        )}
      </>
    );
  }

  if (binding.status === 'binding') {
    return (
      <p className="flex items-center gap-2 px-3 py-4 text-muted" role="status" data-testid="sidebar-files-binding">
        <Loader2 size={13} aria-hidden="true" className="animate-spin" />
        正在绑定工作目录…
      </p>
    );
  }

  if (binding.status === 'error' || binding.path === null) {
    return (
      <>
        <EmptyState
          compact
          icon={FolderTree}
          title="工作目录无法绑定"
          action={{ label: '重试', onClick: binding.rebind }}
          testId="sidebar-files-bind-error"
        />
        <div className="px-3 pb-3">
          <button
            type="button"
            onClick={onSelectWorkspace}
            disabled={workspacePending}
            data-testid="sidebar-files-reselect"
            className="h-[var(--control-height-compact)] rounded-control border-[0.5px] border-line px-2 text-ink hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] disabled:opacity-40"
          >
            <span className="flex items-center gap-1 text-[length:var(--font-meta-size)]">
              <RotateCcw size={11} aria-hidden="true" />
              选择其它目录
            </span>
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <FileSidebarPanel
        key={binding.path}
        client={client}
        workspacePathKey={binding.path}
        projectId={projectId}
        writable={writable}
        openFile={openFile}
        onOpenFile={onOpenFile}
        previewRequest={previewRequest}
        onPreviewRequestConsumed={onPreviewRequestConsumed}
      />
      {workspaceError === null ? null : (
        <p
          role="alert"
          className="px-3 pb-2 text-[var(--st-bad)] text-[length:var(--font-micro-size)]"
          data-testid="sidebar-files-workspace-error"
        >
          {workspaceError}
        </p>
      )}
    </>
  );
}

function ContextAction({ icon: Icon, label, onClick, testId, detail }: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  testId?: string;
  detail?: string;
}): React.JSX.Element {
  return <button type="button" className="chrome-control w-full min-w-0 justify-start text-start"
    onClick={onClick} title={detail ?? label} data-testid={testId}>
    <Icon size={14} aria-hidden="true" className="shrink-0" />
    <span className="min-w-0 truncate">{label}</span>
  </button>;
}

function OverviewResources({ client, projectId, binding, projects, onOpenProject, onOpenFile, onOpenWriting }:
  Pick<ContextDrawerProps, 'client' | 'projectId' | 'binding' | 'projects' | 'onOpenProject' | 'onOpenFile' | 'onOpenWriting'>): React.JSX.Element {
  const manuscripts = useAsyncResource(binding.path, async () => {
    const root = await listTree(client, '');
    if (!root.ok) return root;
    const directories = root.data.entries.filter(entry => entry.type === 'directory' && /^(chapters|sections|manuscript|paper|writing)$/iu.test(entry.name));
    const nested = await Promise.all(directories.map(directory => listTree(client, directory.relativePath)));
    const entries = [...root.data.entries, ...nested.flatMap(result => result.ok ? result.data.entries : [])];
    return { ok: true, data: entries.filter(entry => entry.type === 'file' && /\.(tex|md)$/iu.test(entry.name))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 5) };
  }, { label: '读取工作区文稿' });
  const projectsById = new Map(projects.map(project => [project.id, project]));
  const recentProjects = readRecentProjectIds().flatMap(id => {
    const project = projectsById.get(id);
    return project === undefined || id === projectId ? [] : [project];
  }).slice(0, 5);

  return <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-2 [scrollbar-gutter:stable]">
    <section aria-label="最近文稿">
      <h3 className="px-2 py-1 text-muted">最近文稿</h3>
      {manuscripts.status === 'loading' ? <p className="px-2 text-muted" role="status">正在读取文稿…</p> :
        manuscripts.error !== null ? <>
          <p className="px-2 text-st-bad" role="alert">{manuscripts.error}</p>
          <ContextAction icon={RotateCcw} label="重试" onClick={manuscripts.reload} />
        </> : (manuscripts.data?.length ?? 0) === 0 ? <ContextAction icon={FileText} label="打开项目文件" onClick={onOpenWriting} /> :
          manuscripts.data?.map(({ relativePath, name }) => <ContextAction key={relativePath} icon={FileText} label={name}
            detail={relativePath} onClick={() => onOpenFile(relativePath)} />)}
    </section>
    {recentProjects.length === 0 ? null : <section aria-label="最近项目">
      <h3 className="px-2 py-1 text-muted">最近项目</h3>
      {recentProjects.map(project => <ContextAction key={project.id} icon={FolderOpen} label={project.title}
        onClick={() => onOpenProject(project.id)} />)}
    </section>}
  </div>;
}

function LiteratureResources({ onOpenLiterature }: Pick<ContextDrawerProps, 'onOpenLiterature'>): React.JSX.Element {
  const literature = useLiterature();
  const [category, setCategory] = useState<string | null>(null);
  const counts = new Map<string, number>();
  let zoteroCount = 0;
  for (const item of literature.items) {
    const type = item.bibliography.entryType;
    counts.set(type, (counts.get(type) ?? 0) + 1);
    if (item.metadata.source === 'zotero' || item.sources.some(({ metadata }) => metadata.source === 'zotero')) zoteroCount += 1;
  }
  const selectedCategory = category !== null && counts.has(category) ? category : null;
  return <>
    <div className="shrink-0 space-y-1 border-b-[0.5px] border-line px-2 py-1">
      <details className="group">
        <summary className="chrome-control flex w-full list-none justify-between">
          {selectedCategory === null ? '文献分类' : entryTypeLabels[selectedCategory] ?? selectedCategory}
          <ChevronDown size={12} aria-hidden="true" className="group-open:rotate-180" />
        </summary>
        <div className="max-h-32 overflow-y-auto ps-2">
          <button type="button" className="chrome-control w-full justify-start" aria-pressed={selectedCategory === null}
            onClick={() => setCategory(null)}>全部</button>
          {[...counts].map(([type, count]) => <button type="button" key={type}
            className="chrome-control w-full justify-between" aria-pressed={selectedCategory === type} onClick={() => setCategory(type)}>
            {entryTypeLabels[type] ?? type}<span className="tabular-nums" dir="ltr">{count.toLocaleString('zh-CN')} 条</span>
          </button>)}
        </div>
      </details>
      <button type="button" className="chrome-control w-full justify-between" data-testid="context-zotero" onClick={() => {
        literature.requestImport('zotero');
        onOpenLiterature(null);
      }}>
        Zotero 同步
        {literature.status === 'ready' ? <span className="tabular-nums" dir="ltr">{zoteroCount.toLocaleString('zh-CN')} 条已收录</span> : null}
      </button>
    </div>
    <div className="min-h-0 flex-1">
      <LibraryList compact entryType={selectedCategory} onOpenItem={onOpenLiterature} onRequestImport={() => {
        literature.requestImport();
        onOpenLiterature(null);
      }} />
    </div>
  </>;
}

export function ContextDrawer(props: ContextDrawerProps): React.JSX.Element {
  const { view, client, activeThreadId, onSelectThread, onStartNewThread, onThreadDeleted,
    onOpenTasks, onOpenHelp, taskLabel, taskSummary } = props;
  return (
    <aside aria-label={headings[view]} data-testid="context-drawer"
      className="flex h-full min-h-0 flex-col overflow-hidden bg-surface-rail text-[length:var(--font-meta-size)] text-ink-secondary">
      <h2 className="shrink-0 border-b-[0.5px] border-line-default px-4 py-2 font-medium text-ink-primary">{headings[view]}</h2>
      {view === 'overview' ? <OverviewResources {...props} /> : view === 'library' ? <LiteratureResources {...props} /> :
        view === 'writing' ? <>
          <div className="min-h-0 flex-1 overflow-y-auto"><WritingFiles {...props} /></div>
        </> : <>
          <div className="shrink-0 border-b-[0.5px] border-line p-2">
            <ContextAction icon={ListChecks} label={taskLabel ?? '研究任务'} detail={taskSummary}
              onClick={onOpenTasks} testId="context-go-to-tasks" />
          </div>
          <div className="min-h-0 flex-1">
            <SessionListView {...{ client, activeThreadId, onSelectThread, onStartNewThread, onThreadDeleted }} />
          </div>
        </>}
      <div className="shrink-0 border-t-[0.5px] border-line p-2">
        <ContextAction icon={CircleHelp} label="开始引导" onClick={onOpenHelp} testId="context-help" />
      </div>
    </aside>
  );
}
