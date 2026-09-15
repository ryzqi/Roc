type WindowHiddenSnapshot = {
  hidden: boolean;
};

type VisibilityRoot = {
  dataset: DOMStringMap;
};

type WindowHiddenClient = {
  api: {
    window: {
      onHidden: (callback: (snapshot: WindowHiddenSnapshot) => void) => () => void;
    };
  };
};

export function applyWindowHiddenState(hidden: boolean, root: VisibilityRoot): void {
  root.dataset.windowHidden = String(hidden);
}

export function bindWindowVisibility(client: WindowHiddenClient, root: VisibilityRoot = document.documentElement): () => void {
  return client.api.window.onHidden((snapshot) => {
    applyWindowHiddenState(snapshot.hidden, root);
  });
}
