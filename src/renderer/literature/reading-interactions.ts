export const BEFORE_READING_CHANGE = 'roc:before-reading-change';
export type ReadingChangeRequest = {projectId: string; defer: () => () => void};
let latestChange = 0;

/** Keep source editors alive until every affected surface releases its draft. */
export function requestReadingChange(projectId: string, proceed: () => void): void {
  const revision = ++latestChange;
  let remaining = 0, dispatched = false, completed = false;
  const complete = (): void => {
    if (!dispatched || remaining !== 0 || completed || event.defaultPrevented || revision !== latestChange) return;
    completed = true; proceed();
  };
  const event = new CustomEvent<ReadingChangeRequest>(BEFORE_READING_CHANGE, {cancelable: true, detail: {
    projectId,
    defer: () => {
      remaining++;
      let resumed = false;
      return () => {if (resumed) return; resumed = true; remaining--; complete();};
    }
  }});
  window.dispatchEvent(event); dispatched = true; complete();
}
