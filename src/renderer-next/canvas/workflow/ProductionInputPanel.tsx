import { FileText } from 'lucide-react';
import { useCallback, useState } from 'react';
import type { ResearchArtifact } from '../../../shared/types';
import type { ResearchProductionInput, ResearchProductionInputContent } from '../../../shared/schemas/research-production-inputs';
import { useAsyncResource } from '../../app/use-async-resource';
import { useWorkspaceScope } from '../../app/workspace-scope';
import { ErrorBar } from '../../shell/ErrorBar';
import { formatBytes } from '../../shared/format';
import { inspectProductionInput, readProductionInputFile } from './workflow-store';

/**
 * 生产输入 (P6/T6.5).
 *
 * Only three artifact kinds have production inputs, because only three backends produce
 * run directories: `experiment_run`, `figure` and `export_package`
 * (`research-production-inputs.ts` → `source` is a discriminated union over exactly those).
 * For every other kind the panel says so instead of rendering an empty table — a panel that
 * looks like "0 files" would read as "nothing was produced", which is a different claim.
 *
 * The plan's names for these two capabilities (`research.productionInputInspect` / `Read`)
 * do not exist; the real ones are `research.artifacts.inspectProduction` /
 * `research.artifacts.readProductionFile` (F18). Text files are read on demand through
 * `readProductionInputFile` and their encoding is honoured (`utf8` shown as-is, `base64`
 * labelled as binary metadata) — the panel never pretends to have inspected a binary.
 */

const PRODUCTION_KINDS: ReadonlySet<ResearchArtifact['kind']> = new Set([
  'experiment_run',
  'figure',
  'export_package'
]);

export function ProductionInputPanel({ artifact }: { artifact: ResearchArtifact | null }): React.JSX.Element {
  const scope = useWorkspaceScope();
  const supported = artifact !== null && PRODUCTION_KINDS.has(artifact.kind);
  const resource = useAsyncResource<ResearchProductionInput>(
    supported && artifact !== null ? `production-input:${artifact.id}` : null,
    () => inspectProductionInput(scope.client, artifact?.projectId ?? '', artifact?.id ?? ''),
    { label: '检查生产输入' }
  );
  const [opened, setOpened] = useState<{ path: string; content: ResearchProductionInputContent } | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  const readFile = useCallback(
    async (area: ResearchProductionInput['files'][number]['area'], path: string): Promise<void> => {
      if (artifact === null) {
        return;
      }
      setReading(true);
      setReadError(null);
      const result = await readProductionInputFile(scope.client, {
        projectId: artifact.projectId,
        artifactId: artifact.id,
        area,
        path
      });
      setReading(false);
      if (!result.ok) {
        setReadError(result.error.message);
        return;
      }
      setOpened({ path, content: result.data });
    },
    [artifact, scope.client]
  );

  if (artifact === null) {
    return (
      <section className="rounded-card border border-line bg-surface px-3 py-2.5" data-testid="workflow-production-input">
        <p className="text-muted text-[var(--font-meta-size)]" role="status">
          先选择一个产物，这里会显示它的运行目录与文件清单。
        </p>
      </section>
    );
  }

  if (!supported) {
    return (
      <section className="rounded-card border border-line bg-surface px-3 py-2.5" data-testid="workflow-production-input">
        <p className="text-muted text-[var(--font-meta-size)]" role="status">
          「{artifact.title}」是{artifact.kind === 'manuscript' ? '正文' : '文本类'}产物，没有生产运行目录：
          实验运行 / 图稿 / 导出包才会有输入与日志文件。
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-2" data-testid="workflow-production-input">
      <header className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 text-subtle text-[var(--font-micro-size)]">
          <FileText size={12} aria-hidden="true" />
          生产输入
        </span>
        {resource.data === null ? null : (
          <span className="text-subtle text-[var(--font-micro-size)]" data-testid="workflow-production-input-source">
            {resource.data.source.kind === 'experiment'
              ? '实验运行'
              : resource.data.source.kind === 'figure'
                ? '图稿运行'
                : '导出作业'}
            {' · '}
            {resource.data.files.length} 个文件
          </span>
        )}
      </header>

      {resource.status === 'loading' ? (
        <p className="text-muted text-[var(--font-meta-size)]" role="status">
          正在检查运行目录…
        </p>
      ) : null}
      {resource.status === 'error' ? (
        <ErrorBar
          error={{
            level: 'page',
            message: resource.error ?? '检查生产输入失败',
            retry: resource.reload,
            actionLabel: 'research.artifacts.inspectProduction'
          }}
        />
      ) : null}

      {resource.data === null ? null : resource.data.files.length === 0 ? (
        <p className="text-[var(--st-warn)] text-[var(--font-meta-size)]" role="note" data-testid="workflow-production-input-empty">
          运行目录里还没有文件：先让该阶段真正执行并发布运行，输入清单才有内容。
        </p>
      ) : (
        <ul className="flex flex-col gap-1" data-testid="workflow-production-input-files">
          {resource.data.files.map((file) => (
            <li key={`${file.area}:${file.path}`} className="flex items-center gap-2 text-[var(--font-meta-size)]">
              <span className="w-14 shrink-0 text-subtle">{areaLabel(file.area)}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-ink" title={file.path}>
                {file.path}
              </span>
              <span className="shrink-0 text-subtle">{formatBytes(file.size)}</span>
              <button
                type="button"
                data-testid={`workflow-production-input-read-${file.area}-${file.path}`}
                disabled={reading}
                onClick={() => void readFile(file.area, file.path)}
                className="shrink-0 rounded-control border border-line px-1.5 py-0.5 text-muted text-[var(--font-micro-size)] hover:text-ink active:bg-[var(--overlay-active)] disabled:opacity-50"
              >
                查看
              </button>
            </li>
          ))}
        </ul>
      )}

      {readError === null ? null : (
        <p className="text-[var(--st-bad)] text-[var(--font-meta-size)]" role="alert" data-testid="workflow-production-input-error">
          读取失败：{readError}
        </p>
      )}

      {opened === null ? null : (
        <div className="flex flex-col gap-1 rounded-card border border-line bg-bg-soft px-2.5 py-2" data-testid="workflow-production-input-content">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-muted text-[var(--font-micro-size)]">{opened.path}</span>
            <span className="text-subtle text-[var(--font-micro-size)]">{opened.content.encoding}</span>
            <button
              type="button"
              onClick={() => setOpened(null)}
              className="rounded-control px-1.5 text-subtle text-[var(--font-micro-size)] hover:text-ink"
            >
              关闭
            </button>
          </div>
          {opened.content.encoding === 'base64' ? (
            <p className="text-muted text-[var(--font-meta-size)]">
              这是二进制文件（{formatBytes(opened.content.file.size)}），这里只显示元数据：P6 不把二进制内容塞进正文。
            </p>
          ) : (
            <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap font-mono text-[var(--code-text)] text-[var(--font-code-size)]">
              {opened.content.content}
            </pre>
          )}
        </div>
      )}
    </section>
  );
}

function areaLabel(area: ResearchProductionInput['files'][number]['area']): string {
  if (area === 'input') return '输入';
  if (area === 'output') return '输出';
  if (area === 'log') return '日志';
  return '打包';
}
