import { Suspense, lazy, useState } from 'react';
import { ChevronRight, DownloadCloud, File as FileIcon, Folder, Package, RefreshCw, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '../../shell/ConfirmDialog';
import { formatBytes } from '../../shared/format';
import { FormNote, FormSection, KeyValueRow, formInputClass, formSecondaryButtonClass } from '../../shared/form-ui';
import { DelayedFallback } from '../../shell/DelayedFallback';
import {
  builtinSourceActionLabel,
  builtinSourceSummary,
  formatBuiltinTimestamp,
  shortCommit,
  filePreviewKind,
  joinRelativePath,
  parentRelativePath,
  pathSegments,
  previewSizeLabel,
  previewTruncatedNote,
  skillStatusLabels,
  sortSkills,
  skillSummary,
  validateSkillImportPathRequired
} from '../skill-model';
import type { SkillsStore } from '../use-skills';

/**
 * 技能 (P9/T9.2).
 *
 * ## Import is a path, and that is a contract fact rather than a shortcut
 *
 * `skills.import` resolves a **directory** containing `SKILL.md`, and the only directory dialog
 * the renderer has is `workspace.selectFromDialog` — which *binds the chosen directory as the
 * working directory*, an unacceptable side effect for "import a skill". `files.selectFromDialog`
 * returns files and cannot select a directory at all. So the panel asks for an absolute path and
 * says why (B24); a ZIP is not accepted because the service has no ZIP path.
 *
 * ## The file browser is one level at a time
 *
 * `skills.files.list` takes `{id, relativePath}` and returns that directory's entries, so the
 * panel keeps a path cursor with a breadcrumb instead of pretending it has a tree. A preview
 * stays on screen while you browse to a sibling directory (it is addressed by path, not by
 * directory contents).
 *
 * The markdown preview reuses the assistant's `MarkdownView` through a **lazy import** (the same
 * boundary `ArtifactPanel` uses), so `react-markdown`/`streamdown` never enter the management
 * chunk, let alone the eager graph.
 */

const MarkdownView = lazy(async () => ({ default: (await import('../../assistant/blocks/markdown-view')).MarkdownView }));

export function SkillsSection({ store: skills }: { store: SkillsStore }): React.JSX.Element {
  const [importPath, setImportPath] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const importRequired = validateSkillImportPathRequired(importPath);
  const segments = pathSegments(skills.dirPath);
  const deleteSkillRecord = skills.skills.find((skill) => skill.id === deleteTarget) ?? null;

  const builtin = skills.builtin;
  const builtinSnapshot = builtin.snapshot;

  return (
    <div className="flex min-h-0 flex-col gap-3" data-testid="mgmt-skills">
      <FormSection
        title="内置技能源"
        testId="mgmt-skills-builtin"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted text-[var(--font-meta-size)]" data-testid="mgmt-skills-builtin-summary">
            {builtinSnapshot === null
              ? builtin.status === 'loading'
                ? '读取内置技能源…'
                : '没有可用的内置技能源'
              : `${builtinSnapshot.sources.length} 个来源 · 上次检查 ${formatBuiltinTimestamp(builtinSnapshot.lastCheckedAt)}${builtinSnapshot.updating ? ' · 正在同步' : ''}`}
          </span>
          <button
            type="button"
            data-testid="mgmt-skills-builtin-check"
            disabled={builtin.check.pending || builtinSnapshot?.updating === true}
            onClick={() => {
              void builtin.check.run(true);
            }}
            className={`${formSecondaryButtonClass} inline-flex items-center gap-1`}
          >
            <RefreshCw size={11} aria-hidden="true" />
            {builtin.check.pending || builtinSnapshot?.updating === true ? '检查中…' : '立即检查更新'}
          </button>
          <label className="flex items-center gap-1 text-[var(--font-micro-size)] text-muted">
            <input
              type="checkbox"
              checked={builtinSnapshot?.autoUpdate ?? true}
              disabled={builtinSnapshot === null || builtin.autoUpdate.pending}
              onChange={(event) => {
                void builtin.autoUpdate.run(event.target.checked);
              }}
              data-testid="mgmt-skills-builtin-auto-update"
              className="h-3.5 w-3.5 rounded-[3px] border border-line accent-[var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            />
            每天自动检查
          </label>
        </div>

        {builtin.status === 'error' ? (
          <FormNote tone="warn" testId="mgmt-skills-builtin-error">
            {builtin.error}
          </FormNote>
        ) : null}
        {builtin.check.error === null ? null : (
          <FormNote tone="warn" testId="mgmt-skills-builtin-action-error">
            {builtin.check.error}
          </FormNote>
        )}
        {builtin.check.lastChanged === true ? (
          <FormNote testId="mgmt-skills-builtin-changed">已从上游同步到新版本。</FormNote>
        ) : null}

        {builtinSnapshot === null ? null : (
          <ul className="flex flex-col gap-1" data-testid="mgmt-skills-builtin-rows">
            {builtinSnapshot.sources.map((source) => (
              <li
                key={source.id}
                className="flex flex-col gap-1 rounded-card px-2 py-1.5 hover:bg-[var(--overlay-hover)]"
                data-testid={`mgmt-skills-builtin-${source.id}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                    <DownloadCloud size={12} aria-hidden="true" className="text-muted" />
                    <span className="text-ink text-[var(--font-meta-size)]">{source.displayName}</span>
                    <span className="font-mono text-subtle text-[var(--font-micro-size)]">{source.repo}</span>
                    <span className="text-muted text-[var(--font-micro-size)]" data-testid={`mgmt-skills-builtin-license-${source.id}`}>
                      {source.license ?? '许可证未知'}
                    </span>
                  </span>
                  <button
                    type="button"
                    data-testid={`mgmt-skills-builtin-restore-${source.id}`}
                    disabled={builtin.restore.pending}
                    onClick={() => {
                      void builtin.restore.run(source.id);
                    }}
                    className={formSecondaryButtonClass}
                  >
                    {builtin.restore.pending && builtin.restore.sourceId === source.id
                      ? '安装中…'
                      : builtinSourceActionLabel(source)}
                  </button>
                </div>
                <span className="text-muted text-[var(--font-micro-size)]" data-testid={`mgmt-skills-builtin-state-${source.id}`}>
                  {builtinSourceSummary(source)} · 上游 {shortCommit(source.installedCommit)} · 检查于{' '}
                  {formatBuiltinTimestamp(source.lastCheckedAt)}
                </span>
                {source.lastError === null ? null : (
                  <FormNote tone="warn" testId={`mgmt-skills-builtin-last-error-${source.id}`}>
                    {source.lastError}
                  </FormNote>
                )}
                {source.installedCommit === null && source.license !== null && source.license !== 'Apache-2.0' ? (
                  <FormNote testId={`mgmt-skills-builtin-license-note-${source.id}`}>
                    该来源使用 {source.license} 许可，点安装即表示接受。
                  </FormNote>
                ) : null}
              </li>
            ))}
          </ul>
        )}

      </FormSection>

      <FormSection
        title="已安装技能"
        testId="mgmt-skills-list-section"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted text-[var(--font-meta-size)]" data-testid="mgmt-skills-summary">
            {skillSummary(skills.skills)}
          </span>
          <button
            type="button"
            data-testid="mgmt-skills-reload"
            disabled={skills.status === 'loading'}
            onClick={() => skills.reload()}
            className={`${formSecondaryButtonClass} inline-flex items-center gap-1`}
          >
            <RefreshCw size={11} aria-hidden="true" />
            重新读取
          </button>
          {skills.error === null ? null : (
            <FormNote tone="warn" testId="mgmt-skills-error">
              {skills.error}
            </FormNote>
          )}
          {/*启停 / 导入 / 删除共用一个错误状态：一处渲染，失败不会被吞掉。*/}
          {skills.toggleEnabled.error === null ? null : (
            <FormNote tone="warn" testId="mgmt-skills-mutation-error">
              操作失败：{skills.toggleEnabled.error}
            </FormNote>
          )}
        </div>

        {skills.status === 'loading' && skills.skills.length === 0 ? (
          <FormNote testId="mgmt-skills-loading">正在读取技能目录…</FormNote>
        ) : skills.skills.length === 0 ? null : (
          <ul className="flex flex-col gap-1" data-testid="mgmt-skills-rows">
            {sortSkills(skills.skills).map((skill) => {
              const selected = skill.id === skills.selectedId;
              return (
                <li
                  key={skill.id}
                  className={
                    selected
                      ? 'flex flex-col gap-1 rounded-card bg-accent-soft px-2 py-1.5'
                      : 'flex flex-col gap-1 rounded-card px-2 py-1.5 hover:bg-[var(--overlay-hover)]'
                  }
                  data-testid={`mgmt-skill-${skill.id}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => skills.select(skill.id)}
                      data-testid={`mgmt-skill-select-${skill.id}`}
                      className="min-w-0 flex-1 text-left"
                    >
                      <span className="flex flex-wrap items-center gap-2">
                        <Package size={12} aria-hidden="true" className="text-muted" />
                        <span className="text-ink text-[var(--font-meta-size)]">{skill.name}</span>
                        <span className="font-mono text-subtle text-[var(--font-micro-size)]">{skill.id}</span>
                        <span
                          className={
                            skill.status === 'ready'
                              ? 'text-muted text-[var(--font-micro-size)]'
                              : 'text-[var(--st-bad)] text-[var(--font-micro-size)]'
                          }
                          data-testid={`mgmt-skill-status-${skill.id}`}
                        >
                          {skillStatusLabels[skill.status]}
                        </span>
                        <span
                          className="text-subtle text-[var(--font-micro-size)]"
                          data-testid={`mgmt-skill-origin-${skill.id}`}
                        >
                          {skill.origin === 'builtin'
                            ? `内置 · ${skill.sourceId ?? ''} · ${shortCommit(skill.upstreamCommit ?? null)}`
                            : '用户导入'}
                        </span>
                      </span>
                      <span className="block text-muted text-[var(--font-micro-size)]">{skill.description}</span>
                    </button>
                    <label className="flex items-center gap-1 text-[var(--font-micro-size)] text-muted">
                      <input
                        type="checkbox"
                        checked={skills.skillEnabled(skill)}
                        disabled={skills.toggleEnabled.pending}
                        onChange={(event) => {
                          void skills.toggleEnabled.run(skill, event.target.checked);
                        }}
                        data-testid={`mgmt-skill-enabled-${skill.id}`}
                        className="h-3.5 w-3.5 rounded-[3px] border border-line accent-[var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                      />
                      启用
                    </label>
                    <button
                      type="button"
                      data-testid={`mgmt-skill-delete-${skill.id}`}
                      disabled={skills.remove.pending}
                      onClick={() => setDeleteTarget(skill.id)}
                      className={`${formSecondaryButtonClass} inline-flex items-center gap-1`}
                    >
                      <Trash2 size={11} aria-hidden="true" />
                      删除
                    </button>
                  </div>
                  {skill.lastError === null || skill.lastError === undefined ? null : (
                    <FormNote tone="warn" testId={`mgmt-skill-last-error-${skill.id}`}>
                      {skill.lastError}
                    </FormNote>
                  )}
                </li>
              );
            })}
          </ul>
        )}

      </FormSection>

      <FormSection title="导入技能" testId="mgmt-skills-import">
        <label className="flex flex-col gap-0.5">
          <span className="text-subtle text-[var(--font-micro-size)]">技能目录的绝对路径</span>
          <input
            value={importPath}
            onChange={(event) => setImportPath(event.target.value)}
            placeholder="/Users/you/skills/my-skill"
            data-testid="mgmt-skills-import-path"
            className={formInputClass}
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="mgmt-skills-import-run"
            disabled={skills.importFrom.pending || importRequired !== null}
            onClick={() => {
              void skills.importFrom.run(importPath);
            }}
            className={formSecondaryButtonClass}
          >
            {skills.importFrom.pending ? '导入中…' : '导入'}
          </button>
          {skills.importFrom.lastImported === null ? null : (
            <span className="text-muted text-[var(--font-micro-size)]" data-testid="mgmt-skills-import-result">
              已导入 {skills.importFrom.lastImported.name}（{skills.importFrom.lastImported.path}）
            </span>
          )}
        </div>
        {importRequired === null ? null : (
          <FormNote tone="warn" testId="mgmt-skills-import-hint">
            {importRequired}
          </FormNote>
        )}
      </FormSection>

      {skills.selected === null ? null : (
        <FormSection
          title={`文件（${skills.selected.name}）`}
          testId="mgmt-skills-files"
        >
          <dl className="flex flex-col gap-0.5">
            <KeyValueRow label="根目录" value={skills.rootPath ?? skills.selected.path} testId="mgmt-skill-root" />
            <KeyValueRow label="描述" value={skills.selected.description} testId="mgmt-skill-description" />
          </dl>

          <div className="flex flex-wrap items-center gap-1" data-testid="mgmt-skill-breadcrumb">
            <button
              type="button"
              onClick={() => skills.setDirPath('')}
              data-testid="mgmt-skill-crumb-root"
              className="rounded-control px-1 text-muted text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)] hover:text-ink"
            >
              {skills.selected.name}
            </button>
            {segments.map((segment, index) => {
              const path = segments.slice(0, index + 1).join('/');
              return (
                <span key={path} className="flex items-center gap-1">
                  <ChevronRight size={10} aria-hidden="true" className="text-subtle" />
                  <button
                    type="button"
                    onClick={() => skills.setDirPath(path)}
                    data-testid={`mgmt-skill-crumb-${path}`}
                    className="rounded-control px-1 text-muted text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)] hover:text-ink"
                  >
                    {segment}
                  </button>
                </span>
              );
            })}
          </div>

          {skills.treeError === null ? null : (
            <FormNote tone="warn" testId="mgmt-skill-tree-error">
              {skills.treeError}
            </FormNote>
          )}
          {skills.entries.length === 0 ? (
            <FormNote testId="mgmt-skill-tree-empty">
              {skills.treeStatus === 'loading' ? '读取目录中…' : '这个目录是空的。'}
            </FormNote>
          ) : (
            <ul className="flex flex-col gap-0.5" data-testid="mgmt-skill-entries">
              {skills.dirPath === '' ? null : (
                <li>
                  <button
                    type="button"
                    onClick={() => skills.setDirPath(parentRelativePath(skills.dirPath))}
                    data-testid="mgmt-skill-up"
                    className="flex w-full items-center gap-1 rounded-control px-1 py-0.5 text-left text-muted text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)] hover:text-ink"
                  >
                    <Folder size={11} aria-hidden="true" />
                    ..
                  </button>
                </li>
              )}
              {skills.entries.map((entry) => {
                const path = joinRelativePath(skills.dirPath, entry.name);
                return (
                  <li key={entry.relativePath}>
                    <button
                      type="button"
                      data-testid={`mgmt-skill-entry-${entry.relativePath}`}
                      onClick={() => {
                        if (entry.type === 'directory') {
                          skills.setDirPath(path);
                          return;
                        }
                        skills.openFile(path);
                      }}
                      className={
                        entry.relativePath === skills.previewPath
                          ? 'flex w-full items-center gap-1 rounded-control bg-accent-soft px-1 py-0.5 text-left'
                          : 'flex w-full items-center gap-1 rounded-control px-1 py-0.5 text-left hover:bg-[var(--overlay-hover)]'
                      }
                    >
                      {entry.type === 'directory' ? (
                        <Folder size={11} aria-hidden="true" className="text-muted" />
                      ) : (
                        <FileIcon size={11} aria-hidden="true" className="text-muted" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-muted text-[var(--font-micro-size)]">{entry.name}</span>
                      <span className="shrink-0 text-subtle text-[var(--font-micro-size)]">
                        {entry.type === 'directory' ? '' : formatBytes(entry.size)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {skills.treeTruncated ? (
            <FormNote tone="warn" testId="mgmt-skill-tree-truncated">
              目录条目过多，只显示前一部分。
            </FormNote>
          ) : null}

          {skills.previewPath === null ? null : (
            <div className="flex flex-col gap-1 border-t border-line pt-2" data-testid="mgmt-skill-preview">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-muted text-[var(--font-micro-size)]">{skills.previewPath}</span>
                {skills.preview === null ? null : (
                  <span className="text-subtle text-[var(--font-micro-size)]">{previewSizeLabel(skills.preview)}</span>
                )}
                <button
                  type="button"
                  onClick={() => skills.closePreview()}
                  data-testid="mgmt-skill-preview-close"
                  className={`${formSecondaryButtonClass} ml-auto`}
                >
                  关闭预览
                </button>
              </div>
              {skills.previewError === null ? null : (
                <FormNote tone="warn" testId="mgmt-skill-preview-error">
                  {skills.previewError}
                </FormNote>
              )}
              {skills.preview === null ? (
                <FormNote testId="mgmt-skill-preview-loading">
                  {skills.previewStatus === 'loading' ? '读取中…' : '没有内容。'}
                </FormNote>
              ) : (
                <>
                  {previewTruncatedNote(skills.preview) === null ? null : (
                    <FormNote tone="warn" testId="mgmt-skill-preview-truncated">
                      {previewTruncatedNote(skills.preview)}
                    </FormNote>
                  )}
                  {filePreviewKind(skills.preview) === 'image' ? (
                    <img
                      src={skills.preview.content}
                      alt={skills.preview.relativePath}
                      data-testid="mgmt-skill-preview-image"
                      className="max-h-[240px] max-w-full rounded-card border border-line"
                    />
                  ) : filePreviewKind(skills.preview) === 'binary' ? (
                    <FormNote testId="mgmt-skill-preview-binary">
                      二进制文件：只显示大小与类型（{skills.preview.mediaType ?? '未知类型'}）。
                    </FormNote>
                  ) : filePreviewKind(skills.preview) === 'markdown' ? (
                    <Suspense fallback={<DelayedFallback label="正在加载 Markdown 渲染…" />}>
                      <div
                        className="max-h-[320px] overflow-y-auto rounded-card border border-line bg-surface px-2 py-1.5"
                        data-testid="mgmt-skill-preview-markdown"
                      >
                        <MarkdownView text={skills.preview.content} />
                      </div>
                    </Suspense>
                  ) : (
                    <pre
                      className="max-h-[320px] overflow-auto whitespace-pre-wrap rounded-card border border-line bg-bg-soft px-2 py-1.5 font-mono text-[var(--font-code-size)] text-muted"
                      data-testid="mgmt-skill-preview-text"
                    >
                      {skills.preview.content}
                    </pre>
                  )}
                </>
              )}
            </div>
          )}
        </FormSection>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除这个技能？"
        message={`将删除技能目录 ${deleteSkillRecord?.path ?? deleteTarget ?? ''}。`}
        detail="只删除 Roc 技能目录下的副本。"
        confirmLabel="删除"
        tone="destructive"
        testId="mgmt-skills-delete-confirm"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          const target = deleteTarget;
          setDeleteTarget(null);
          if (target !== null) {
            void skills.remove.run(target);
          }
        }}
      />
    </div>
  );
}
