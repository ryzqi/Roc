/**
 * Shared literature-hub types (P5).
 *
 * A module of its own because three files need these labels and importing them
 * from `LiteratureHubView` would make the dialog and the store depend on the view
 * that renders them (and would be a genuine cycle: the hub imports the dialog).
 *
 * The sub-view is **component state**, not a URL parameter: adding `?literature=`
 * would have meant extending the route contract and its round-trip
 * tests for a selector the legacy shell also kept in component state, and no P5 gate
 * needs a deep link into a sub-view. Registered in the phase's deviation table.
 */

export type LiteratureSubView = 'reader' | 'rag' | 'wiki' | 'graph';

/** The import dialog's tabs; `?import=`-style deep links are deliberately absent. */
export type ImportTabRequest = 'document' | 'doi' | 'bibliography' | 'manual' | 'search';
