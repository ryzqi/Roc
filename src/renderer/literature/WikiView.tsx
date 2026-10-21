import { useMemo, useState } from 'react';
import { BookMarked, Bot, CalendarClock, Check, ClipboardCopy, Layers, Link2, Search, X } from 'lucide-react';
import type { ResearchClaim, ResearchEvidence, ResearchLibraryItem } from '../../shared/types';
import { useCopyFeedback } from '../shared/hooks/use-copy-feedback';
import { EmptyState } from '../shell/EmptyState';
import { deriveWiki } from './derive-wiki';

/**
 * LLM Wiki projection view.
 *
 * The legacy view rendered `mockWikiEntries` when the store was empty. That is the
 * exact failure R12 names, so here the empty case is an empty state and nothing
 * else. Every panel is a projection of real rows: claims, the evidence they cite,
 * and the library items that evidence came from.
 *
 * What a "concept" means in this build is stated in the header rather than implied:
 * one claim plus its evidence and the papers it leans on. Two claims that cite the
 * same paper are shown as *linked*, never as "about the same thing" — the backend
 * has no concept table and inventing one would be a fabricated model.
 *
 * Every card ends with the interfaces it came from, so a user can tell a derived
 * page from a stored one.
 *
 * ## Navigable, because a wall of cards is not a wiki
 *
 * A wiki is a *reading surface*: a concept list, a selected concept with links out to
 * other concepts and to the papers behind it, and a copy button. Stacking every page
 * into one scroll column would lose all of that — a concept could not be chosen,
 * searched for, or followed. What is here:
 *
 *   - **selection** — the list on the left drives the detail on the right, with the
 *     selected row is raised;
 *   - **filter** — title, statement, evidence text and paper titles, because the
 *     only way to find a concept is to search what is actually in it;
 *   - **navigation** — the 共现 list is not decoration: clicking either side selects
 *     that concept, which is this projection's equivalent of a `[[wiki link]]`. (There is no
 *     `[[…]]` syntax to parse: a derived concept's
 *     body is the claim's own statement, not authored wiki text.)
 *   - **the papers behind a concept are buttons** — they jump to that item in the
 *     reader;
 *   - **copy as Markdown** — a 「复制」 action with 已复制 feedback,
 *     assembled from the derived page.
 *
 * The 演进时间线 / 共现 / 未归类证据 panels stay, because the design requires every
 * derived view to be inspectable rather than summarised. They moved into the left
 * column so they do not compete with the page being read.
 */

export type WikiViewProps = {
  claims: readonly ResearchClaim[];
  evidence: readonly ResearchEvidence[];
  libraryItems: readonly ResearchLibraryItem[];
  /** Jump to the graph focused on this claim. */
  onOpenClaim: (claimId: string) => void;
  /** Jump to the reader for a library item behind this concept. */
  onOpenPaper?: (libraryItemId: string) => void;
  /** Hand the concept to the research assistant. */
  onAskAssistant?: (prompt: string) => void;
};

const STATUS_LABELS: Readonly<Record<ResearchClaim['status'], string>> = {
  supported: '有支撑',
  hypothesis: '假设',
  pending: '待定'
};

const STATUS_CLASS: Readonly<Record<ResearchClaim['status'], string>> = {
  supported: 'text-[var(--st-ok)]',
  hypothesis: 'text-[var(--st-info)]',
  pending: 'text-[var(--st-warn)]'
};

export function WikiView({
  claims,
  evidence,
  libraryItems,
  onOpenClaim,
  onOpenPaper,
  onAskAssistant
}: WikiViewProps): React.JSX.Element {
  const projection = useMemo(
    () => deriveWiki({ claims, evidence, libraryItems }),
    [claims, evidence, libraryItems]
  );
  const [selectedClaimId, setSelectedClaimId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const copy = useCopyFeedback();

  if (projection.pages.length === 0 && projection.orphanEvidence.length === 0) {
    return (
      <EmptyState
        icon={BookMarked}
        title="尚无概念页"
        description="先导入文献并捕获证据，再把证据关联到主张；概念页由主张与证据派生，不预置示例内容。"
        testId="wiki-empty"
      />
    );
  }

  const trimmed = query.trim().toLowerCase();
  const visiblePages = projection.pages.filter((page) => {
    if (trimmed.length === 0) {
      return true;
    }
    const haystack = [
      page.title,
      page.content,
      ...page.evidence.flatMap((card) => [card.title, card.excerpt, card.locator]),
      ...page.papers.map((paper) => paper.title)
    ]
      .join('\n')
      .toLowerCase();
    return haystack.includes(trimmed);
  });

  // Selection falls back to the first *visible* page, so filtering cannot leave the
  // detail pane showing a concept the list no longer offers.
  const selected =
    visiblePages.find((page) => page.claimId === selectedClaimId) ?? visiblePages[0] ?? null;

  const selectConcept = (claimId: string): void => {
    setSelectedClaimId(claimId);
  };

  const pageAsMarkdown = (page: (typeof projection.pages)[number]): string => {
    const lines = [`# ${page.title}`, '', page.content, ''];
    if (page.evidence.length > 0) {
      lines.push('## 证据', '');
      for (const card of page.evidence) {
        lines.push(`- ${card.title} — ${card.locator}`, `  > ${card.excerpt}`);
      }
      lines.push('');
    }
    if (page.papers.length > 0) {
      lines.push('## 相关文献', '');
      for (const paper of page.papers) {
        lines.push(`- ${paper.title}${paper.year === null ? '' : ` (${paper.year})`}`);
      }
      lines.push('');
    }
    lines.push(
      `状态：${STATUS_LABELS[page.status]}`,
      '',
      '来源：当前文献、主张与关联证据'
    );
    return lines.join('\n');
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="wiki-view">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-[var(--font-micro-size)]">
        <span className="text-muted" data-testid="wiki-counts">
          {projection.pages.length} 个概念 · {projection.backlinks.length} 条共现 · {projection.timeline.length} 个年份
        </span>
        <span className="text-subtle">
          每个概念由一条主张和它引用的证据组成。
        </span>
        <div className="ml-auto flex h-[var(--control-height-compact)] min-w-[150px] items-center gap-1.5 rounded-control border border-line bg-surface px-2 sm:max-w-[240px]">
          <Search size={11} aria-hidden="true" className="shrink-0 text-subtle" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索概念、证据、文献…"
            aria-label="搜索概念页"
            data-testid="wiki-search"
            className="min-w-0 flex-1 bg-transparent text-ink text-[var(--font-micro-size)] placeholder:text-subtle"
          />
          {query.length === 0 ? null : (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="清除搜索"
              data-testid="wiki-search-clear"
              className="shrink-0 rounded-control text-subtle hover:text-ink"
            >
              <X size={11} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside
          className="flex w-56 shrink-0 flex-col gap-3 overflow-y-auto border-r border-line p-2 md:w-64"
          aria-label="概念列表"
        >
          <ul className="flex flex-col gap-0.5" data-testid="wiki-concept-list">
            {visiblePages.length === 0 ? (
              <li className="px-2 py-3 text-muted text-[var(--font-meta-size)]" data-testid="wiki-no-match">
                没有匹配的概念。
              </li>
            ) : null}
            {visiblePages.map((page) => {
              const active = selected !== null && page.claimId === selected.claimId;
              return (
                <li key={page.claimId}>
                  <button
                    type="button"
                    onClick={() => selectConcept(page.claimId)}
                    aria-current={active ? 'true' : undefined}
                    data-testid={`wiki-concept-${page.claimId}`}
                    className={`flex w-full flex-col gap-0.5 rounded-card border px-2 py-1.5 text-left transition-colors duration-[var(--duration-fast)] ${
                      active
                        ? 'border-line-strong bg-[var(--surface-card-hover)] shadow-[var(--shadow-card)]'
                        : 'border-transparent hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]'
                    }`}
                  >
                    <span className="w-full truncate text-ink text-[var(--font-meta-size)]">{page.title}</span>
                    <span className="flex items-center gap-1.5 text-[var(--font-micro-size)]">
                      <span className={STATUS_CLASS[page.status]}>{STATUS_LABELS[page.status]}</span>
                      <span className="text-subtle">{page.evidence.length} 条证据</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {projection.backlinks.length === 0 ? null : (
            <section>
              <h3 className="mb-1 flex items-center gap-1.5 text-muted text-[var(--font-micro-size)]">
                <Link2 size={11} aria-hidden="true" />
                共现（共享证据的主张）
              </h3>
              <ul className="flex flex-col gap-1" data-testid="wiki-backlinks">
                {projection.backlinks.map((link) => (
                  <li key={`${link.fromClaimId}:${link.toClaimId}`} className="text-[var(--font-micro-size)]">
                    <button
                      type="button"
                      onClick={() => selectConcept(link.fromClaimId)}
                      className="max-w-full truncate rounded-control px-1 text-left text-ink hover:bg-[var(--overlay-hover)]"
                    >
                      {conceptLabelFor(projection, link.fromClaimId)}
                    </button>
                    <span className="mx-0.5 text-subtle">↔</span>
                    <button
                      type="button"
                      onClick={() => selectConcept(link.toClaimId)}
                      className="max-w-full truncate rounded-control px-1 text-left text-ink hover:bg-[var(--overlay-hover)]"
                    >
                      {conceptLabelFor(projection, link.toClaimId)}
                    </button>
                    <span className="ml-1 text-subtle">共享 {link.sharedEvidenceIds.length} 条证据</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {projection.timeline.length === 0 ? null : (
            <section>
              <h3 className="mb-1 flex items-center gap-1.5 text-muted text-[var(--font-micro-size)]">
                <CalendarClock size={11} aria-hidden="true" />
                演进时间线（只使用文献真实的年份）
              </h3>
              <ol className="flex flex-wrap items-center gap-1.5" data-testid="wiki-timeline">
                {projection.timeline.map((entry) => (
                  <li key={entry.year}>
                    <button
                      type="button"
                      onClick={() => {
                        const first = entry.claimIds[0];
                        if (first !== undefined) {
                          selectConcept(first);
                        }
                      }}
                      data-testid={`wiki-timeline-${entry.year}`}
                      title="跳到这一年的第一条主张"
                      className="rounded-control border border-line px-2 py-1 text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)]"
                    >
                      <span className="font-mono text-ink">{entry.year}</span>{' '}
                      <span className="text-muted">{entry.claimIds.length} 条主张</span>
                    </button>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {projection.orphanEvidence.length === 0 ? null : (
            <section>
              <h3 className="mb-1 text-muted text-[var(--font-micro-size)]">
                未归类证据（{projection.orphanEvidence.length}）
              </h3>
              <p className="mb-1 text-subtle text-[var(--font-micro-size)]">
                这些证据还没有被任何主张引用；它们在图谱里是独立节点。
              </p>
              <ul className="flex flex-col gap-1" data-testid="wiki-orphan-evidence">
                {projection.orphanEvidence.map((card) => (
                  <li key={card.id} className="truncate text-[var(--font-micro-size)]">
                    <span className="text-ink">{card.title}</span>
                    <span className="ml-1.5 font-mono text-subtle">{card.locator}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>

        <div className="min-h-0 flex-1 overflow-y-auto p-3" data-testid="wiki-body">
          {selected === null ? (
            <EmptyState
              icon={Layers}
              title="没有可显示的概念"
              description="当前筛选下没有匹配的概念页；清空搜索或换一个关键词。"
              testId="wiki-detail-empty"
            />
          ) : (
            <article
              key={selected.claimId}
              className="rounded-card border border-line bg-surface px-3 py-2.5"
              data-testid={`wiki-page-${selected.claimId}`}
            >
              <header className="flex items-start gap-2">
                <h4 className="min-w-0 flex-1 text-ink" data-testid={`wiki-page-title-${selected.claimId}`}>
                  {selected.title}
                </h4>
                <span className={`shrink-0 text-[var(--font-micro-size)] ${STATUS_CLASS[selected.status]}`}>
                  {STATUS_LABELS[selected.status]}
                </span>
                <button
                  type="button"
                  onClick={() => copy.copy(pageAsMarkdown(selected))}
                  title="复制这一页为 Markdown"
                  data-testid="wiki-copy-markdown"
                  className="flex h-[var(--control-height-compact)] shrink-0 items-center gap-1 rounded-control border border-line px-2 text-ink text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)]"
                >
                  {copy.copied ? <Check size={11} aria-hidden="true" /> : <ClipboardCopy size={11} aria-hidden="true" />}
                  {copy.copied ? '已复制' : '复制'}
                </button>
              </header>

              <p
                className="mt-1.5 whitespace-pre-wrap text-ink text-[var(--font-read-size)] leading-[1.7]"
                data-testid={`wiki-page-content-${selected.claimId}`}
              >
                {selected.content}
              </p>

              {selected.evidence.length === 0 ? (
                <p className="mt-2 text-subtle text-[var(--font-micro-size)]" data-testid={`wiki-page-no-evidence-${selected.claimId}`}>
                  这条主张还没有引用任何证据。
                </p>
              ) : (
                <ul className="mt-2 flex flex-col gap-1.5" data-testid={`wiki-page-evidence-${selected.claimId}`}>
                  {selected.evidence.map((card) => (
                    <li key={card.id} className="rounded-card border border-line-soft bg-bg-soft px-2.5 py-1.5">
                      <p className="text-ink text-[var(--font-meta-size)]">{card.title}</p>
                      <p className="line-clamp-3 text-muted text-[var(--font-micro-size)]">{card.excerpt}</p>
                      <p className="font-mono text-subtle text-[var(--font-micro-size)]">
                        {card.sourceType} · {card.locator}
                      </p>
                    </li>
                  ))}
                </ul>
              )}

              {selected.hasMissingEvidence ? (
                <p className="mt-1.5 text-[var(--st-warn)] text-[var(--font-micro-size)]" data-testid={`wiki-page-missing-${selected.claimId}`}>
                  这条主张引用了当前加载范围之外的证据（未加载的就显示为缺失，不会补造内容）。
                </p>
              ) : null}

              <footer className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-line-soft pt-2">
                {selected.papers.map((paper) =>
                  onOpenPaper === undefined ? (
                    <span
                      key={paper.libraryItemId}
                      className="rounded-control border border-line px-1.5 text-muted text-[var(--font-micro-size)]"
                      data-testid={`wiki-page-paper-${paper.libraryItemId}`}
                    >
                      {paper.title}
                      {paper.year === null ? '' : ` · ${paper.year}`}
                    </span>
                  ) : (
                    <button
                      key={paper.libraryItemId}
                      type="button"
                      onClick={() => onOpenPaper(paper.libraryItemId)}
                      title="在阅读器里打开这条文献"
                      data-testid={`wiki-page-paper-${paper.libraryItemId}`}
                      className="flex h-[var(--control-height-compact)] items-center gap-1 rounded-control border border-line px-2 text-ink text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]"
                    >
                      {paper.title}
                      {paper.year === null ? '' : ` · ${paper.year}`}
                    </button>
                  )
                )}
                <span className="ml-auto flex items-center gap-1.5">
                  {onAskAssistant === undefined ? null : (
                    <button
                      type="button"
                      onClick={() => onAskAssistant(`请在对话中分析知识库概念：${selected.title}`)}
                      data-testid="wiki-ask-assistant"
                      className="flex h-[var(--control-height-compact)] items-center gap-1 rounded-control border border-line px-2 text-ink text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]"
                    >
                      <Bot size={11} aria-hidden="true" className="text-[var(--icon-agent)]" />
                      问助手
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onOpenClaim(selected.claimId)}
                    data-testid={`wiki-page-graph-${selected.claimId}`}
                    className="flex h-[var(--control-height-compact)] items-center gap-1 rounded-control border border-line px-2 text-ink text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]"
                  >
                    <Link2 size={10} aria-hidden="true" />
                    在图谱里看关系
                  </button>
                </span>
              </footer>

              <p className="mt-1.5 text-subtle text-[var(--font-micro-size)]">
                来源：当前文献、主张与关联证据
              </p>
            </article>
          )}
        </div>
      </div>
    </div>
  );
}

function conceptLabelFor(projection: ReturnType<typeof deriveWiki>, claimId: string): string {
  return projection.pages.find((page) => page.claimId === claimId)?.title ?? claimId;
}
