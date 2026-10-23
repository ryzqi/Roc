import { Suspense, lazy } from 'react';
import { ChevronRight, File as FileIcon, Folder } from 'lucide-react';
import { ModalShell } from '../../shell/ModalShell';
import { DelayedFallback } from '../../shell/DelayedFallback';
import { formatBytes } from '../../shared/format';
import { FormNote, KeyValueRow, formSecondaryButtonClass } from '../../shared/form-ui';
import {
  filePreviewKind,
  joinRelativePath,
  parentRelativePath,
  pathSegments,
  previewSizeLabel,
  previewTruncatedNote
} from '../skill-model';
import type { SkillsStore } from '../use-skills';

/**
 * 技能文件浏览器（浮层）。
 *
 * ## 为什么是浮层而不是分区底部的第三个 FormSection
 *
 * 它以前是技能分区末尾的一段内联内容：选中技能后，读完「内置技能源 → 已安装技能 → 导入技能」
 * 三块之后才在页面最下方出现，用户点一下技能列表，视线要跨过整个面板才知道点开了什么；在
 * 720px 的抽屉里它还会把上面的列表顶出视野。文件浏览器是对**一个**技能的聚焦查看，不是分区
 * 的第四段，所以它现在是 `ModalShell` 的 `modal` 层：浮在分区之上，关掉即回到列表。
 *
 * 打开条件就是 `skills.selected !== null`——和旧行为同一个开关（点行选中 / 再点关闭），
 * 只是呈现位置从页面底部换成了浮层。
 *
 * ## 契约
 *
 * `skills.files.list` 一次只给一层目录，所以这里保留面包屑游标而不是假装有一棵树；
 * 预览按路径寻址，浏览同级目录时不会被打断。markdown 预览沿用助手的 `MarkdownView`，走
 * **懒加载**边界，`react-markdown`/`streamdown` 不会进入管理面板的 chunk，更不会进 eager 图。
 */
const MarkdownView = lazy(async () => ({ default: (await import('../../assistant/blocks/markdown-view')).MarkdownView }));

export function SkillFilesModal({
  store: skills,
  open,
  onClose
}: {
  store: SkillsStore;
  open: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const selected = skills.selected;
  const segments = pathSegments(skills.dirPath);

  return (
    <ModalShell
      open={open && selected !== null}
      title={selected === null ? '技能文件' : `技能文件 · ${selected.name}`}
      onClose={onClose}
      widthClassName="w-[min(680px,92vw)] h-[min(78vh,680px)]"
      testId="mgmt-skill-files"
    >
      {selected === null ? null : (
        <div className="flex h-full min-h-0 flex-col gap-2" data-testid="mgmt-skills-files">
          <dl className="flex shrink-0 flex-col gap-0.5">
            <KeyValueRow label="根目录" value={skills.rootPath ?? selected.path} testId="mgmt-skill-root" />
            <KeyValueRow label="描述" value={selected.description} testId="mgmt-skill-description" />
          </dl>

          <div className="flex shrink-0 flex-wrap items-center gap-1" data-testid="mgmt-skill-breadcrumb">
            <button
              type="button"
              onClick={() => skills.setDirPath('')}
              data-testid="mgmt-skill-crumb-root"
              className="rounded-control px-1 text-muted text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            >
              {selected.name}
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
                    className="rounded-control px-1 text-muted text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
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

          {/* 两栏：左边是当前目录，右边是预览。抽屉能放下 680px，所以文件和内容可以同时看，
              不再像内联版本那样上下堆叠、还要各自滚动。 */}
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,200px)_minmax(0,1fr)] gap-2">
            <div className="flex min-h-0 flex-col gap-1 overflow-y-auto">
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
                        className="flex w-full items-center gap-1 rounded-control px-1 py-0.5 text-left text-muted text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
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
                              : 'flex w-full items-center gap-1 rounded-control px-1 py-0.5 text-left hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent'
                          }
                        >
                          {entry.type === 'directory' ? (
                            <Folder size={11} aria-hidden="true" className="shrink-0 text-muted" />
                          ) : (
                            <FileIcon size={11} aria-hidden="true" className="shrink-0 text-muted" />
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
            </div>

            <div className="flex min-h-0 min-w-0 flex-col gap-1 overflow-y-auto border-l border-line-soft pl-2">
              {skills.previewPath === null ? (
                <FormNote testId="mgmt-skill-preview-empty">从左边选一个文件查看内容。</FormNote>
              ) : (
                <div className="flex flex-col gap-1" data-testid="mgmt-skill-preview">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-muted text-[var(--font-micro-size)]">{skills.previewPath}</span>
                    {skills.preview === null ? null : (
                      <span className="shrink-0 text-subtle text-[var(--font-micro-size)]">{previewSizeLabel(skills.preview)}</span>
                    )}
                    <button
                      type="button"
                      onClick={() => skills.closePreview()}
                      data-testid="mgmt-skill-preview-close"
                      className={`${formSecondaryButtonClass} shrink-0`}
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
                            className="rounded-card border border-line bg-surface px-2 py-1.5"
                            data-testid="mgmt-skill-preview-markdown"
                          >
                            <MarkdownView text={skills.preview.content} />
                          </div>
                        </Suspense>
                      ) : (
                        <pre
                          className="whitespace-pre-wrap rounded-card border border-line bg-bg-soft px-2 py-1.5 font-mono text-[var(--font-code-size)] text-muted"
                          data-testid="mgmt-skill-preview-text"
                        >
                          {skills.preview.content}
                        </pre>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </ModalShell>
  );
}
