// Synthetic pilot tasks. Six distinct inputs per family; no private papers or online APIs.
const families = {
  retrieval: ['中英混合', 'duplicate-doi', 'empty-page', 'first-page', 'second-page', 'last-page'],
  evidence: ['page-span', 'table-number', 'conflict', 'deleted-source', 'missing-source', 'unicode'],
  revision: ['local-edit', 'preserve-words', 'caption', 'bib-key', 'scope', 'unchanged'],
  experiment: ['sum', 'mean', 'missing-value', 'negative', 'zero', 'decimal'],
  export: ['valid-cite', 'dangling-cite', 'comment', 'verbatim', 'nocite-all', 'multi-cite'],
  long: ['two-turns', 'three-turns', 'constraint', 'checkpoint', 'resume', 'deduplicate'],
  control: ['event-cursor', 'reconnect', 'cancel-before', 'cancel-during', 'queue-close', 'queue-overflow'],
  untrusted: ['paper-data-roundtrip', 'other-project', 'traversal', 'absolute-path', 'unknown-tool', 'malformed-unbound-call']
};
export const scenarios = Object.entries(families).flatMap(([family, cases]) =>
  cases.map((variant, index) => ({ id: `${family}-${variant}`, family, variant, index })));
