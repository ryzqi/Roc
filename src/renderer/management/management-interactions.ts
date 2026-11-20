export const BEFORE_MANAGEMENT_EDITOR_CHANGE = 'roc:before-management-editor-change';
export type ManagementEditorChange = { defer: () => () => void };
let latestChange = 0;

/** Local selectors and native shell entries must release transient management editors together. */
export function requestManagementEditorChange(proceed: () => void): void {
  const revision = ++latestChange;
  let remaining = 0, dispatched = false, completed = false;
  const complete = (): void => {
    if (!dispatched || remaining !== 0 || completed || event.defaultPrevented || revision !== latestChange) return;
    completed = true;
    proceed();
  };
  const event = new CustomEvent<ManagementEditorChange>(BEFORE_MANAGEMENT_EDITOR_CHANGE, {
    cancelable: true,
    detail: {
      defer: () => {
        remaining++;
        let resumed = false;
        return () => {
          if (resumed) return;
          resumed = true;
          remaining--;
          complete();
        };
      }
    }
  });
  window.dispatchEvent(event);
  dispatched = true;
  complete();
}
