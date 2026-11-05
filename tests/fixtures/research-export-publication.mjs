/** Explicit synthetic permissions for engineering tests; no real scientific or legal declaration. */
export function syntheticExportPublicationReview(candidates, {metadataOnly = () => false} = {}) {
  const license = {name: 'Synthetic fixture permission',
    description: 'Explicit permission to redistribute this task-created synthetic engineering fixture.', url: null};
  return {
    sourceHash: candidates.sourceHash,
    publication: {profile: 'roc-research-1', version: '1.2', name: 'Synthetic reproducibility fixture',
      description: 'Task-created engineering data and code, not independently validated scientific research.',
      datePublished: '2026-11-06', authors: [{name: 'Synthetic fixture author', orcid: null}], license},
    resources: candidates.resources.map(candidate => ({
      source: structuredClone(candidate.source),
      kind: candidate.role === 'program' ? 'software' : candidate.role === 'figure' ? 'figure' :
        candidate.role === 'output' ? 'result' : 'dataset',
      name: candidate.source.path, description: 'Task-created synthetic engineering resource.', license,
      version: candidate.role === 'program' ? 'synthetic-fixture-1' : null,
      url: candidate.role === 'program' ? 'https://example.org/synthetic-fixture-code' : null,
      delivery: metadataOnly(candidate) ? {kind: 'metadata_only', url: null,
        instructions: 'Obtain the task-created synthetic input separately; redistribution is withheld for this test.'} : {kind: 'bundled'}
    })),
    references: candidates.references.map(reference => ({
      id: reference.id, name: reference.name, description: 'Recorded source metadata; original literature is not redistributed.',
      version: null, url: reference.url, license: {name: 'Metadata only',
        description: 'No permission is asserted to redistribute the original reference.', url: null},
      instructions: 'Consult the original source and its access conditions separately.'
    }))
  };
}
