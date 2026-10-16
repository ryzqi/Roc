import { useMemo } from 'react';
import { BookMarked, CalendarClock, Layers, Link2 } from 'lucide-react';
import type { ResearchClaim, ResearchEvidence, ResearchLibraryItem } from '../../shared/types';
import { EmptyState } from '../shell/EmptyState';
import { deriveWiki } from './derive-wiki';

/**
 * LLM Wiki projection view (P5/T5.6, ADR-M10).
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
 */

export type WikiViewProps = {
  claims: readonly ResearchClaim[];
  evidence: readonly ResearchEvidence[];
  libraryItems: readonly ResearchLibraryItem[];
  /** Jump to the graph focused on this claim. */
  onOpenClaim: (claimId: string) => void;
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

export function WikiView({ claims, evidence, libraryItems, onOpenClaim }: WikiViewProps): React.JSX.Element {
  const projection = useMemo(
    () => deriveWiki({ claims, evidence, libraryItems }),
    [claims, evidence, libraryItems]
  );

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

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="wiki-view">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-[var(--font-micro-size)]">
        <span className="text-muted" data-testid="wiki-counts">
          {projection.pages.length} 个概念 · {projection.backlinks.length} 条共现 · {projection.timeline.length} 个年份
        </span>
        <span className="text-subtle">
          概念 = 一条主张 + 它引用的证据（后端没有概念表，这里是纯派生投影）
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3" data-testid="wiki-body">
        {projection.timeline.length === 0 ? null : (
          <section className="mb-4">
            <h3 className="mb-1.5 flex items-center gap-1.5 text-muted text-[var(--font-meta-size)]">
              <CalendarClock size={12} aria-hidden="true" />
              演进时间线（只使用文献真实的年份）
            </h3>
            <ol className="flex flex-wrap items-center gap-1.5" data-testid="wiki-timeline">
              {projection.timeline.map((entry) => (
                <li
                  key={entry.year}
                  className="rounded-control border border-line px-2 py-1 text-[var(--font-micro-size)]"
                  data-testid={`wiki-timeline-${entry.year}`}
                >
                  <span className="font-mono text-ink">{entry.year}</span>{' '}
                  <span className="text-muted">{entry.claimIds.length} 条主张</span>
                </li>
              ))}
            </ol>
          </section>
        )}

        <section className="flex flex-col gap-2" aria-label="概念页">
          <h3 className="flex items-center gap-1.5 text-muted text-[var(--font-meta-size)]">
            <Layers size={12} aria-hidden="true" />
            概念页
          </h3>
          {projection.pages.map((page) => (
            <article
              key={page.claimId}
              className="rounded-card border border-line bg-surface px-3 py-2"
              data-testid={`wiki-page-${page.claimId}`}
            >
              <header className="flex items-start gap-2">
                <h4 className="min-w-0 flex-1 text-ink" data-testid={`wiki-page-title-${page.claimId}`}>
                  {page.title}
                </h4>
                <span className={`shrink-0 text-[var(--font-micro-size)] ${STATUS_CLASS[page.status]}`}>
                  {STATUS_LABELS[page.status]}
                </span>
              </header>
              <p className="mt-1 whitespace-pre-wrap text-ink text-[var(--font-meta-size)]" data-testid={`wiki-page-content-${page.claimId}`}>
                {page.content}
              </p>

              {page.evidence.length === 0 ? (
                <p className="mt-1.5 text-subtle text-[var(--font-micro-size)]" data-testid={`wiki-page-no-evidence-${page.claimId}`}>
                  这条主张还没有引用任何证据。
                </p>
              ) : (
                <ul className="mt-1.5 flex flex-col gap-1" data-testid={`wiki-page-evidence-${page.claimId}`}>
                  {page.evidence.map((card) => (
                    <li key={card.id} className="rounded-control border border-line-soft px-2 py-1">
                      <p className="text-ink text-[var(--font-meta-size)]">{card.title}</p>
                      <p className="line-clamp-2 text-muted text-[var(--font-micro-size)]">{card.excerpt}</p>
                      <p className="font-mono text-subtle text-[var(--font-micro-size)]">
                        {card.sourceType} · {card.locator}
                      </p>
                    </li>
                  ))}
                </ul>
              )}

              {page.hasMissingEvidence ? (
                <p className="mt-1.5 text-[var(--st-warn)] text-[var(--font-micro-size)]" data-testid={`wiki-page-missing-${page.claimId}`}>
                  这条主张引用了当前加载范围之外的证据（未加载的就显示为缺失，不会补造内容）。
                </p>
              ) : null}

              <footer className="mt-2 flex flex-wrap items-center gap-2">
                {page.papers.map((paper) => (
                  <span
                    key={paper.libraryItemId}
                    className="rounded-control border border-line px-1.5 text-muted text-[var(--font-micro-size)]"
                    data-testid={`wiki-page-paper-${paper.libraryItemId}`}
                  >
                    {paper.title}
                    {paper.year === null ? '' : ` · ${paper.year}`}
                  </span>
                ))}
                <button
                  type="button"
                  onClick={() => onOpenClaim(page.claimId)}
                  data-testid={`wiki-page-graph-${page.claimId}`}
                  className="ml-auto flex h-[var(--control-height-compact)] items-center gap-1 rounded-control border border-line px-2 text-ink text-[var(--font-micro-size)] hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]"
                >
                  <Link2 size={10} aria-hidden="true" />
                  在图谱里看关系
                </button>
              </footer>
              <p className="mt-1 text-subtle text-[var(--font-micro-size)]">
                来源：research.claims.list · research.evidence.list · research.library.list
              </p>
            </article>
          ))}
        </section>

        {projection.backlinks.length === 0 ? null : (
          <section className="mt-4">
            <h3 className="mb-1.5 text-muted text-[var(--font-meta-size)]">共现（共享证据的主张）</h3>
            <ul className="flex flex-col gap-1" data-testid="wiki-backlinks">
              {projection.backlinks.map((link) => (
                <li key={`${link.fromClaimId}:${link.toClaimId}`} className="text-[var(--font-meta-size)]">
                  <span className="text-ink">{conceptLabelFor(projection, link.fromClaimId)}</span>
                  <span className="mx-1 text-subtle">↔</span>
                  <span className="text-ink">{conceptLabelFor(projection, link.toClaimId)}</span>
                  <span className="ml-1.5 text-subtle text-[var(--font-micro-size)]">
                    共享 {link.sharedEvidenceIds.length} 条证据
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {projection.orphanEvidence.length === 0 ? null : (
          <section className="mt-4">
            <h3 className="mb-1.5 text-muted text-[var(--font-meta-size)]">
              未归类证据（{projection.orphanEvidence.length}）
            </h3>
            <p className="mb-1.5 text-subtle text-[var(--font-micro-size)]">
              这些证据还没有被任何主张引用；它们在图谱里是独立节点。
            </p>
            <ul className="flex flex-col gap-1" data-testid="wiki-orphan-evidence">
              {projection.orphanEvidence.map((card) => (
                <li key={card.id} className="truncate text-[var(--font-meta-size)]">
                  <span className="text-ink">{card.title}</span>
                  <span className="ml-1.5 font-mono text-subtle text-[var(--font-micro-size)]">{card.locator}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

function conceptLabelFor(projection: ReturnType<typeof deriveWiki>, claimId: string): string {
  return projection.pages.find((page) => page.claimId === claimId)?.title ?? claimId;
}
