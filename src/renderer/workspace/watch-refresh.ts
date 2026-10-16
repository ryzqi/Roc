/**
 * Shared watcher-refresh window for `workspace.onChanged` consumers.
 *
 * The policy is deliberately identical for the file tree and the Git panel, and it
 * is deliberately **not** a trailing debounce:
 *
 *   - the **first** event refreshes immediately, because the acceptance gate is
 *     "an external edit is visible within 200 ms" and a debounce would spend that
 *     whole budget waiting to see whether more events arrive;
 *   - events arriving inside the window are coalesced into one trailing refresh,
 *     so saving a file (which emits several events: temp file, rename, change) or
 *     a batch operation does not turn into one IPC round trip per event.
 *
 * Lives in its own module so the two consumers cannot drift apart.
 */
export const WATCH_REFRESH_WINDOW_MS = 200;
