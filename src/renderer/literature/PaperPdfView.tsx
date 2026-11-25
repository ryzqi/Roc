import {useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {ChevronLeft, ChevronRight, Loader2, ScanLine, ZoomIn, ZoomOut} from 'lucide-react';
import {getDocument, PDFWorker, type PDFDocumentLoadingTask, type PDFDocumentProxy, type PDFPageProxy, type RenderTask} from 'pdfjs-dist';
import PdfWorkerPort from 'pdfjs-dist/build/pdf.worker.min.mjs?worker';
import type {ResearchDocument, ResearchDocumentParse} from '../../shared/types';
import type {ResearchDocumentPreview} from '../../shared/schemas/research-document-preview';
import type {ResearchSourceLocator} from '../../shared/schemas/research-source-locator';
import type {RocClient} from '../shared/roc-client';
import {projectParsedRegionToPdf} from '../../shared/research-document-coordinates';
import {ErrorBar} from '../shell/ErrorBar';
import {documentContentHash} from './document-content-hash';
import PaperAnnotations, {type AnnotationDraft, type AnnotationTransitionGuard} from './PaperAnnotations';
import PdfTextLayer, {type PdfTextSelection} from './PdfTextLayer';
import PdfReadingTools, {type TranslationSegment} from './PdfReadingTools';
import type {ReadingHighlight} from '../../shared/schemas/research-reading';
import type {ResearchDocumentAnnotationTarget} from '../../shared/schemas/research-document-annotations';
import {openPdfSource, releasePdfSource} from './pdf-source';
import {useViewActive, useViewSelected} from '../shared/view-activity';
import {rendererPdfShouldReclaim, subscribeRendererPdfPolicy} from '../shared/renderer-resource-budget';
import {InlineCommandBar, type InlineCommandAction, type InlineSelectionContext} from '../canvas/InlineCommandBar';

type Location = ResearchDocumentParse['content']['blocks'][number]['locations'][number];
type Props = {
  client: RocClient; projectId: string; document: ResearchDocument; parsed: ResearchDocumentParse | null;
  selection: {blockId: string; locationIndex: number} | null;
  /** Validated scientific cell/object geometry in the captured parse coordinate system. */
  focusLocation?: ResearchSourceLocator['locations'][number] | null;
  onSelectBlock: (selection: {blockId: string; locationIndex: number}) => void
  canAnnotate: boolean;
  enableInlineCommands?: boolean;
  onNote?: (text: string) => void; onTranslate?: (segments: TranslationSegment[], label: string) => void;
};
type OpenDocument = {key: string; preview: ResearchDocumentPreview | null; pdf: PDFDocumentProxy};
type ProjectedLocation = {
  blockId: string; locationIndex: number; label: string; locator: string;
  region: [number, number, number, number] | null; wholePage: boolean
};
type PageLocation = Pick<ProjectedLocation, 'blockId' | 'locationIndex' | 'label' | 'locator'> & {location: Location};
const maximumCanvasPixels = 4_000_000;

/** Own one PDF worker and one visible page. All geometry comes from a sealed parse and actual PDF viewport. */
export default function PaperPdfView({client, projectId, document, parsed, selection, focusLocation = null, onSelectBlock, canAnnotate, enableInlineCommands = false, onNote, onTranslate}: Props): React.JSX.Element {
  const viewActive = useViewActive();
  const viewSelected = useViewSelected();
  const reclaim = useSyncExternalStore(subscribeRendererPdfPolicy, rendererPdfShouldReclaim);
  const [revision, setRevision] = useState(0);
  const key = JSON.stringify([projectId, document.id, parsed?.run.id, document.sourceHash, revision]);
  const [opened, setOpened] = useState<OpenDocument | null>(null);
  // Keep a selected, already open PDF warm briefly; do not begin loading while hidden.
  const active = viewSelected && !reclaim && (viewActive || opened?.key === key);
  // Sealed annotation metadata is small and must outlive the disposable PDF proxy.
  const [previewMetadata, setPreviewMetadata] = useState<{key: string; value: ResearchDocumentPreview} | null>(null);
  const [error, setError] = useState<{key: string; message: string} | null>(null);
  const [pageSelection, setPageSelection] = useState<{key: string; page: number} | null>(null);
  const [zoomSelection, setZoomSelection] = useState<{key: string; value: number} | null>(null);
  const [pageDraft, setPageDraft] = useState('');
  const [pageError, setPageError] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const [height,setHeight]=useState(0),[fitPage,setFitPage]=useState(false);
  const scrollRef=useRef<HTMLDivElement>(null);
  const [textSelection,setTextSelection]=useState<PdfTextSelection|null>(null);
  const [inlineCommandsOpen,setInlineCommandsOpen]=useState(false);
  const [highlights,setHighlights]=useState<ReadingHighlight[]>([]),[query,setQuery]=useState('');
  const areaRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rasterRelease = useRef<Promise<void>>(Promise.resolve());
  const [pixelRatio, setPixelRatio] = useState(() => window.devicePixelRatio);
  const [painted, setPainted] = useState<{
    key: string; viewport: ReturnType<PDFPageProxy['getViewport']>; ratio: number
  } | null>(null);
  const [candidateRequest, setCandidateRequest] = useState<{key: string; locations: ProjectedLocation[]; pageOnly: boolean; fromPoint: boolean} | null>(null);
  const [annotationsOpen, setAnnotationsOpen] = useState<{key: string; open: boolean} | null>(null);
  const [annotationDraft, setAnnotationDraft] = useState<{key: string; draft: AnnotationDraft} | null>(null);
  const [annotationLocation, setAnnotationLocation] = useState<{key: string; target: ResearchDocumentAnnotationTarget} | null>(null);
  const [regionMode, setRegionMode] = useState<string | null>(null);
  const [regionError, setRegionError] = useState<{key: string; message: string} | null>(null);
  const annotationButtonRef = useRef<HTMLButtonElement>(null);
  const annotationGuard = useRef<AnnotationTransitionGuard | null>(null);
  const dragOverlayRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{paintKey: string; pointerId: number; x: number; y: number} | null>(null);
  const skipClick = useRef(false);
  const current = active && opened?.key === key ? opened : null;
  const preview = previewMetadata?.key === key ? previewMetadata.value : null;
  const parsedLocations = useMemo(() => {
    const blocks = new Map<string, ResearchDocumentParse['content']['blocks'][number]>();
    const pages = new Map<number, PageLocation[]>();
    for (const block of parsed?.content.blocks ?? []) {
      if (!blocks.has(block.id)) blocks.set(block.id, block);
      block.locations.forEach((location, locationIndex) => {
        const page = pages.get(location.page) ?? [];
        page.push({blockId: block.id, locationIndex, label: block.label, locator: block.locator, location});
        pages.set(location.page, page);
      });
    }
    return {blocks, pages};
  }, [parsed?.content]);
  const frames = useMemo(() => {
    const result = new Map<number, NonNullable<ResearchDocumentPreview['coordinates']>['pages'][number]['frame']>();
    for (const page of current?.preview?.coordinates?.pages ?? []) if (!result.has(page.page)) result.set(page.page, page.frame);
    return result;
  }, [current?.preview?.coordinates]);
  const block = selection === null ? null : parsedLocations.blocks.get(selection.blockId) ?? null;
  const location: Location | null = selection === null || block === null ? null : block.locations[selection.locationIndex] ?? null;
  const pageKey = JSON.stringify([key, selection?.blockId, selection?.locationIndex, focusLocation]);
  const pageNumber = pageSelection?.key === pageKey ? pageSelection.page : focusLocation?.page ?? location?.page ?? 1;
  const zoom = zoomSelection?.key === key ? zoomSelection.value : 1;
  // Height changes caused by scrollbars do not change an adapt-to-width bitmap.
  const fitHeight = fitPage ? height : 0;
  const rasterKey = JSON.stringify([key, pageNumber, width, fitHeight, fitPage, zoom, pixelRatio]);
  const overlayKey = JSON.stringify([rasterKey, selection, focusLocation, current?.preview?.coordinates?.snapshotHash]);
  const candidateKey = JSON.stringify([key, pageNumber]);
  const frame = frames.get(pageNumber) ?? undefined;

  useEffect(() => {
    setOpened(null);
    setPainted(null);
    if (!active) return;
    let cancelled = false;
    let task: PDFDocumentLoadingTask | null = null;
    let worker: PDFWorker | null = null;
    let port: Worker | null = null;
    let sourceRelease: (() => void) | null = null;
    let transportFailure: unknown;
    const controller = new AbortController();
    const release = (): void => {
      const loading = task, ownedWorker = worker, ownedPort = port;
      sourceRelease?.(); sourceRelease = null;
      task = null; worker = null; port = null;
      const terminate = (): void => {ownedWorker?.destroy(); ownedPort?.terminate();};
      if (loading === null) terminate();
      else void loading.destroy().finally(terminate).catch(error => console.error('research_pdf_cleanup_failed', error));
    };
    setError(null);
    void (async () => {
      let preview:ResearchDocumentPreview|null=null;
      if(parsed){
      const parseHash = await documentContentHash(parsed.content);
      if (cancelled) return;
      const result = await client.api.research.previewDocument({
        projectId, documentId: document.id, parseId: parsed.run.id, sourceHash: document.sourceHash, parseHash
      });
      if (result.ok) {
        preview = result.data;
        sourceRelease = () => releasePdfSource(result.data.sourceUrl);
      }
      if (cancelled) {release(); return;}
      if (!result.ok) throw new Error(result.error.message);
      }
      if (document.mediaType !== 'application/pdf') throw new Error('所选原文件不是 PDF。');
      // The protocol validates project membership and the immutable source hash even before parsing.
      const sourceUrl=preview?.sourceUrl??`roc-preview://research/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(document.id)}/source/${document.sourceHash}`;
      const {dispose, ...source} = await openPdfSource(sourceUrl, document.size, controller.signal, error => {
        transportFailure = error;
        if (!cancelled) setError({key, message: error instanceof Error ? error.message : String(error)});
        release();
      });
      sourceRelease = dispose;
      if (cancelled) {dispose(); return;}
      port = new PdfWorkerPort();
      worker = PDFWorker.create({port});
      task = getDocument({...source, worker, stopAtErrors: true, useSystemFonts: true});
      const pdf = await task.promise;
      if (cancelled) return;
      if (preview && preview.pageCount > 0 && preview.pageCount !== pdf.numPages) throw new Error('原文件页数与解析记录不一致。');
      if (preview !== null) setPreviewMetadata({key, value: preview});
      setOpened({key, preview, pdf});
    })().catch((error: unknown) => {
      error = transportFailure ?? error;
      if (!cancelled) setError({key, message: error instanceof Error ? error.message : String(error)});
      release();
    });
    return () => {
      cancelled = true;
      controller.abort();
      release();
      setOpened(value => value?.key === key ? null : value);
      setPainted(null);
    };
  }, [active, client, projectId, document.id, document.sourceHash, document.size, parsed?.run.id, parsed?.content, key]);

  useEffect(() => {
    if (!viewActive) return;
    const area = areaRef.current!;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(area);
    return () => observer.disconnect();
  }, [viewActive]);
  useEffect(()=>{if(!viewActive)return;const element=scrollRef.current!;const observer=new ResizeObserver(([entry])=>setHeight(Math.floor(entry.contentRect.height)));observer.observe(element);return()=>observer.disconnect();},[viewActive]);
  useEffect(() => {
    if (!viewActive) return;
    const update = (): void => setPixelRatio(window.devicePixelRatio);
    update();
    const query = matchMedia(`(resolution: ${pixelRatio}dppx)`);
    query.addEventListener('change', update); window.addEventListener('resize', update);
    return () => {query.removeEventListener('change', update); window.removeEventListener('resize', update);};
  }, [viewActive, pixelRatio]);
  useEffect(()=>{setTextSelection(null);setInlineCommandsOpen(false);},[key,pageNumber]);

  const inlineSelection: InlineSelectionContext | null = enableInlineCommands && textSelection !== null && textSelection.text.trim().length > 0
    ? {filePath: document.filename, documentId: document.id, selectionText: textSelection.text, lineRange: null, source: 'pdf', page: pageNumber}
    : null;
  const runInlineCommand = (action: InlineCommandAction, context: InlineSelectionContext): void => {
    window.dispatchEvent(new CustomEvent('roc:inline-selection-command', {detail: {action, context}}));
    setInlineCommandsOpen(false);
  };
  useEffect(() => {setPageDraft(String(pageNumber)); setPageError(null);}, [pageKey, pageNumber]);

  useEffect(() => {
    if (current === null || width <= 0) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    let page: PDFPageProxy | null = null;
    const canvas = canvasRef.current!;
    const previousRelease = rasterRelease.current;
    const settled = (async () => {
      await previousRelease;
      if (cancelled) return;
      page = await current.pdf.getPage(pageNumber);
      if (cancelled) return;
      const base = page.getViewport({scale: 1});
      const cssScale = (fitPage ? Math.min(width/base.width,Math.max(100,fitHeight-16)/base.height) : width/base.width) * zoom;
      const scale = Math.min(cssScale * pixelRatio, Math.sqrt(maximumCanvasPixels / (base.width * base.height)));
      const viewport = page.getViewport({scale});
      const ratio = scale / cssScale;
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      canvas.style.width = `${viewport.width / ratio}px`;
      canvas.style.height = `${viewport.height / ratio}px`;
      task = page.render({canvas, viewport});
      await task.promise;
      if (!cancelled) setPainted({key: rasterKey, viewport, ratio});
    })().catch((error: unknown) => {
      if (!cancelled) setError({key, message: error instanceof Error ? error.message : String(error)});
    });
    return () => {
      cancelled = true;
      task?.cancel();
      const release = (): void => {page?.cleanup(); canvas.width = 0; canvas.height = 0;};
      rasterRelease.current = settled.then(release, release);
    };
  }, [current, width, fitHeight, fitPage, zoom, pixelRatio, pageNumber, rasterKey, key]);

  const raster = active && painted?.key === rasterKey ? painted : null;
  const projection = useMemo(() => {
    const locations: ProjectedLocation[] = [];
    if (raster === null) return {locations, focus: null, error: null};
    try {
      if (frame !== undefined && frame.kind !== 'pdf') throw new Error('所选解析页没有 PDF 坐标基准。');
      for (const entry of parsedLocations.pages.get(pageNumber) ?? []) {
        const {location, ...identity} = entry;
        let region: ProjectedLocation['region'] = null, wholePage = false;
        if (frame !== undefined && location.bbox !== null && location.coordinateOrigin !== null) {
          const [x1, y1, x2, y2] = location.bbox;
          wholePage = x1 === 0 && y1 === 0 && x2 === frame.width && y2 === frame.height;
          const [left, top, right, bottom] = projectParsedRegionToPdf({frame, bbox: location.bbox, coordinateOrigin: location.coordinateOrigin});
          const points = [[left,top], [left,bottom], [right,top], [right,bottom]].map(([x,y]) => raster.viewport.convertToViewportPoint(x,y));
          region = [Math.min(...points.map(point => point[0])) / raster.ratio, Math.min(...points.map(point => point[1])) / raster.ratio,
            Math.max(...points.map(point => point[0])) / raster.ratio, Math.max(...points.map(point => point[1])) / raster.ratio];
        }
        locations.push({...identity, region, wholePage});
      }
      let focus: {region: ProjectedLocation['region']; wholePage: boolean} | null = null;
      if (focusLocation !== null && focusLocation.page === pageNumber) {
        let region: ProjectedLocation['region'] = null;
        if (focusLocation.bbox !== null && focusLocation.coordinateOrigin !== null && frame !== undefined) {
          const [left, top, right, bottom] = projectParsedRegionToPdf({
            frame, bbox: focusLocation.bbox, coordinateOrigin: focusLocation.coordinateOrigin});
          region = viewportRegion([left, top, right, bottom], raster.viewport, raster.ratio);
        }
        focus = {region, wholePage: false};
      }
      return {locations, focus, error: null};
    } catch (error) {
      return {locations: [], focus: null, error: error instanceof Error ? error.message : String(error)};
    }
  }, [raster, parsedLocations, pageNumber, frame, focusLocation]);
  const selected = selection === null ? null : projection.locations.find(location =>
    location.blockId === selection.blockId && location.locationIndex === selection.locationIndex) ?? null;
  const currentPaint = raster === null || projection.error !== null ? null : {
    ...raster, locations: projection.locations, region: (projection.focus ?? selected)?.region ?? null,
    pageOnly: (projection.focus ?? selected) !== null && (projection.focus ?? selected)?.region === null,
    wholePage: (projection.focus ?? selected)?.wholePage ?? false
  };
  const failure = (error?.key === key ? error.message : null) ?? projection.error;
  const candidates = failure === null && candidateRequest?.key === candidateKey ? candidateRequest : null;
  const changeAnnotation = (proceed: () => void): void => {
    if (annotationGuard.current) annotationGuard.current.request(proceed); else proceed();
  };
  const navigate = (page: number): void => {
    if (page === pageNumber) return;
    changeAnnotation(() => setPageSelection({key: pageKey, page}));
  };
  const showAnnotations = preview !== null && parsed!==null && annotationsOpen?.key === key && annotationsOpen.open;
  const draft = annotationDraft?.key === candidateKey ? annotationDraft.draft : null;
  const selecting = canAnnotate && parsed!==null && regionMode === overlayKey;
  const beginDraft = (location: ResearchDocumentAnnotationTarget['location']): void => changeAnnotation(() => {
    setRegionMode(null);
    setRegionError(null);
    setAnnotationsOpen({key, open: true});
    setAnnotationDraft({key: candidateKey, draft: {id: crypto.randomUUID(), page: pageNumber, location}});
    setAnnotationLocation(null);
  });
  const selectedAnnotation = annotationLocation?.key === key && annotationLocation.target.page === pageNumber ? annotationLocation.target : null;
  const shownLocation = draft?.location ?? selectedAnnotation?.location;
  const annotationRegion = currentPaint !== null && shownLocation?.kind === 'pdf-region' ?
    viewportRegion(shownLocation.bbox, currentPaint.viewport, currentPaint.ratio) : null;
  const resetDrag = (): void => {drag.current = null; if (dragOverlayRef.current !== null) dragOverlayRef.current.style.display = 'none';};
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col focus-visible:outline-2 focus-visible:outline-focus-ring focus-visible:outline-offset-[-2px]" data-testid="reader-pdf" tabIndex={0} aria-label="原 PDF 阅读"
      onKeyDown={event => {
        if (event.key === 'Escape' && selecting) {event.preventDefault(); resetDrag(); setRegionMode(null); annotationButtonRef.current?.focus(); return;}
        if (current === null || ['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement).tagName)) return;
        const page = event.key === 'PageDown' ? Math.min(current.pdf.numPages, pageNumber + 1) :
          event.key === 'PageUp' ? Math.max(1, pageNumber - 1) :
          event.key === 'Home' ? 1 : event.key === 'End' ? current.pdf.numPages : null;
        if (page !== null) {event.preventDefault(); navigate(page);}
      }}>
      <div className="reading-pdf-navigation flex shrink-0 flex-wrap items-center gap-1 border-b-[0.5px] border-line px-2 py-1.5 text-[length:var(--font-meta-size)]">
        <span className="mr-auto text-muted">原 PDF</span>
        <button type="button" aria-label="上一页" disabled={current === null || pageNumber <= 1} onClick={() => navigate(pageNumber - 1)}
          className="rounded-control p-1 hover:bg-[var(--overlay-hover)] disabled:opacity-40"><ChevronLeft size={14}/></button>
        <form className="flex items-center gap-1" onSubmit={event => {
          event.preventDefault();
          const requested = Number(pageDraft);
          if (current === null || !Number.isInteger(requested) || requested < 1 || requested > current.pdf.numPages) {
            setPageError('页码超出原文件范围。'); return;
          }
          setPageError(null); navigate(requested);
        }}>
          <input type="number" min={1} max={current?.pdf.numPages} value={pageDraft} onChange={event => setPageDraft(event.target.value)}
            aria-label="PDF 页码" disabled={current === null} className="w-12 rounded-control border-[0.5px] border-line bg-surface px-1 text-center"/>
          <span className="text-muted">/ {current?.pdf.numPages ?? '…'}</span>
          <button type="submit" disabled={current === null} className="rounded-control px-1 hover:bg-[var(--overlay-hover)] disabled:opacity-40">前往</button>
        </form>
        <button type="button" aria-label="下一页" disabled={current === null || pageNumber >= current.pdf.numPages} onClick={() => navigate(pageNumber + 1)}
          className="rounded-control p-1 hover:bg-[var(--overlay-hover)] disabled:opacity-40"><ChevronRight size={14}/></button>
        <button type="button" aria-label="缩小 PDF" disabled={current === null || zoom <= 0.5} onClick={() => setZoomSelection({key, value: Math.max(0.5, zoom - 0.25)})}
          className="rounded-control p-1 hover:bg-[var(--overlay-hover)] disabled:opacity-40"><ZoomOut size={14}/></button>
        <button type="button" aria-label="PDF 适宽" disabled={current === null} onClick={() => {setFitPage(false);setZoomSelection({key, value: 1});}}
          className="rounded-control px-1 text-muted hover:bg-[var(--overlay-hover)] disabled:opacity-40">{zoom === 1 ? (fitPage?'适页':'适宽') : `${Math.round(zoom*100)}%`}</button>
        <button type="button" disabled={current===null} aria-pressed={fitPage} onClick={()=>{setFitPage(true);setZoomSelection({key,value:1});}} className="rounded-control px-1 hover:bg-[var(--overlay-hover)]">适页</button>
        <button type="button" aria-label="放大 PDF" disabled={current === null || zoom >= 3} onClick={() => setZoomSelection({key, value: Math.min(3, zoom + 0.25)})}
          className="rounded-control p-1 hover:bg-[var(--overlay-hover)] disabled:opacity-40"><ZoomIn size={14}/></button>
        <button type="button" disabled={currentPaint === null || failure !== null}
          aria-expanded={candidates !== null} data-testid="reader-pdf-page-blocks"
          onClick={() => setCandidateRequest(candidates === null ? {key: candidateKey, locations: currentPaint!.locations,
            pageOnly: currentPaint!.locations.some(location => location.region === null), fromPoint: false} : null)}
          className="rounded-control px-1 hover:bg-[var(--overlay-hover)] disabled:opacity-40">本页解析块</button>
        <button ref={annotationButtonRef} type="button" aria-expanded={showAnnotations} disabled={current?.preview == null || parsed===null || failure !== null}
          data-testid="reader-annotations-toggle" onClick={() => changeAnnotation(() => setAnnotationsOpen({key, open: !showAnnotations}))}
          className="rounded-control px-1 hover:bg-[var(--overlay-hover)] disabled:opacity-40">批注</button>
        {canAnnotate ? <button type="button" aria-label="框选 PDF 批注区域" aria-pressed={selecting}
          disabled={currentPaint === null || frame?.kind !== 'pdf' || failure !== null}
          onClick={() => {resetDrag(); setRegionError(null); setRegionMode(selecting ? null : overlayKey);}}
          className="rounded-control p-1 hover:bg-[var(--overlay-hover)] disabled:opacity-40"><ScanLine size={14}/></button> : null}
      {current && onNote && onTranslate?<PdfReadingTools key={key} client={client} projectId={projectId} documentId={document.id} sourceHash={document.sourceHash}
        pdf={current.pdf} page={pageNumber} navigate={navigate} selection={textSelection} writable={canAnnotate} highlights={highlights}
        onHighlights={setHighlights} onQuery={setQuery} onNote={onNote} onTranslate={onTranslate}/>:null}
      </div>
      <div ref={scrollRef} data-testid="reader-pdf-scroll" className="min-h-0 flex-1 overflow-auto px-2 py-2 [scrollbar-gutter:stable]">
        {failure === null ? null : <ErrorBar error={{level: 'blocked', message: failure, retry: () => setRevision(revision => revision + 1)}}/>}
        {pageError === null ? null : <p role="alert" className="text-[var(--st-warn)]">{pageError}</p>}
        {regionError?.key === candidateKey ? <p role="alert" className="text-[var(--st-warn)]">{regionError.message}</p> : null}
        {selecting ? <p role="status" className="mb-2 text-muted">拖动框选批注区域，Escape 取消。</p> : null}
        {!showAnnotations || preview === null || parsed===null ? null : <PaperAnnotations key={key} client={client} projectId={projectId}
          document={document} parsed={parsed} preview={preview} canAnnotate={canAnnotate} draft={draft}
          transitionGuardRef={annotationGuard}
          onCreatePage={() => beginDraft({kind: 'page'})}
          onCloseDraft={() => {setAnnotationDraft(null); annotationButtonRef.current?.focus({preventScroll: true});}}
          onSelect={target => {
            setAnnotationLocation({key, target});
            setAnnotationDraft(null); resetDrag(); setRegionMode(null);
            navigate(target.page);
            canvasRef.current?.scrollIntoView({block: 'nearest'});
          }}/>}
        {currentPaint?.pageOnly ? <p role="note" className="mb-2 text-muted text-[length:var(--font-meta-size)]" data-testid="reader-pdf-page-only">该页未记录区域坐标，仅定位到页。</p> : null}
        {currentPaint?.wholePage ? <p role="note" className="mb-2 text-muted text-[length:var(--font-meta-size)]" data-testid="reader-pdf-whole-page">解析器记录的是整页范围，未细分块区域。</p> : null}
        {candidates === null ? null : <div className="mb-2 text-[length:var(--font-meta-size)]" data-testid="reader-pdf-block-candidates">
          {candidates.pageOnly ? <p role="note" className="text-muted">仅有页定位，请选择本页解析块。</p> :
            candidates.fromPoint && candidates.locations.length > 1 ? <p role="note" className="text-muted">多个区域覆盖该位置，请选择解析块。</p> : null}
          {candidates.locations.length === 0 ? <p role="note" className="text-muted">此处没有已记录的解析区域。</p> :
            <ul>{candidates.locations.map(location => <li key={`${location.blockId}:${location.locationIndex}`}>
              <button type="button" data-testid="reader-pdf-block-candidate"
                disabled={currentPaint === null}
                aria-label={`定位到${location.label} ${location.locator} 位置${location.locationIndex + 1}`}
                className="my-0.5 w-full rounded-control px-1 py-0.5 text-left hover:bg-[var(--overlay-hover)] disabled:opacity-40"
                onClick={() => {setCandidateRequest(null); onSelectBlock({blockId: location.blockId, locationIndex: location.locationIndex});}}>
                <span className="block break-words">{location.label}，{location.locator}，位置 {location.locationIndex + 1}</span>
              </button>
            </li>)}</ul>}
        </div>}
        <div ref={areaRef} className="relative w-full">
          {failure !== null || currentPaint !== null ? null : <p role="status" className="flex items-center gap-1 text-muted"><Loader2 size={14} className="animate-spin"/>读取原文…</p>}
          <div className="relative w-fit" style={{visibility: failure === null && currentPaint !== null ? 'visible' : 'hidden'}} data-testid="reader-pdf-page"
              onClick={event => {
                if (skipClick.current) {skipClick.current = false; return;}
                if (selecting || !window.getSelection()?.isCollapsed) return;
                if (currentPaint === null || failure !== null) return;
                const rect = event.currentTarget.getBoundingClientRect();
                const x = event.clientX - rect.left, y = event.clientY - rect.top;
                const matches = currentPaint.locations.filter(location => location.region !== null &&
                  x >= location.region[0] && x <= location.region[2] && y >= location.region[1] && y <= location.region[3]);
                const pageOnly = currentPaint.locations.some(location => location.region === null);
                if (matches.length === 1 && !pageOnly) {
                  setCandidateRequest(null); onSelectBlock({blockId: matches[0].blockId, locationIndex: matches[0].locationIndex});
                }
                else setCandidateRequest({key: candidateKey, locations: pageOnly ? currentPaint.locations : matches, pageOnly, fromPoint: true});
              }}>
            <canvas key={rasterKey} ref={canvasRef} data-testid="reader-pdf-canvas" aria-label={`原 PDF 第 ${pageNumber} 页`}
              className={selecting ? 'cursor-crosshair touch-none' : ''}
              onPointerDown={event => {
                if (!selecting || currentPaint === null || event.button !== 0) return;
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                drag.current = {paintKey: overlayKey, pointerId: event.pointerId, x: event.clientX - rect.left, y: event.clientY - rect.top};
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={event => {
                const start = drag.current, overlay = dragOverlayRef.current;
                if (!selecting || start?.paintKey !== overlayKey || start.pointerId !== event.pointerId || overlay === null) return;
                const rect = event.currentTarget.getBoundingClientRect();
                const x = Math.min(rect.width, Math.max(0, event.clientX - rect.left));
                const y = Math.min(rect.height, Math.max(0, event.clientY - rect.top));
                Object.assign(overlay.style, {display: 'block', left: `${Math.min(start.x,x)}px`, top: `${Math.min(start.y,y)}px`,
                  width: `${Math.abs(x-start.x)}px`, height: `${Math.abs(y-start.y)}px`});
              }}
              onPointerCancel={resetDrag}
              onPointerUp={event => {
                const start = drag.current;
                if (!selecting || currentPaint === null || frame?.kind !== 'pdf' || start?.paintKey !== overlayKey || start.pointerId !== event.pointerId) return;
                const rect = event.currentTarget.getBoundingClientRect(), viewport = currentPaint.viewport;
                const x = Math.min(rect.width, Math.max(0, event.clientX - rect.left));
                const y = Math.min(rect.height, Math.max(0, event.clientY - rect.top));
                const points = [[start.x,start.y], [start.x,y], [x,start.y], [x,y]].map(([px,py]) =>
                  viewport.convertToPdfPoint(px / rect.width * viewport.width, py / rect.height * viewport.height));
                const [left, bottom, right, top] = frame.viewport.viewBox;
                const bbox: [number, number, number, number] = [
                  Math.max(left, Math.min(...points.map(point => point[0]))), Math.max(bottom, Math.min(...points.map(point => point[1]))),
                  Math.min(right, Math.max(...points.map(point => point[0]))), Math.min(top, Math.max(...points.map(point => point[1])))
                ];
                resetDrag(); skipClick.current = true;
                event.currentTarget.releasePointerCapture(event.pointerId);
                if (bbox[2] <= bbox[0] || bbox[3] <= bbox[1]) {setRegionError({key: candidateKey, message: '请拖出非空区域。'}); return;}
                beginDraft({kind: 'pdf-region', unit: 'pdf-user-space', bbox});
              }}
/>
            {currentPaint && current?<PdfTextLayer pdf={current.pdf} page={pageNumber} viewport={currentPaint.viewport} ratio={currentPaint.ratio}
              disabled={selecting} query={query} highlights={highlights} onSelection={setTextSelection}
              onCommandSelection={enableInlineCommands ? () => setInlineCommandsOpen(true) : undefined}/>:null}
            {currentPaint?.region ? <div data-testid="reader-pdf-region" data-source-block-id={selected?.blockId}
              data-source-location-index={selected?.locationIndex} role="note" aria-label="解析区域" className="pointer-events-none absolute border-2 border-accent bg-[var(--accent-soft)] transition-none"
              style={{left: currentPaint.region[0], top: currentPaint.region[1], width: currentPaint.region[2]-currentPaint.region[0],
                height: currentPaint.region[3]-currentPaint.region[1]}}/> : null}
            {annotationRegion === null ? null : <div data-testid="reader-pdf-annotation-region" role="note" aria-label="用户批注区域"
              className="pointer-events-none absolute border-2 border-dashed border-accent transition-none"
              style={{left: annotationRegion[0], top: annotationRegion[1], width: annotationRegion[2]-annotationRegion[0],
                height: annotationRegion[3]-annotationRegion[1]}}/>}
            {selecting ? <div ref={dragOverlayRef} data-testid="reader-pdf-selection-drag" className="pointer-events-none absolute border-2 border-dashed border-accent transition-none"
              style={{display: 'none'}}/> : null}
          </div>
        </div>
      </div>
      <InlineCommandBar selection={inlineCommandsOpen ? inlineSelection : null} anchor={inlineCommandsOpen ? textSelection?.anchor ?? null : null}
        onAction={runInlineCommand} onDismiss={() => setInlineCommandsOpen(false)}/>
    </section>
  );
}

function viewportRegion(bbox: [number, number, number, number], viewport: ReturnType<PDFPageProxy['getViewport']>,
  ratio: number): [number, number, number, number] {
  const [left, bottom, right, top] = bbox;
  const points = [[left,bottom], [left,top], [right,bottom], [right,top]].map(([x,y]) => viewport.convertToViewportPoint(x,y));
  return [Math.min(...points.map(point => point[0])) / ratio, Math.min(...points.map(point => point[1])) / ratio,
    Math.max(...points.map(point => point[0])) / ratio, Math.max(...points.map(point => point[1])) / ratio];
}
