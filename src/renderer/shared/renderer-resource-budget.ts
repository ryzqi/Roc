export const selectedPdfHiddenGraceMs = 30_000;

let hidden = false, pressure = false;
let documentHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
let pdfExpired = false;
let pdfTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
const policyListeners = new Set<() => void>();
const pdfListeners = new Set<() => void>();

export function rendererCachesShouldReclaim(): boolean {
  return hidden || documentHidden || pressure;
}

/** Only an already open, selected PDF may remain warm during a short hide. */
export function rendererPdfShouldReclaim(): boolean {
  return pressure || pdfExpired;
}

function notify(previous: boolean, previousPdf: boolean): void {
  if (previous !== rendererCachesShouldReclaim()) for (const listener of policyListeners) listener();
  if (previousPdf !== rendererPdfShouldReclaim()) for (const listener of pdfListeners) listener();
  if (rendererCachesShouldReclaim()) for (const listener of listeners) listener();
}

function updateHidden(): void {
  if (!hidden && !documentHidden) {
    if (pdfTimer !== null) clearTimeout(pdfTimer);
    pdfTimer = null;
    pdfExpired = false;
  } else if (pdfTimer === null && !pdfExpired) {
    pdfTimer = setTimeout(() => {
      pdfTimer = null;
      const previous = rendererCachesShouldReclaim(), previousPdf = rendererPdfShouldReclaim();
      pdfExpired = hidden || documentHidden;
      notify(previous, previousPdf);
    }, selectedPdfHiddenGraceMs);
  }
}

export function setRendererResourcePolicy(policy: { hidden?: boolean; pressure?: boolean }): void {
  const previous = rendererCachesShouldReclaim(), previousPdf = rendererPdfShouldReclaim();
  hidden = policy.hidden ?? hidden;
  pressure = policy.pressure ?? pressure;
  updateHidden();
  notify(previous, previousPdf);
}

export function subscribeRendererPdfPolicy(listener: () => void): () => void {
  pdfListeners.add(listener);
  return () => pdfListeners.delete(listener);
}

export function subscribeRendererResourcePolicy(listener: () => void): () => void {
  policyListeners.add(listener);
  return () => policyListeners.delete(listener);
}

/** Heavy lazy modules subscribe here; the shell never imports their implementation. */
export function subscribeRendererCacheReclaim(listener: () => void): () => void {
  listeners.add(listener);
  if (rendererCachesShouldReclaim()) listener();
  return () => listeners.delete(listener);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    const previous = rendererCachesShouldReclaim(), previousPdf = rendererPdfShouldReclaim();
    documentHidden = document.visibilityState === 'hidden';
    updateHidden();
    notify(previous, previousPdf);
  });
  updateHidden();
}
