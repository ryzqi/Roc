import {useEffect, useRef, useState} from 'react';
import {ChevronLeft, ChevronRight, Loader2, ZoomIn, ZoomOut} from 'lucide-react';
import {getDocument, PDFWorker, type PDFDocumentLoadingTask, type PDFDocumentProxy, type PDFPageProxy, type RenderTask} from 'pdfjs-dist';
import PdfWorkerPort from 'pdfjs-dist/build/pdf.worker.min.mjs?worker';
import type {ResearchDocument, ResearchDocumentParse} from '../../shared/types';
import type {ResearchDocumentPreview} from '../../shared/schemas/research-document-preview';
import type {RocClient} from '../shared/roc-client';
import {projectParsedRegionToPdf} from '../../shared/research-document-coordinates';
import {ErrorBar} from '../shell/ErrorBar';

type Location = ResearchDocumentParse['content']['blocks'][number]['locations'][number];
type Props = {
  client: RocClient; projectId: string; document: ResearchDocument; parsed: ResearchDocumentParse;
  selection: {blockId: string; locationIndex: number} | null;
  onSelectBlock: (selection: {blockId: string; locationIndex: number}) => void
};
type OpenDocument = {key: string; preview: ResearchDocumentPreview; pdf: PDFDocumentProxy};
type ProjectedLocation = {
  blockId: string; locationIndex: number; label: string; locator: string;
  region: [number, number, number, number] | null; wholePage: boolean
};
const maximumCanvasPixels = 4_000_000;

/** Own one PDF worker and one visible page. All geometry comes from a sealed parse and actual PDF viewport. */
export default function PaperPdfView({client, projectId, document, parsed, selection, onSelectBlock}: Props): React.JSX.Element {
  const [revision, setRevision] = useState(0);
  const key = JSON.stringify([projectId, document.id, parsed.run.id, document.sourceHash, revision]);
  const [opened, setOpened] = useState<OpenDocument | null>(null);
  const [error, setError] = useState<{key: string; message: string} | null>(null);
  const [pageSelection, setPageSelection] = useState<{key: string; page: number} | null>(null);
  const [zoomSelection, setZoomSelection] = useState<{key: string; value: number} | null>(null);
  const [pageDraft, setPageDraft] = useState('');
  const [pageError, setPageError] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const areaRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [painted, setPainted] = useState<{key: string; locations: ProjectedLocation[]; region: [number, number, number, number] | null; pageOnly: boolean; wholePage: boolean} | null>(null);
  const [candidateRequest, setCandidateRequest] = useState<{key: string; locations: ProjectedLocation[]; pageOnly: boolean; fromPoint: boolean} | null>(null);
  const current = opened?.key === key ? opened : null;
  const block = selection === null ? null : parsed.content.blocks.find(block => block.id === selection.blockId) ?? null;
  const location: Location | null = selection === null || block === null ? null : block.locations[selection.locationIndex] ?? null;
  const pageKey = JSON.stringify([key, selection?.blockId, selection?.locationIndex]);
  const pageNumber = pageSelection?.key === pageKey ? pageSelection.page : location?.page ?? 1;
  const zoom = zoomSelection?.key === key ? zoomSelection.value : 1;
  const paintKey = JSON.stringify([key, pageNumber, width, zoom, selection]);
  const candidateKey = JSON.stringify([key, pageNumber]);

  useEffect(() => {
    let cancelled = false;
    let task: PDFDocumentLoadingTask | null = null;
    let worker: PDFWorker | null = null;
    let port: Worker | null = null;
    const controller = new AbortController();
    const release = (): void => {
      const loading = task, ownedWorker = worker, ownedPort = port;
      task = null; worker = null; port = null;
      const terminate = (): void => {ownedWorker?.destroy(); ownedPort?.terminate();};
      if (loading === null) terminate();
      else void loading.destroy().finally(terminate).catch(error => console.error('research_pdf_cleanup_failed', error));
    };
    setError(null);
    void (async () => {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parsed.content)));
      const parseHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      const result = await client.api.research.previewDocument({
        projectId, documentId: document.id, parseId: parsed.run.id, sourceHash: document.sourceHash, parseHash
      });
      if (cancelled) return;
      if (!result.ok) throw new Error(result.error.message);
      if (result.data.mediaType !== 'application/pdf') throw new Error('所选原文件不是 PDF。');
      const response = await fetch(result.data.sourceUrl, {signal: controller.signal});
      if (!response.ok) throw new Error(`原 PDF 资源读取失败（${response.status}）。`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (cancelled) return;
      port = new PdfWorkerPort();
      worker = PDFWorker.create({port});
      task = getDocument({data: bytes, worker, stopAtErrors: true, useSystemFonts: true});
      const pdf = await task.promise;
      if (cancelled) return;
      if (result.data.pageCount > 0 && result.data.pageCount !== pdf.numPages) throw new Error('原文件页数与解析记录不一致。');
      setOpened({key, preview: result.data, pdf});
    })().catch((error: unknown) => {
      if (!cancelled) setError({key, message: error instanceof Error ? error.message : String(error)});
      release();
    });
    return () => {
      cancelled = true;
      controller.abort();
      release();
    };
  }, [client, projectId, document.id, document.sourceHash, parsed.run.id, parsed.content, key]);

  useEffect(() => {
    const area = areaRef.current!;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(area);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {setPageDraft(String(pageNumber)); setPageError(null);}, [pageKey, pageNumber]);

  useEffect(() => {
    if (current === null || width <= 0) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    let page: PDFPageProxy | null = null;
    const canvas = canvasRef.current!;
    void (async () => {
      page = await current.pdf.getPage(pageNumber);
      if (cancelled) {page.cleanup(); return;}
      const base = page.getViewport({scale: 1});
      const cssScale = width * zoom / base.width;
      const scale = Math.min(cssScale * window.devicePixelRatio, Math.sqrt(maximumCanvasPixels / (base.width * base.height)));
      const viewport = page.getViewport({scale});
      const ratio = scale / cssScale;
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      canvas.style.width = `${viewport.width / ratio}px`;
      canvas.style.height = `${viewport.height / ratio}px`;
      const frame = current.preview.coordinates?.pages.find(page => page.page === pageNumber)?.frame ?? null;
      if (frame !== null && frame.kind !== 'pdf') throw new Error('所选解析页没有 PDF 坐标基准。');
      const locations = parsed.content.blocks.flatMap(block => block.locations.flatMap((location, locationIndex): ProjectedLocation[] => {
        if (location.page !== pageNumber) return [];
        let region: [number, number, number, number] | null = null;
        let wholePage = false;
        const [x1, y1, x2, y2] = location.bbox;
        if (frame !== null && x2 > x1 && y2 > y1) {
          wholePage = x1 === 0 && y1 === 0 && x2 === frame.width && y2 === frame.height;
          const pdfRegion = projectParsedRegionToPdf({frame, bbox: location.bbox, coordinateOrigin: location.coordinateOrigin});
          const [left, top, right, bottom] = pdfRegion;
          const points = [[left, top], [left, bottom], [right, top], [right, bottom]].map(([x,y]) => viewport.convertToViewportPoint(x,y));
          region = [Math.min(...points.map(point => point[0])) / ratio, Math.min(...points.map(point => point[1])) / ratio,
            Math.max(...points.map(point => point[0])) / ratio, Math.max(...points.map(point => point[1])) / ratio];
        }
        return [{blockId: block.id, locationIndex, label: block.label, locator: block.locator, region, wholePage}];
      }));
      const selected = selection === null ? null : locations.find(location =>
        location.blockId === selection.blockId && location.locationIndex === selection.locationIndex) ?? null;
      task = page.render({canvas, viewport});
      await task.promise;
      if (!cancelled) setPainted({key: paintKey, locations, region: selected?.region ?? null,
        pageOnly: selected !== null && selected.region === null, wholePage: selected?.wholePage ?? false});
    })().catch((error: unknown) => {
      if (!cancelled) setError({key, message: error instanceof Error ? error.message : String(error)});
    });
    return () => {
      cancelled = true;
      task?.cancel();
      const release = (): void => {page?.cleanup(); canvas.width = 0; canvas.height = 0;};
      if (task === null) release();
      else void task.promise.then(release, release);
    };
  }, [current, width, zoom, pageNumber, paintKey, key, location, parsed.content]);

  const currentPaint = painted?.key === paintKey ? painted : null;
  const failure = error?.key === key ? error.message : null;
  const candidates = failure === null && candidateRequest?.key === candidateKey ? candidateRequest : null;
  const navigate = (page: number): void => {setPageSelection({key: pageKey, page});};
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-[-2px]" data-testid="reader-pdf" tabIndex={0} aria-label="原 PDF 阅读"
      onKeyDown={event => {
        if (current === null || ['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement).tagName)) return;
        const page = event.key === 'PageDown' ? Math.min(current.pdf.numPages, pageNumber + 1) :
          event.key === 'PageUp' ? Math.max(1, pageNumber - 1) :
          event.key === 'Home' ? 1 : event.key === 'End' ? current.pdf.numPages : null;
        if (page !== null) {event.preventDefault(); navigate(page);}
      }}>
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line px-2 py-1.5 text-[var(--font-meta-size)]">
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
            aria-label="PDF 页码" disabled={current === null} className="w-12 rounded-control border border-line bg-surface px-1 text-center"/>
          <span className="text-muted">/ {current?.pdf.numPages ?? '…'}</span>
          <button type="submit" disabled={current === null} className="rounded-control px-1 hover:bg-[var(--overlay-hover)] disabled:opacity-40">前往</button>
        </form>
        <button type="button" aria-label="下一页" disabled={current === null || pageNumber >= current.pdf.numPages} onClick={() => navigate(pageNumber + 1)}
          className="rounded-control p-1 hover:bg-[var(--overlay-hover)] disabled:opacity-40"><ChevronRight size={14}/></button>
        <button type="button" aria-label="缩小 PDF" disabled={current === null || zoom <= 0.5} onClick={() => setZoomSelection({key, value: Math.max(0.5, zoom - 0.25)})}
          className="rounded-control p-1 hover:bg-[var(--overlay-hover)] disabled:opacity-40"><ZoomOut size={14}/></button>
        <button type="button" aria-label="PDF 适宽" disabled={current === null} onClick={() => setZoomSelection({key, value: 1})}
          className="rounded-control px-1 text-muted hover:bg-[var(--overlay-hover)] disabled:opacity-40">{zoom === 1 ? '适宽' : `${Math.round(zoom*100)}%`}</button>
        <button type="button" aria-label="放大 PDF" disabled={current === null || zoom >= 3} onClick={() => setZoomSelection({key, value: Math.min(3, zoom + 0.25)})}
          className="rounded-control p-1 hover:bg-[var(--overlay-hover)] disabled:opacity-40"><ZoomIn size={14}/></button>
        <button type="button" disabled={currentPaint === null || failure !== null}
          aria-expanded={candidates !== null} data-testid="reader-pdf-page-blocks"
          onClick={() => setCandidateRequest(candidates === null ? {key: candidateKey, locations: currentPaint!.locations,
            pageOnly: currentPaint!.locations.some(location => location.region === null), fromPoint: false} : null)}
          className="rounded-control px-1 hover:bg-[var(--overlay-hover)] disabled:opacity-40">本页解析块</button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 [scrollbar-gutter:stable]">
        {failure === null ? null : <ErrorBar error={{level: 'blocked', message: failure, retry: () => setRevision(revision => revision + 1)}}/>}
        {pageError === null ? null : <p role="alert" className="text-[var(--st-warn)]">{pageError}</p>}
        {currentPaint?.pageOnly ? <p role="note" className="mb-2 text-muted text-[var(--font-meta-size)]" data-testid="reader-pdf-page-only">该页未记录区域坐标，仅定位到页。</p> : null}
        {currentPaint?.wholePage ? <p role="note" className="mb-2 text-muted text-[var(--font-meta-size)]" data-testid="reader-pdf-whole-page">解析器记录的是整页范围，未细分块区域。</p> : null}
        {candidates === null ? null : <div className="mb-2 text-[var(--font-meta-size)]" data-testid="reader-pdf-block-candidates">
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
          <div className="relative" style={{visibility: failure === null && currentPaint !== null ? 'visible' : 'hidden'}}>
            <canvas key={paintKey} ref={canvasRef} data-testid="reader-pdf-canvas" aria-label={`原 PDF 第 ${pageNumber} 页`}
              onClick={event => {
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
              }}/>
            {currentPaint?.region ? <div data-testid="reader-pdf-region" role="note" aria-label="解析区域" className="pointer-events-none absolute border-2 border-accent bg-[var(--accent-soft)]"
              style={{left: currentPaint.region[0], top: currentPaint.region[1], width: currentPaint.region[2]-currentPaint.region[0],
                height: currentPaint.region[3]-currentPaint.region[1]}}/> : null}
          </div>
        </div>
      </div>
    </section>
  );
}
