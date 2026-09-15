type VisibilityDocumentElement = {
  dataset: DOMStringMap;
};

type VisibilityRoot = {
  documentElement: VisibilityDocumentElement;
  visibilityState: DocumentVisibilityState;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
};

export function syncWindowHiddenState(root: Pick<VisibilityRoot, 'documentElement' | 'visibilityState'>): void {
  root.documentElement.dataset.windowHidden = String(root.visibilityState === 'hidden');
}

export function bindWindowVisibility(root: VisibilityRoot = document): () => void {
  const sync = (): void => {
    syncWindowHiddenState(root);
  };
  sync();
  root.addEventListener('visibilitychange', sync);
  return () => {
    root.removeEventListener('visibilitychange', sync);
  };
}
