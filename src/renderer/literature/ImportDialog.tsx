import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, FileText, Loader2, Search, TriangleAlert } from 'lucide-react';
import type { LiteratureSearchResult, LiteratureCandidate } from '../../shared/schemas/literature-import';
import type { LiteratureImportActions } from './use-literature-import-actions';
import type { ResearchBibliographyFormat, ResearchLiterature } from '../../shared/types';
import { ModalShell } from '../shell/ModalShell';
import { ConfirmDialog } from '../shell/ConfirmDialog';
import { BEFORE_NAVIGATE, type NavigationRequest } from '../app/navigation-guard';
import { runIpcAction } from '../app/loaded-state';
import { formInputClass } from '../shared/form-ui';
import type { ImportTabRequest } from './hub-route';
import type { LiteratureSearchSource } from './library-store';
import type { LiteratureImportOutcome } from './use-literature-store';
import {LiteratureCandidateReview} from './LiteratureCandidateReview';
import {ZoteroImportPanel, type ZoteroDraftGuard} from './ZoteroImportPanel';
import {useZoteroImportJob} from './use-zotero-import-job';
import {useZoteroAttachmentJobs} from './use-zotero-attachment-jobs';
import type {RocClient} from '../shared/roc-client';
import {
  DOCUMENT_EXTENSIONS,
  arxivQueryFromInput,
  buildManualRecord,
  deriveCitationKey,
  documentKindLabel,
  isCitationKeyValid,
  isDocumentPathSupported,
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
 *   | 检索      | `research.literature.search` → `addLiterature` | 导入已保存候选 |
 *
 * Deliberately absent: the legacy form's MinerU mode and formula/table switches.
 * Those are settings, and the parse step reads them from the settings
 * centre; a dialog-local copy would be a second source of truth.
 */

export type ImportDialogProps = {
  client: RocClient;
  projectId: string | null;
  onZoteroImported: () => void;
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
  searchLiterature: LiteratureImportActions['searchLiterature'];
  addCandidate: LiteratureImportActions['addCandidate'];
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
  { id: 'search', label: '检索' },
  { id: 'zotero', label: 'Zotero' }
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

const fieldClass = `${formInputClass} text-[length:var(--font-meta-size)] placeholder:text-subtle`;
const labelClass = 'text-muted text-[length:var(--font-micro-size)]';
type LocalOperation = 'import' | 'pick' | 'search';
const operationLabels: Record<LocalOperation, string> = {
  import: '正在导入…',
  pick: '正在选择文件…',
  search: '正在检索…'
};

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
  const zoteroJob = useZoteroImportJob(props.client, props.projectId, props.onZoteroImported);
  const attachmentJobs = useZoteroAttachmentJobs(props.client, props.projectId, props.onZoteroImported);
  const [tab, setTab] = useState<ImportTabRequest>(props.initialTab ?? 'document');
  const [operation, setOperation] = useState<LocalOperation | null>(null);
  const pending = operation !== null;
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [savedDrafts, setSavedDrafts] = useState<Partial<Record<ImportTabRequest, string>>>({});
  const [discardOpen, setDiscardOpen] = useState(false);
  const [zoteroDirty, setZoteroDirty] = useState(false);
  const zoteroDraft = useRef(false);
  const pendingNavigation = useRef<(() => void) | null>(null);
  const busy = useRef<{ revision: number } | null>(null);
  const mounted = useRef(true);
  const zoteroDraftGuard = useMemo<ZoteroDraftGuard>(() => ({
    changed: value => {
      zoteroDraft.current = value;
      if (mounted.current) setZoteroDirty(value);
    },
    request: proceed => {
      if (!zoteroDraft.current) {proceed(); return;}
      pendingNavigation.current = proceed;
      setDiscardOpen(true);
    }
  }), []);
  const selectTab = (next: ImportTabRequest, focus = false): void => {
    if (busy.current !== null || next === tab) return;
    const proceed = (): void => {
      setTab(next);
      setMessage(null);
      if (focus) document.querySelector<HTMLButtonElement>(`[data-testid="literature-import-tab-${next}"]`)?.focus();
    };
    if (tab === 'zotero') zoteroDraftGuard.request(proceed);
    else proceed();
  };

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
  const [searchHits, setSearchHits] = useState<LiteratureCandidate[]>([]);
  const [searchResult, setSearchResult] = useState<LiteratureSearchResult | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  const titleRef = useRef<HTMLInputElement>(null);
  const initialTab = props.initialTab ?? 'document';
  const selectedItemId = props.selectedItem?.id ?? null;
  const sessionKey = JSON.stringify([open, initialTab, selectedItemId, props.projectId]);
  const session = useRef({ key: sessionKey, revision: 0 });
  if (session.current.key !== sessionKey) {
    session.current = { key: sessionKey, revision: session.current.revision + 1 };
    busy.current = null;
  }

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; busy.current = null; };
  }, []);

  // Reset on a new import or selection, not a refreshed object for the same item.
  useEffect(() => {
    setOperation(null);
    setDiscardOpen(false);
    pendingNavigation.current = null;
    if (!open) {
      return;
    }
    setSavedDrafts({});
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
    setSearchResult(null);
    setSearchError(null);
    setTab(initialTab);
    setDocumentTarget(selectedItemId === null ? 'new-item' : 'library-item');
  }, [initialTab, open, selectedItemId, props.projectId]);

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

  // A submitted tab becomes the baseline only after a successful import. Drafts
  // in other tabs still need a deliberate discard when the dialog closes.
  const manualFields = [manualTitle, manualAuthors, manualYear, manualDoi, manualUrl, manualAbstract, manualKey];
  const draftSignatures: Partial<Record<ImportTabRequest, string>> = {
    document: documentPath !== null || documentTitle.length > 0 || documentKey.length > 0
      ? JSON.stringify([documentPath, documentTarget, documentTitle, documentKey]) : '',
    doi: doiInput,
    bibliography: bibliographyPath === null ? '' : JSON.stringify([bibliographyPath, bibliographyFormat]),
    manual: manualFields.some(value => value.length > 0) ? JSON.stringify(manualFields) : ''
  };
  const dirty = zoteroDirty || Object.entries(draftSignatures)
    .some(([key, value]) => value !== (savedDrafts[key as ImportTabRequest] ?? ''));

  useEffect(() => {
    if (!open) return;
    const navigate = (event: Event): void => {
      if (!dirty && !zoteroDraft.current && busy.current === null) return;
      if (busy.current !== null) {
        event.preventDefault();
        setMessage({ tone: 'bad', text: '当前操作尚未完成，请稍后切换项目。' });
        return;
      }
      const proceed = (event as CustomEvent<NavigationRequest>).detail.defer();
      pendingNavigation.current = () => {onClose(); proceed();};
      setDiscardOpen(true);
    };
    const unload = (event: BeforeUnloadEvent): void => {
      if (!dirty && !zoteroDraft.current && busy.current === null) return;
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener(BEFORE_NAVIGATE, navigate);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener(BEFORE_NAVIGATE, navigate);
      window.removeEventListener('beforeunload', unload);
    };
  }, [dirty, open, onClose, pending]);

  async function perform<T>(kind: LocalOperation, action: () => Promise<T>, apply: (result: T) => void): Promise<void> {
    if (!open || busy.current !== null) return;
    const request = { revision: session.current.revision };
    busy.current = request;
    setOperation(kind);
    setMessage(null);
    const result = await runIpcAction(async () => ({ ok: true as const, data: await action() }));
    if (!mounted.current || busy.current !== request || session.current.revision !== request.revision) return;
    busy.current = null;
    setOperation(null);
    if (!result.ok) {
      if (kind === 'search') setSearchError(result.error);
      else setMessage({ tone: 'bad', text: result.error });
      return;
    }
    apply(result.data);
  }

  const run = async (action: () => Promise<LiteratureImportOutcome>): Promise<void> => {
    const submittedTab = tab, signature = draftSignatures[tab];
    await perform('import', action, outcome => {
      setMessage(outcomeMessage(outcome));
      if (outcome.ok && signature !== undefined) setSavedDrafts(current => ({ ...current, [submittedTab]: signature }));
    });
  };

  const pick = async (assign: (path: string) => void): Promise<void> => {
    await perform('pick', props.pickFile, path => { if (path !== null) assign(path); });
  };

  const documentReady =
    documentPath !== null &&
    isDocumentPathSupported(documentPath) &&
    (documentTarget === 'library-item' ? props.selectedItem !== null : documentTitle.trim().length > 0 && isCitationKeyValid(documentKey.trim()));

  const manualReady = manualTitle.trim().length > 0 && isCitationKeyValid(effectiveManualKey);

  return (
    <>
    <ModalShell
      closeOnBackdrop={false}
      open={open}
      title="导入文献"
      onClose={onClose}
      beforeClose={() => {
        if (busy.current !== null) return false;
        if (!dirty && !zoteroDraft.current) return true;
        pendingNavigation.current = null;
        setDiscardOpen(true);
        return false;
      }}
      testId="literature-import-dialog"
      widthClassName="w-[672px]"
      footer={null}
    >
      <fieldset disabled={pending} className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0" data-testid="literature-import-body">
        <div role="tablist" aria-label="导入方式" className="flex flex-wrap items-center gap-1"
          onKeyDown={event => {
            if (busy.current !== null) return;
            if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const index = TABS.findIndex(entry => entry.id === tab);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 :
              (index + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
            selectTab(TABS[next].id, true);
          }}>
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={entry.id === tab}
              tabIndex={entry.id === tab ? 0 : -1}
              onClick={() => selectTab(entry.id)}
              data-testid={`literature-import-tab-${entry.id}`}
              className={
                entry.id === tab
                  ? 'h-[var(--control-height-compact)] rounded-control border-[0.5px] border-line bg-accent-soft px-2.5 text-ink text-[length:var(--font-meta-size)]'
                  : 'h-[var(--control-height-compact)] rounded-control border-[0.5px] border-transparent px-2.5 text-muted text-[length:var(--font-meta-size)] hover:bg-[var(--overlay-hover)] hover:text-ink'
              }
            >
              {entry.label}
            </button>
          ))}
        </div>

        {tab === 'document' ? (
          <div className="flex flex-col gap-2" data-testid="literature-import-panel-document">
            <div className="flex flex-wrap gap-3">
              <label className="flex items-center gap-1.5 text-[length:var(--font-meta-size)]">
                <input
                  type="radio"
                  name="document-target"
                  checked={documentTarget === 'new-item'}
                  onChange={() => setDocumentTarget('new-item')}
                  data-testid="literature-import-target-new"
                />
                作为新条目
              </label>
              <label className="flex items-center gap-1.5 text-[length:var(--font-meta-size)]">
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
                className="h-[var(--control-height)] shrink-0 rounded-control border-[0.5px] border-line px-3 text-ink text-[length:var(--font-meta-size)] hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]"
              >
                选择文件…
              </button>
              <span className="min-w-0 flex-1 truncate font-mono text-muted text-[length:var(--font-micro-size)]" data-testid="literature-import-document-path">
                {documentPath === null ? '未选择' : `${documentPath}（${documentKindLabel(documentPath)}）`}
              </span>
            </div>
            <p className={labelClass}>
              支持 {DOCUMENT_EXTENSIONS.join(' / ')}；单文件最大 512 MB。
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
                  引用键（必填）
                </label>
                <input
                  id="literature-import-document-key"
                  value={documentKey}
                  onChange={(event) => setDocumentKey(event.target.value)}
                  className={fieldClass}
                  data-testid="literature-import-document-key"
                />
                {documentKey.trim().length > 0 && !isCitationKeyValid(documentKey.trim()) ? (
                  <p role="alert" className="text-[var(--st-bad)] text-[length:var(--font-micro-size)]">
                    引用键含有不支持的字符，请检查空格、逗号、花括号、反斜杠、%、# 和引号。
                  </p>
                ) : null}
                {documentDerivedKey === null && documentKey.trim().length === 0 && documentTitle.trim().length > 0 ? (
                  <p className="text-muted text-[length:var(--font-micro-size)]">题名里没有可用的词，请自己指定一个 key。</p>
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
              className="mt-1 h-[var(--control-height)] shrink-0 self-start rounded-control bg-accent-soft px-3 text-ink text-[length:var(--font-meta-size)] active:bg-[var(--accent-soft-strong)] disabled:opacity-40"
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
              <p role="alert" className="text-[var(--st-bad)] text-[length:var(--font-micro-size)]">
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
              className="mt-1 h-[var(--control-height)] self-start rounded-control bg-accent-soft px-3 text-ink text-[length:var(--font-meta-size)] active:bg-[var(--accent-soft-strong)] disabled:opacity-40"
            >
              从 DOI 导入
            </button>
          </div>
        ) : null}

        {tab === 'bibliography' ? (
          <div className="flex flex-col gap-2" data-testid="literature-import-panel-bibliography">
            <span className={labelClass}>参考文献格式</span>
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
                      ? 'h-[var(--control-height-compact)] rounded-control border-[0.5px] border-line bg-accent-soft px-2.5 text-ink text-[length:var(--font-meta-size)]'
                      : 'h-[var(--control-height-compact)] rounded-control border-[0.5px] border-line px-2.5 text-muted text-[length:var(--font-meta-size)] hover:bg-[var(--overlay-hover)]'
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
                className="h-[var(--control-height)] shrink-0 rounded-control border-[0.5px] border-line px-3 text-ink text-[length:var(--font-meta-size)] hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]"
              >
                选择文件…
              </button>
              <span className="min-w-0 flex-1 truncate font-mono text-muted text-[length:var(--font-micro-size)]" data-testid="literature-import-bibliography-path">
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
              className="mt-1 h-[var(--control-height)] self-start rounded-control bg-accent-soft px-3 text-ink text-[length:var(--font-meta-size)] active:bg-[var(--accent-soft-strong)] disabled:opacity-40"
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
              className="w-full rounded-control border-[0.5px] border-line bg-surface px-2 py-1 text-ink text-[length:var(--font-meta-size)]"
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
              className="w-full rounded-control border-[0.5px] border-line bg-surface px-2 py-1 text-ink text-[length:var(--font-meta-size)]"
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
              <p role="alert" className="text-[var(--st-bad)] text-[length:var(--font-micro-size)]">
                引用键含有不支持的字符，请检查空格、逗号、花括号、反斜杠、%、# 和引号。
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
              className="mt-1 h-[var(--control-height)] self-start rounded-control bg-accent-soft px-3 text-ink text-[length:var(--font-meta-size)] active:bg-[var(--accent-soft-strong)] disabled:opacity-40"
            >
              录入
            </button>
          </div>
        ) : null}

        {tab === 'zotero' ? <ZoteroImportPanel client={props.client} job={zoteroJob} attachments={attachmentJobs}
          draftGuard={zoteroDraftGuard} /> : null}

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
                  if (busy.current !== null) return;
                  setSearchError(null);
                  setSearchResult(null);
                  setSearchHits([]);
                  void perform('search', () => props.searchLiterature(query, sources, 10), result => {
                      if (result.ok) {
                        setSearchHits(result.result.candidates);
                        setSearchResult(result.result);
                        return;
                      }
                      setSearchHits([]);
                      setSearchError(result.message);
                    });
                }}
                data-testid="literature-import-search-submit"
                className="flex h-[var(--control-height)] shrink-0 items-center gap-1 rounded-control border-[0.5px] border-line px-3 text-ink text-[length:var(--font-meta-size)] hover:bg-[var(--overlay-hover)] disabled:opacity-40"
              >
                <Search size={12} aria-hidden="true" />
                检索
              </button>
            </div>
            {arxivId === null ? null : (
              <p className="text-muted text-[length:var(--font-micro-size)]">
                识别为 arXiv id <span className="font-mono">{arxivId}</span>，只在 arXiv 上检索。
              </p>
            )}
            {searchError === null ? null : (
              <p role="alert" className="text-[var(--st-bad)] text-[length:var(--font-micro-size)]">
                {searchError}
              </p>
            )}
            {searchResult === null ? null : (
              <p role="status" className="text-muted tabular-nums text-[length:var(--font-micro-size)]">
                {searchResult.status === 'failed' ? '检索失败，请稍后重试。' : searchResult.status === 'partial' ? '部分来源未完成，以下为可用结果。' : `找到 ${searchResult.total} 篇候选，尚未加入文献库。`}
                {searchResult.warnings.join(' ')}
              </p>
            )}
            {searchHits.length === 0 ? null : (
              <ul className="flex max-h-80 flex-col overflow-y-auto pr-1" aria-label="检索结果" tabIndex={0}>
                {searchHits.map(candidate => <LiteratureCandidateReview key={candidate.candidateId}
                  candidate={candidate} pending={pending || searchResult === null}
                  onAdd={() => {
                    if (searchResult === null) return;
                    void run(() => props.addCandidate(searchResult.searchId, candidate.candidateId));
                  }} />)}
              </ul>
            )}
          </div>
        ) : null}

        {pending ? (
          <p role="status" className="flex items-center gap-1.5 text-muted text-[length:var(--font-micro-size)]" data-testid="literature-import-pending">
            <Loader2 size={12} aria-hidden="true" className="animate-spin" />
            {operationLabels[operation!]}
          </p>
        ) : null}

        {message === null ? null : (
          <p
            role={message.tone === 'ok' ? 'status' : 'alert'}
            data-testid="literature-import-message"
            className={`flex items-center gap-1.5 text-[length:var(--font-meta-size)] ${
              message.tone === 'ok' ? 'text-[var(--st-ok)]' : 'text-[var(--st-bad)]'
            }`}
          >
            {message.tone === 'ok' ? <CheckCircle2 size={12} aria-hidden="true" /> : <TriangleAlert size={12} aria-hidden="true" />}
            {message.text}
          </p>
        )}

        <p className={labelClass}>
          <FileText size={10} aria-hidden="true" className="mr-1 inline" />
          添加文档后，在阅读器中选择「解析」即可提取可检索内容。
        </p>
      </fieldset>
    </ModalShell>
    <ConfirmDialog
      open={open && discardOpen}
      title={zoteroDirty ? '放弃尚未确认的核对说明？' : '放弃尚未导入的内容？'}
      message={zoteroDirty ? '核对说明尚未确认，放弃后需要重新填写。' : '录入内容尚未导入文献库，放弃后需要重新填写。'}
      confirmLabel={zoteroDirty ? '放弃说明并继续' : '放弃录入'}
      cancelLabel="继续录入"
      confirmDisabled={pending}
      tone="destructive"
      testId="literature-import-discard"
      onCancel={() => { pendingNavigation.current = null; setDiscardOpen(false); }}
      onConfirm={() => {
        if (busy.current !== null) return;
        const proceed = pendingNavigation.current;
        pendingNavigation.current = null;
        setDiscardOpen(false);
        if (proceed === null) onClose();
        else proceed();
      }}
    />
    </>
  );
}
