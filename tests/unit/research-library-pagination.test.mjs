import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
before(async () => {api = await loadResearchTestApi();});
after(() => api?.dispose());

function entries(count, prefix = 'Paged paper') {
  return Array.from({length: count}, (_, index) => {
    const metadata = {id: `${prefix}-${index}`, source: 'local', externalId: `${prefix}-${index}`, doi: null,
      title: `${prefix} ${index}`, authors: ['Fixture Author'], abstract: null, publishedYear: 2026,
      citationCount: null, url: null, openAccessUrl: null,
      importedAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z'};
    return {metadata, bibliography: {...api.bibliographyFromRecord(metadata, new Set()), citationKey: `fixture${index}`}};
  });
}
const request = projectId => ({projectId, query: '', includeArchived: false, limit: 200, cursor: null});

test('library keyset pages traverse more than 200 rows with tied timestamps and preserve the legacy contract', async () => {
  const f = createResearchFixture(api);
  try {
    const imported = f.repository.library.import(entries(437), f.project.id, {flush: false, notify: false}).items;
    const first = f.repository.library.listPage(request(f.project.id));
    assert.equal(first.items.length, 200);
    assert.equal(first.total, 437);
    assert.equal(first.hasMore, true);
    assert.deepEqual(first.nextCursor, {updatedAt: first.items.at(-1).updatedAt, id: first.items.at(-1).id});
    const second = f.repository.library.listPage({...request(f.project.id), cursor: first.nextCursor});
    const third = f.repository.library.listPage({...request(f.project.id), cursor: second.nextCursor});
    assert.equal(second.items.length, 200);
    assert.equal(third.items.length, 37);
    assert.equal(third.total, 437);
    assert.equal(third.hasMore, false);
    assert.equal(third.nextCursor, null);
    const ids = [...first.items, ...second.items, ...third.items].map(item => item.id);
    assert.deepEqual(ids, imported.map(item => item.id).sort());
    assert.deepEqual(f.repository.library.list(request(f.project.id)), first.items);
    assert.deepEqual(f.repository.library.listPage({...request(f.project.id), cursor: {updatedAt: '1900', id: 'end'}}),
      {items: [], total: 437, hasMore: false, nextCursor: null});
  } finally {await f.close();}
});

test('pagination counts and filters the complete library by project, archive, literal query and citation key', async () => {
  const f = createResearchFixture(api);
  try {
    const imported = f.repository.library.import(entries(205), f.project.id, {flush: false, notify: false}).items;
    f.repository.library.import(entries(3, 'Other project'), null, {flush: false, notify: false});
    const special = entries(1, 'Literal 100%_\\')[0];
    special.bibliography.citationKey = 'uniqueCitationMatch';
    const [item] = f.repository.library.import([special], f.project.id, {flush: false, notify: false}).items;
    f.repository.library.archive(imported[0].id, imported[0].revision, true);
    assert.equal(f.repository.library.listPage(request(f.project.id)).total, 205);
    assert.equal(f.repository.library.listPage({...request(f.project.id), includeArchived: true}).total, 206);
    assert.equal(f.repository.library.listPage(request(null)).total, 208);
    for (const query of ['100%_\\', 'uniqueCitationMatch']) {
      const page = f.repository.library.listPage({...request(f.project.id), query, limit: 1});
      assert.deepEqual(page.items.map(row => row.id), [item.id]);
      assert.equal(page.total, 1); assert.equal(page.hasMore, false); assert.equal(page.nextCursor, null);
    }
    assert.equal(f.repository.library.listPage({...request(f.project.id), query: 'Other project'}).total, 0);
    assert.throws(() => f.repository.library.listPage(request('missing-project')), /research_project_not_found/);
  } finally {await f.close();}
});

test('keyset continuation does not shift when an earlier row is archived or a new row is inserted', async () => {
  const f = createResearchFixture(api);
  try {
    f.repository.library.import(entries(230), f.project.id, {flush: false, notify: false});
    const first = f.repository.library.listPage(request(f.project.id));
    const expectedTail = f.repository.library.listPage({...request(f.project.id), cursor: first.nextCursor}).items;
    const previous = first.items.at(-1);
    f.repository.library.archive(previous.id, previous.revision, true);
    const [inserted] = f.repository.library.import(entries(1, 'New arrival'), f.project.id, {flush: false, notify: false}).items;
    f.db.prepare('UPDATE research_library SET updated_at = ? WHERE id = ?').run('2026-11-23T00:00:00.000Z', inserted.id);
    const next = f.repository.library.listPage({...request(f.project.id), cursor: first.nextCursor});
    assert.deepEqual(next.items, expectedTail);
    assert.equal(next.total, 230);
    assert.equal(next.hasMore, false);
    assert.equal(f.repository.library.listPage(request(f.project.id)).items[0].id, inserted.id);
  } finally {await f.close();}
});
