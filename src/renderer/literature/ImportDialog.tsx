import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, FileText, Loader2, Search, TriangleAlert } from 'lucide-react';
import type { ResearchBibliographyFormat, ResearchLiterature } from '../../shared/types';
import { ModalShell } from '../shell/ModalShell';
import type { ImportTabRequest } from './hub-route';
import type { LiteratureSearchSource } from './library-store';
import type { LiteratureImportOutcome } from './use-literature-store';
import {
  DOCUMENT_EXTENSIONS,
  arxivQueryFromInput,
  buildManualRecord,
  deriveCitationKey,
  documentKindLabel,
  isCitationKeyValid,
  isDocumentPathSupported,
  literatureRecordFromSearchHit,
  normalizeDoi,
  parseAuthorsInput,
  parseYearInput
} from './format';

/**
 * Import dialog (P5/T5.2).
 *
 * Four paths, each mapping to exactly one backend capability — no path invents a
 * step that does not exist:
 *
 *   | tab      | capability                            | notes |
 *   |----------|---------------------------------------|-------|
 *   | 文档      | `files.selectFromDialog` → `research.document.import` | needs a title + citation key for `target:'new-item'`, or attaches to the selected item |
 *   | DOI      | `research.library.importDoi`          | DOI is normalized locally first |
 *   | 参考文献   | `files.selectFromDialog` → `research.library.importFile` | **no RIS** — the contract's formats are bibtex/biblatex/csl-json |
 *   | 手工录入   | `research.library.importRecord`       | the record is built by a pure helper; the *random arXiv id* of the legacy form is gone |
 *   | 检索      | `research.literature.search` → `importRecord` | arXiv ids go through the same search path |
 *
 * Deliberately absent: the legacy form's MinerU mode and formula/table switches.
 * Those are settings (ADR-M09), and the parse step reads them from the settings
 * centre; a dialog-local copy would be a second source of truth.
 */

export type ImportDialogProps = {
  open: boolean;
  /** Which tab to show first; defaults to 文档. */
  initialTab?: ImportTabRequest;
  onClose: () => void;
  /** Present when the user has a library item selected (enables "attach to it"). */
  selectedItem: { id: string; title: string } | null;
  canAttachToSelection: boolean;
  importDoi: (doi: string) => Promise<LiteratureImportOutcome>;
  importBibliographyFile: (sourcePath: string, format: ResearchBibliographyFormat) => Promise<LiteratureImportOutcome>;
  importRecord: (record: ResearchLiterature, citationKey: string) => Promise<LiteratureImportOutcome>;
  pickFile: () => Promise<string | null>;
  searchLiterature: (
    query: string,
    sources: LiteratureSearchSource[],
    limit: number
  ) => Promise<{ ok: true; hits: ResearchLiterature[] } | { ok: false; message: string }>;
  addDocumentToNewItem: (input: {
    sourcePath: string;
    title: string;
    citationKey: string;
  }) => Promise<LiteratureImportOutcome>;
  addDocumentToItem: (input: { sourcePath: string; libraryItemId: string }) => Promise<LiteratureImportOutcome>;
};



const TABS: Array<{ id: ImportTabRequest; label: string }> = [
  { id: 'document', label: '文档' },
  { id: 'doi', label: 'DOI' },
  { id: 'bibliography', label: '参考文献文件' },
  { id: 'manual', label: '手工录入' },
  { id: 'search', label: '检索' }
];

const BIBLIOGRAPHY_FORMATS: Array<{ id: ResearchBibliographyFormat; label: string }> = [
  { id: 'bibtex', label: 'BibTeX' },
  { id: 'biblatex', label: 'BibLaTeX' },
  { id: 'csl-json', label: 'CSL-JSON' }
];

/** Every literature source except `doi`, which is a DOI resolver rather than a search source. */
const SEARCH_SOURCES: LiteratureSearchSource[] = [
  'openalex',
  'crossref',
  'semantic_scholar',
  'arxiv',
  'pubmed',
  'europe_pmc'
];

const fieldClass =
  'h-[var(--control-height)] w-full rounded-control border border-line bg-surface px-2 text-ink text-[var(--font-meta-size)] placeholder:text-subtle';
const labelClass = 'text-muted text-[var(--font-micro-size)]';

function outcomeMessage(outcome: LiteratureImportOutcome): { tone: 'ok' | 'bad'; text: string } {
  if (!outcome.ok) {
    return { tone: 'bad', text: outcome.message };
  }
  if (outcome.duplicateCount > 0 && outcome.createdCount === 0) {
    return { tone: 'ok', text: `已存在，未新增（重复 ${outcome.duplicateCount} 条）` };
  }
  return {
    tone: 'ok',
    text: `已导入 ${outcome.createdCount} 条${outcome.duplicateCount > 0 ? `，跳过重复 ${outcome.duplicateCount} 条` : ''}`
  };
}

export function ImportDialog(props: ImportDialogProps): React.JSX.Element | null {
  const { open, onClose } = props;
  const [tab, setTab] = useState<ImportTabRequest>(props.initialTab ?? 'document');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  // Document tab
  const [documentPath, setDocumentPath] = useState<string | null>(null);
  const [documentTarget, setDocumentTarget] = useState<'new-item' | 'library-item'>('new-item');
  const [documentTitle, setDocumentTitle] = useState('');
  const [documentKey, setDocumentKey] = useState('');

  // DOI tab
  const [doiInput, setDoiInput] = useState('');

  // Bibliography tab
  const [bibliographyFormat, setBibliographyFormat] = useState<ResearchBibliographyFormat>('bibtex');
  const [bibliographyPath, setBibliographyPath] = useState<string | null>(null);

  // Manual tab
  const [manualTitle, setManualTitle] = useState('');
  const [manualAuthors, setManualAuthors] = useState('');
  const [manualYear, setManualYear] = useState('');
  const [manualDoi, setManualDoi] = useState('');
  const [manualUrl, setManualUrl] = useState('');
  const [manualAbstract, setManualAbstract] = useState('');
  const [manualKey, setManualKey] = useState('');

  // Search tab
  const [searchQuery, setSearchQuery] = useState('');
  const [searchHits, setSearchHits] = useState<ResearchLiterature[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);

  const titleRef = useRef<HTMLInputElement>(null);
  const initialTab = props.initialTab ?? 'document';

  // Every tab starts clean: a leftover path or message from the previous opening
  // would look like it belonged to the new import.
  useEffect(() => {
    if (!open) {
      return;
    }
    setMessage(null);
    setDocumentPath(null);
    setDocumentTitle('');
    setDocumentKey('');
    setDoiInput('');
    setBibliographyPath(null);
    setManualTitle('');
    setManualAuthors('');
    setManualYear('');
    setManualDoi('');
    setManualUrl('');
    setManualAbstract('');
    setManualKey('');
    setSearchQuery('');
    setSearchHits([]);
    setSearchError(null);
    setTab(initialTab);
    setDocumentTarget(props.selectedItem === null ? 'new-item' : 'library-item');
  }, [initialTab, open, props.selectedItem]);

  const manualAuthorsParsed = useMemo(() => parseAuthorsInput(manualAuthors), [manualAuthors]);
  const manualYearParsed = useMemo(() => parseYearInput(manualYear), [manualYear]);
  const manualDerivedKey = useMemo(
    () => deriveCitationKey({ title: manualTitle, authors: manualAuthorsParsed, year: manualYearParsed }),
    [manualTitle, manualAuthorsParsed, manualYearParsed]
  );
  const effectiveManualKey = manualKey.trim().length > 0 ? manualKey.trim() : (manualDerivedKey ?? '');
  const documentDerivedKey = useMemo(
    () => deriveCitationKey({ title: documentTitle, authors: [], year: null }),
    [documentTitle]
  );

  const normalizedDoi = useMemo(() => normalizeDoi(doiInput), [doiInput]);
  const arxivId = useMemo(() => arxivQueryFromInput(searchQuery), [searchQuery]);

  const run = async (action: () => Promise<LiteratureImportOutcome>): Promise<void> => {
    setPending(true);
    setMessage(null);
    try {
      const outcome = await action();
      setMessage(outcomeMessage(outcome));
    } finally {
      setPending(false);
    }
  };

  const pick = async (assign: (path: string) => void): Promise<void> => {
    const path = await props.pickFile();
    if (path !== null) {
      assign(path);
    }
  };

  const documentReady =
    documentPath !== null &&
    isDocumentPathSupported(documentPath) &&
    (documentTarget === 'library-item' ? props.selectedItem !== null : documentTitle.trim().length > 0 && isCitationKeyValid(documentKey.trim()));

  const manualReady = manualTitle.trim().length > 0 && isCitationKeyValid(effectiveManualKey);

  return (
    <ModalShell
      open={open}
      title="导入文献"
      onClose={onClose}
      testId="literature-import-dialog"
      widthClassName="max-w-2xl"
      footer={
        <span className={labelClass} data-testid="literature-import-hint">
          解析（MinerU）模式与公式/表格开关在设置中心，不在这里（ADR-M09）。
        </span>
      }
    >
      <div className="flex flex-col gap-3" data-testid="literature-import-body">
        <div role="tablist" aria-label="导入方式" className="flex flex-wrap items-center gap-1">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={entry.id === tab}
              tabIndex={entry.id === tab ? 0 : -1}
              onClick={() => {
                setTab(entry.id);
                setMessage(null);
              }}
              data-testid={`literature-import-tab-${entry.id}`}
              className={
                entry.id === tab
                  ? 'h-[var(--control-height-compact)] rounded-control border border-line bg-accent-soft px-2.5 text-ink text-[var(--font-meta-size)]'
                  : 'h-[var(--control-height-compact)] rounded-control border border-transparent px-2.5 text-muted text-[var(--font-meta-size)] hover:bg-[var(--overlay-hover)] hover:text-ink'
              }
            >
              {entry.label}
            </button>
          ))}
        </div>

        {tab === 'document' ? (
          <div className="flex flex-col gap-2" data-testid="literature-import-panel-document">
            <div className="flex flex-wrap gap-3">
              <label className="flex items-center gap-1.5 text-[var(--font-meta-size)]">
                <input
                  type="radio"
                  name="document-target"
                  checked={documentTarget === 'new-item'}
                  onChange={() => setDocumentTarget('new-item')}
                  data-testid="literature-import-target-new"
                />
                作为新条目
              </label>
              <label className="flex items-center gap-1.5 text-[var(--font-meta-size)]">
                <input
                  type="radio"
                  name="document-target"
                  checked={documentTarget === 'library-item'}
                  disabled={props.selectedItem === null}
                  onChange={() => setDocumentTarget('library-item')}
                  data-testid="literature-import-target-existing"
                />
                附加到{props.selectedItem === null ? '（先在列表里选一条）' : `「${props.selectedItem.title}」`}
              </label>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void pick(setDocumentPath)}
                data-testid="literature-import-pick-document"
                className="h-[var(--control-height)] shrink-0 rounded-control border border-line px-3 text-ink text-[var(--font-meta-size)] hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]"
              >
                选择文件…
              </button>
              <span className="min-w-0 flex-1 truncate font-mono text-muted text-[var(--font-micro-size)]" data-testid="literature-import-document-path">
                {documentPath === null ? '未选择' : `${documentPath}（${documentKindLabel(documentPath)}）`}
              </span>
            </div>
            <p className={labelClass}>
              后端接受 {DOCUMENT_EXTENSIONS.join(' / ')}；单文件上限 512 MB。
            </p>
            {documentTarget === 'new-item' ? (
              <>
                <label className={labelClass} htmlFor="literature-import-document-title">
                  题名（必填）
                </label>
                <input
                  id="literature-import-document-title"
                  ref={titleRef}
                  value={documentTitle}
                  onChange={(event) => {
                    setDocumentTitle(event.target.value);
                    setDocumentKey(deriveCitationKey({ title: event.target.value, authors: [], year: null }) ?? '');
                  }}
                  className={fieldClass}
                  data-testid="literature-import-document-title"
                />
                <label className={labelClass} htmlFor="literature-import-document-key">
                  引用 key（必填，字母数字，不含空格与 ,{'{'}{'}'}\%#&quot;）
                </label>
                <input
                  id="literature-import-document-key"
                  value={documentKey}
                  onChange={(event) => setDocumentKey(event.target.value)}
                  className={fieldClass}
                  data-testid="literature-import-document-key"
                />
                {documentKey.trim().length > 0 && !isCitationKeyValid(documentKey.trim()) ? (
                  <p role="alert" className="text-[var(--st-bad)] text-[var(--font-micro-size)]">
                    这个 key 不符合后端规则，导入会被拒绝。
                  </p>
                ) : null}
                {documentDerivedKey === null && documentKey.trim().length === 0 && documentTitle.trim().length > 0 ? (
                  <p className="text-muted text-[var(--font-micro-size)]">题名里没有可用的词，请自己指定一个 key。</p>
                ) : null}
              </>
            ) : null}
            <button
              type="button"
              disabled={!documentReady || pending}
              onClick={() => {
                const path = documentPath;
                if (path === null) {
                  return;
                }
                void run(async () => {
                  if (documentTarget === 'library-item' && props.selectedItem !== null) {
                    return await props.addDocumentToItem({ sourcePath: path, libraryItemId: props.selectedItem.id });
                  }
                  return await props.addDocumentToNewItem({
                    sourcePath: path,
                    title: documentTitle.trim(),
                    citationKey: documentKey.trim()
                  });
                });
              }}
              data-testid="literature-import-document-submit"
              className="mt-1 h-[var(--control-height)] shrink-0 self-start rounded-control bg-accent-soft px-3 text-ink text-[var(--font-meta-size)] active:bg-[var(--accent-soft-strong)] disabled:opacity-40"
            >
              导入文档
            </button>
          </div>
        ) : null}

        {tab === 'doi' ? (
          <div className="flex flex-col gap-2" data-testid="literature-import-panel-doi">
            <label className={labelClass} htmlFor="literature-import-doi">
              DOI（可粘贴 https://doi.org/… 或 doi:…）
            </label>
            <input
              id="literature-import-doi"
              value={doiInput}
              onChange={(event) => setDoiInput(event.target.value)}
              placeholder="10.1038/nature12373"
              className={fieldClass}
              data-testid="literature-import-doi"
            />
            {doiInput.trim().length > 0 && normalizedDoi === null ? (
              <p role="alert" className="text-[var(--st-bad)] text-[var(--font-micro-size)]">
                这不是一个 DOI（形如 10.xxxx/yyyy）。
              </p>
            ) : null}
            <button
              type="button"
              disabled={normalizedDoi === null || pending}
              onClick={() => {
                if (normalizedDoi === null) {
                  return;
                }
                void run(() => props.importDoi(normalizedDoi));
              }}
              data-testid="literature-import-doi-submit"
              className="mt-1 h-[var(--control-height)] self-start rounded-control bg-accent-soft px-3 text-ink text-[var(--font-meta-size)] active:bg-[var(--accent-soft-strong)] disabled:opacity-40"
            >
              从 DOI 导入
            </button>
          </div>
        ) : null}

        {tab === 'bibliography' ? (
          <div className="flex flex-col gap-2" data-testid="literature-import-panel-bibliography">
            <span className={labelClass}>格式（后端只支持这三种；RIS 无接口）</span>
            <div className="flex flex-wrap gap-1.5">
              {BIBLIOGRAPHY_FORMATS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => setBibliographyFormat(entry.id)}
                  aria-pressed={entry.id === bibliographyFormat}
                  data-testid={`literature-import-format-${entry.id}`}
                  className={
                    entry.id === bibliographyFormat
                      ? 'h-[var(--control-height-compact)] rounded-control border border-line bg-accent-soft px-2.5 text-ink text-[var(--font-meta-size)]'
                      : 'h-[var(--control-height-compact)] rounded-control border border-line px-2.5 text-muted text-[var(--font-meta-size)] hover:bg-[var(--overlay-hover)]'
                  }
                >
                  {entry.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void pick(setBibliographyPath)}
                data-testid="literature-import-pick-bibliography"
                className="h-[var(--control-height)] shrink-0 rounded-control border border-line px-3 text-ink text-[var(--font-meta-size)] hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]"
              >
                选择文件…
              </button>
              <span className="min-w-0 flex-1 truncate font-mono text-muted text-[var(--font-micro-size)]" data-testid="literature-import-bibliography-path">
                {bibliographyPath ?? '未选择'}
              </span>
            </div>
            <button
              type="button"
              disabled={bibliographyPath === null || pending}
              onClick={() => {
                const path = bibliographyPath;
                if (path === null) {
                  return;
                }
                void run(() => props.importBibliographyFile(path, bibliographyFormat));
              }}
              data-testid="literature-import-bibliography-submit"
              className="mt-1 h-[var(--control-height)] self-start rounded-control bg-accent-soft px-3 text-ink text-[var(--font-meta-size)] active:bg-[var(--accent-soft-strong)] disabled:opacity-40"
            >
              导入参考文献
            </button>
          </div>
        ) : null}

        {tab === 'manual' ? (
          <div className="flex flex-col gap-2" data-testid="literature-import-panel-manual">
            <label className={labelClass} htmlFor="literature-import-manual-title">
              题名（必填）
            </label>
            <input
              id="literature-import-manual-title"
              value={manualTitle}
              onChange={(event) => setManualTitle(event.target.value)}
              className={fieldClass}
              data-testid="literature-import-manual-title"
            />
            <label className={labelClass} htmlFor="literature-import-manual-authors">
              作者（换行、分号或 and 分隔；逗号属于姓名本身，不拆分）
            </label>
            <textarea
              id="literature-import-manual-authors"
              value={manualAuthors}
              onChange={(event) => setManualAuthors(event.target.value)}
              rows={2}
              className="w-full rounded-control border border-line bg-surface px-2 py-1 text-ink text-[var(--font-meta-size)]"
              data-testid="literature-import-manual-authors"
            />
            <div className="flex gap-2">
              <div className="flex w-24 flex-col gap-1">
                <label className={labelClass} htmlFor="literature-import-manual-year">
                  年份
                </label>
                <input
                  id="literature-import-manual-year"
                  value={manualYear}
                  onChange={(event) => setManualYear(event.target.value)}
                  inputMode="numeric"
                  className={fieldClass}
                  data-testid="literature-import-manual-year"
                />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <label className={labelClass} htmlFor="literature-import-manual-doi">
                  DOI
                </label>
                <input
                  id="literature-import-manual-doi"
                  value={manualDoi}
                  onChange={(event) => setManualDoi(event.target.value)}
                  className={fieldClass}
                  data-testid="literature-import-manual-doi"
                />
              </div>
            </div>
            <label className={labelClass} htmlFor="literature-import-manual-url">
              链接
            </label>
            <input
              id="literature-import-manual-url"
              value={manualUrl}
              onChange={(event) => setManualUrl(event.target.value)}
              className={fieldClass}
              data-testid="literature-import-manual-url"
            />
            <label className={labelClass} htmlFor="literature-import-manual-abstract">
              摘要
            </label>
            <textarea
              id="literature-import-manual-abstract"
              value={manualAbstract}
              onChange={(event) => setManualAbstract(event.target.value)}
              rows={3}
              className="w-full rounded-control border border-line bg-surface px-2 py-1 text-ink text-[var(--font-meta-size)]"
              data-testid="literature-import-manual-abstract"
            />
            <label className={labelClass} htmlFor="literature-import-manual-key">
              引用 key（必填；留空则用推导值）
            </label>
            <input
              id="literature-import-manual-key"
              value={manualKey}
              onChange={(event) => setManualKey(event.target.value)}
              placeholder={manualDerivedKey ?? '请自己指定一个'}
              className={fieldClass}
              data-testid="literature-import-manual-key"
            />
            {effectiveManualKey.length > 0 && !isCitationKeyValid(effectiveManualKey) ? (
              <p role="alert" className="text-[var(--st-bad)] text-[var(--font-micro-size)]">
                这个 key 不符合后端规则，导入会被拒绝。
              </p>
            ) : null}
            <button
              type="button"
              disabled={!manualReady || pending}
              onClick={() => {
                const year = manualYearParsed;
                const doi = manualDoi.trim().length === 0 ? null : normalizeDoi(manualDoi);
                void run(() =>
                  props.importRecord(
                    buildManualRecord({
                      title: manualTitle,
                      authors: manualAuthorsParsed,
                      year,
                      doi,
                      url: manualUrl.trim().length === 0 ? null : manualUrl.trim(),
                      abstract: manualAbstract.trim().length === 0 ? null : manualAbstract.trim(),
                      citationKey: effectiveManualKey,
                      now: new Date().toISOString()
                    }),
                    effectiveManualKey
                  )
                );
              }}
              data-testid="literature-import-manual-submit"
              className="mt-1 h-[var(--control-height)] self-start rounded-control bg-accent-soft px-3 text-ink text-[var(--font-meta-size)] active:bg-[var(--accent-soft-strong)] disabled:opacity-40"
            >
              录入
            </button>
          </div>
        ) : null}

        {tab === 'search' ? (
          <div className="flex flex-col gap-2" data-testid="literature-import-panel-search">
            <label className={labelClass} htmlFor="literature-import-search">
              检索（arXiv 可直接粘贴 id 或 abs/pdf 链接）
            </label>
            <div className="flex gap-2">
              <input
                id="literature-import-search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                className={fieldClass}
                data-testid="literature-import-search"
              />
              <button
                type="button"
                disabled={searchQuery.trim().length === 0 || pending}
                onClick={() => {
                  const query = arxivId ?? searchQuery.trim();
                  const sources: LiteratureSearchSource[] = arxivId === null ? SEARCH_SOURCES : ['arxiv'];
                  setPending(true);
                  setSearchError(null);
                  void props
                    .searchLiterature(query, sources, 10)
                    .then((result) => {
                      if (result.ok) {
                        setSearchHits(result.hits);
                        return;
                      }
                      setSearchHits([]);
                      setSearchError(result.message);
                    })
                    .finally(() => setPending(false));
                }}
                data-testid="literature-import-search-submit"
                className="flex h-[var(--control-height)] shrink-0 items-center gap-1 rounded-control border border-line px-3 text-ink text-[var(--font-meta-size)] hover:bg-[var(--overlay-hover)] disabled:opacity-40"
              >
                <Search size={12} aria-hidden="true" />
                检索
              </button>
            </div>
            {arxivId === null ? null : (
              <p className="text-muted text-[var(--font-micro-size)]">
                识别为 arXiv id <span className="font-mono">{arxivId}</span>，只在 arXiv 上检索。
              </p>
            )}
            {searchError === null ? null : (
              <p role="alert" className="text-[var(--st-bad)] text-[var(--font-micro-size)]">
                {searchError}
              </p>
            )}
            {searchHits.length === 0 ? null : (
              <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto" aria-label="检索结果">
                {searchHits.map((hit) => {
                  const key = deriveCitationKey({ title: hit.title, authors: hit.authors, year: hit.publishedYear });
                  return (
                    <li key={`${hit.source}:${hit.id}`} className="flex items-start gap-2 rounded-control border border-line px-2 py-1.5">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-ink text-[var(--font-meta-size)]">{hit.title}</span>
                        <span className="block truncate text-muted text-[var(--font-micro-size)]">
                          {hit.source} · {hit.publishedYear ?? '—'} · {hit.authors.slice(0, 2).join(' · ')}
                        </span>
                      </span>
                      <button
                        type="button"
                        disabled={pending || key === null}
                        title={key === null ? '题名里没有可用的词，请用「手工录入」指定 key' : `导入为 ${key}`}
                        onClick={() => {
                          if (key === null) {
                            return;
                          }
                          void run(() => props.importRecord(literatureRecordFromSearchHit(hit), key));
                        }}
                        data-testid={`literature-import-hit-${hit.id}`}
                        className="h-[var(--control-height-compact)] shrink-0 rounded-control border border-line px-2 text-ink text-[var(--font-meta-size)] hover:bg-[var(--overlay-hover)] disabled:opacity-40"
                      >
                        导入
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}

        {pending ? (
          <p role="status" className="flex items-center gap-1.5 text-muted text-[var(--font-micro-size)]" data-testid="literature-import-pending">
            <Loader2 size={12} aria-hidden="true" className="animate-spin" />
            正在导入…
          </p>
        ) : null}

        {message === null ? null : (
          <p
            role={message.tone === 'ok' ? 'status' : 'alert'}
            data-testid="literature-import-message"
            className={`flex items-center gap-1.5 text-[var(--font-meta-size)] ${
              message.tone === 'ok' ? 'text-[var(--st-ok)]' : 'text-[var(--st-bad)]'
            }`}
          >
            {message.tone === 'ok' ? <CheckCircle2 size={12} aria-hidden="true" /> : <TriangleAlert size={12} aria-hidden="true" />}
            {message.text}
          </p>
        )}

        <p className={labelClass}>
          <FileText size={10} aria-hidden="true" className="mr-1 inline" />
          导入的文档还需要在阅读器里点「解析」才会产生可检索内容；解析进度来自后端 run 记录。
        </p>
      </div>
    </ModalShell>
  );
}
