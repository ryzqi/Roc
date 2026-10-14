import { Suspense, lazy, useEffect, useState, type ComponentType } from 'react';
import type { AppViewId } from './routes';

/**
 * Lazy view host, ported from the legacy shell's `loadView` / `viewCache`
 * pattern.
 *
 * A view module is fetched at most once per session (module-level cache), so
 * switching canvas views never refetches a chunk that is already resident.
 *
 * P0 registers placeholder views only; P1–P9 swap each entry for a real
 * `() => import('...')` of the owning module. Until then these in-memory
 * factories ship inside the eager entry — which is fine for placeholders, but
 * **the assistant, settings, and the Markdown/KaTeX families must be real
 * dynamic imports** or `check-renderer-chunks.mjs`'s
 * `forbidden = /markdown|streamdown|highlight|settings/iu` guard fires
 * (R4 / ADR-M11).
 */

export type ViewProps = {
  view: AppViewId;
  projectId: string | null;
  stageHint: string | null;
};

type ViewModule = { default: ComponentType<ViewProps> };

function placeholderView(title: string, phase: string): ComponentType<ViewProps> {
  return function Placeholder() {
    return (
      <div className="flex h-full w-full items-center justify-center p-6" data-testid="view-placeholder">
        <div className="rounded-card border border-line bg-surface px-5 py-4 text-center">
          <p className="text-ink">{title}</p>
          <p className="mt-1 text-muted">尚未实现 · {phase}</p>
        </div>
      </div>
    );
  };
}

const viewLoaders: Record<AppViewId, () => Promise<ViewModule>> = {
  overview: async () => ({ default: placeholderView('项目总览', 'P6 实现') }),
  stage: async () => ({ default: placeholderView('阶段工作区', 'P6 实现') }),
  activity: async () => ({ default: placeholderView('活动流', 'P6 实现') }),
  provenance: async () => ({ default: placeholderView('溯源', 'P7 实现') }),
  changes: async () => ({ default: placeholderView('改动与产物', 'P1 实现') }),
  literature: async () => ({ default: placeholderView('文献中心', 'P5 实现') }),
  latex: async () => ({ default: placeholderView('文稿', 'P7 实现') }),
  terminal: async () => ({ default: placeholderView('终端', 'P3 实现') }),
  files: async () => ({ default: placeholderView('文件', 'P3 实现') }),
  tasks: async () => ({ default: placeholderView('任务看板', 'P6 实现') }),
  diagnostics: async () => ({ default: placeholderView('运行诊断', 'P6 实现') }),
  mcp: async () => ({ default: placeholderView('MCP', 'P9 实现') }),
  skills: async () => ({ default: placeholderView('技能', 'P9 实现') }),
  memory: async () => ({ default: placeholderView('记忆', 'P9 实现') })
};

const viewCache = new Map<AppViewId, ComponentType<ViewProps>>();

function loadView(view: AppViewId): ComponentType<ViewProps> {
  const cached = viewCache.get(view);
  if (cached !== undefined) {
    return cached;
  }
  const component = lazy(viewLoaders[view]);
  viewCache.set(view, component);
  return component;
}

/**
 * Waits 200ms before showing anything (MASTER v2 §10): a chunk that resolves
 * faster than that must not flash a placeholder. After the threshold the text
 * stays mounted until the suspended subtree commits.
 */
function DelayedViewFallback(): React.JSX.Element | null {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const handle = window.setTimeout(() => setVisible(true), 200);
    return () => window.clearTimeout(handle);
  }, []);
  if (!visible) {
    return null;
  }
  return (
    <div className="flex h-full w-full items-center justify-center p-6 text-muted" data-testid="view-loading" role="status">
      正在加载视图…
    </div>
  );
}

export function ViewContent({ view, projectId, stageHint }: ViewProps): React.JSX.Element {
  const Current = loadView(view);
  return (
    <Suspense fallback={<DelayedViewFallback />}>
      <div className="h-full w-full" data-view={view} data-project={projectId ?? ''} data-stage={stageHint ?? ''}>
        <Current view={view} projectId={projectId} stageHint={stageHint} />
      </div>
    </Suspense>
  );
}
