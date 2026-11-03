import {useCallback, useLayoutEffect, useRef} from 'react';
import type {ResearchArtifactInspectRequest} from '../../shared/schemas/research-artifact-inspector';
import type {ArtifactReadingLocations, ProductionFileLocation} from './artifact-reading-location';

export function useArtifactReadingLocation(
  request: ResearchArtifactInspectRequest,
  version: string | undefined,
  locations: ArtifactReadingLocations,
  productionOpen: boolean
) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const productionFileRef = useRef<{version: string | undefined; location: ProductionFileLocation} | null>(null);
  const setProductionFile = useCallback((location: ProductionFileLocation): void => {
    productionFileRef.current = {version, location};
  }, [version]);
  const scope = JSON.stringify([request.projectId, request.artifactId]);
  const saved = locations.get(scope);
  const location = saved !== undefined && saved.version === version ? saved : null;
  const latestRef = useRef({version, productionOpen});
  latestRef.current = {version, productionOpen};

  const save = (): void => {
    const body = bodyRef.current;
    const current = latestRef.current;
    if (body === null || current.version === undefined) return;
    const active = document.activeElement;
    locations.set(scope, {
      version: current.version,
      scrollTop: body.scrollTop,
      openDetails: Array.from(body.querySelectorAll<HTMLDetailsElement>('details[data-reading-key][open]'),
        element => element.dataset.readingKey!),
      focusKey: active instanceof HTMLElement && body.contains(active) ? active.dataset.readingKey ?? null : null,
      textScrollTop: body.querySelector('[data-testid="artifact-production-text"]')?.scrollTop ?? 0,
      productionOpen: current.productionOpen,
      productionFile: current.productionOpen && productionFileRef.current?.version === current.version ?
        productionFileRef.current.location : null
    });
  };

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (body === null || location === null) return;
    // Source modules and verified files mount asynchronously. Follow actual DOM/layout
    // changes until the reader interacts; never restore over a new manual position.
    const restore = (): void => {
      for (const details of body.querySelectorAll<HTMLDetailsElement>('details[data-reading-key]')) {
        const open = location.openDetails.includes(details.dataset.readingKey!);
        if (details.open !== open) details.open = open;
      }
      const focus = Array.from(body.querySelectorAll<HTMLElement>('[data-reading-key]'))
        .find(element => element.dataset.readingKey === location.focusKey);
      if (focus !== undefined && focus.getClientRects().length > 0 && !focus.hasAttribute('disabled')) {
        focus.focus({preventScroll: true});
      }
      const text = body.querySelector<HTMLElement>('[data-testid="artifact-production-text"]');
      if (text !== null) text.scrollTop = location.textScrollTop;
      body.scrollTop = location.scrollTop;
    };
    const mutations = new MutationObserver(restore);
    const sizes = new ResizeObserver(restore);
    mutations.observe(body, {childList: true, subtree: true});
    if (body.firstElementChild !== null) sizes.observe(body.firstElementChild);
    const stop = (): void => {mutations.disconnect(); sizes.disconnect();};
    for (const event of ['pointerdown', 'keydown', 'wheel']) body.addEventListener(event, stop, {capture: true, once: true});
    restore();
    return () => {
      stop();
      for (const event of ['pointerdown', 'keydown', 'wheel']) body.removeEventListener(event, stop, true);
    };
  }, [scope, version]); // Only a freshly verified version can restore a reading location.

  return {bodyRef, location, setProductionFile, save};
}
