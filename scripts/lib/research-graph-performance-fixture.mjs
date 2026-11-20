/** High-degree engineering fixture: all claims cite one loaded evidence; no inferred sources. */
export function graphPerformanceFixture(count) {
  return {
    libraryItems: [],
    evidence: [{ id: 'shared', title: 'Shared evidence', locator: 'page:1', sourceType: 'file', sourceId: 'unloaded' }],
    claims: Array.from({ length: count }, (_, i) => ({ id: `c-${i}`, content: `Claim ${i}`, status: 'supported', evidenceIds: ['shared'] }))
  };
}
