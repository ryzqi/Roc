import {createHash} from 'node:crypto';

export function researchCrateFixture(profileHtml) {
  const bytes = new Map([
    ['paper.pdf', Buffer.from('%PDF-synthetic-engineering-fixture')],
    ['data/混合 sample.csv', Buffer.from('group,value\ncontrol,2\n')],
    ['code/run.py', Buffer.from('print("synthetic fixture")\n')],
    ['provenance/review.json', Buffer.from('{"verification":"synthetic fixture"}\n')],
    ['ro-crate-profile.html', Buffer.from(profileHtml)]
  ]);
  const hash = value => createHash('sha256').update(value).digest('hex');
  const license = {name: 'Synthetic test license', description: 'Engineering fixture only; no real redistribution grant.', url: null};
  const work = (id, kind, paths, basedOn = []) => ({id, kind, name: `Synthetic ${id}`, description: 'Generated engineering fixture',
    version: 'test-1', url: kind === 'software' ? 'https://example.org/synthetic-software' : null,
    license, delivery: {kind: 'bundled', paths}, basedOn});
  const input = {
    publication: {profile: 'roc-research-1', version: '1.2', name: 'Synthetic research package',
      description: 'Offline engineering test, not independent scientific validation.', datePublished: '2026-11-06',
      authors: [{name: 'Synthetic Author', orcid: null}], license},
    files: [...bytes].map(([path, content]) => ({path, sha256: hash(content), size: content.length})),
    works: [work('paper', 'manuscript', ['paper.pdf'], ['result', 'restricted-reference']),
      work('result', 'result', ['data/混合 sample.csv'], ['software']), work('software', 'software', ['code/run.py']),
      {id: 'restricted-reference', kind: 'reference', name: 'Synthetic restricted article',
        description: 'Bibliographic metadata only', version: null, url: null,
        license: {name: 'Not licensed for redistribution', description: 'No grant to include original bytes', url: null},
        delivery: {kind: 'metadata_only', url: 'https://example.org/synthetic-article',
          instructions: 'Obtain independently from the rights holder.'}, basedOn: []}],
    activities: [{id: 'run-1', name: 'Synthetic experiment', status: 'completed', startedAt: '2026-11-06T00:00:00.000Z',
      endedAt: '2026-11-06T00:00:01.000Z', inputs: [], outputs: ['result'], software: 'software',
      environment: {hash: hash('synthetic-environment'), version: 'CPython synthetic',
        packages: [{name: 'synthetic-package', value: '1.0'}]}, parameters: [{name: 'iterations', value: '1'}], seed: 42,
      cost: {kind: 'unknown', reason: 'No trusted price receipt recorded'}}],
    approvals: [{artifactId: 'synthetic-manuscript', artifactVersion: hash('synthetic-artifact-version'),
      workId: 'paper', recordedAt: '2026-11-06T00:00:02.000Z', reviewPath: 'provenance/review.json'}]
  };
  return {input, bytes, hash};
}
