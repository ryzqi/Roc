"""Read-only independent public-cohort, SQLite and saved-observation verification."""
import hashlib
import json
import re
import sqlite3
import struct
import sys
from pathlib import Path


def sha(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode()).hexdigest()


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def read(path, expected=None):
    data = Path(path).read_bytes()
    if expected is not None:
        assert sha(data) == expected, str(path)
    return json.loads(data)


def pin(path, expected):
    with Path(path).open('rb') as stream:
        assert hashlib.file_digest(stream, 'sha256').hexdigest() == expected, str(path)


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def rows_hashes(db, table):
    def cell(value):
        if isinstance(value, bytes):
            return {'blob': sha(value), 'bytes': len(value)}
        if isinstance(value, str):
            return {'text': sha(value), 'bytes': len(value.encode())}
        return int(value) if isinstance(value, float) and value.is_integer() else value
    return sorted(sha(compact([[key, cell(row[key])] for key in row.keys()]))
                  for row in db.execute(f'SELECT * FROM {quote(table)}'))


def verify_preservation(before, after, saved_before, saved_after):
    schema = "SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    tables = [tuple(row) for row in before.execute(schema)]
    assert tables == [tuple(row) for row in after.execute(schema)], 'table schema changed'
    names = [name for name, _ in tables if name != 'research_scientific_index_generations']
    assert set(names) == set(saved_before) == set(saved_after)
    preserved = []
    for name in names:
        left, right = rows_hashes(before, name), rows_hashes(after, name)
        assert left == saved_before[name], ('before receipt', name)
        assert right == saved_after[name], ('after receipt', name)
        if not name.startswith('research_scientific_fts_'):
            assert left == right, ('changed protected table', name)
            preserved.append({'name': name, 'rows': len(left)})
    return preserved


def verify_generation(db, item, state, key, ir):
    g = db.execute('SELECT * FROM research_scientific_index_generations WHERE id=?', (item[key],)).fetchone()
    assert g is not None and g['status'] == state, ('generation status', key)
    assert g['document_id'] == item['documentId'] and g['project_id'] is None
    assert g['source_hash'] == item['sourceHash'] and g['parse_id'] == item['parseId']
    assert g['parse_hash'] == ir['identity']['parseHash']
    assert sha(g['snapshot_json']) == g['snapshot_hash']
    snapshot = json.loads(g['snapshot_json'])
    assert snapshot['paperIR'] == item['paperIR'] and snapshot['source'] == {'kind': 'library'}
    assert snapshot['embedding'] == {'configId': 'rollout-engineering', 'revision': 1,
                                     'model': 'controlled-one-hot', 'dimensions': 3}
    assert snapshot['policy']['tableTokens'] == (512 if key == 'a' else 450)
    rows = list(db.execute('SELECT * FROM research_scientific_chunks WHERE generation_id=? ORDER BY ordinal', (g['id'],)))
    assert len(rows) == g['chunk_count']
    assert sha('[' + ','.join(row['chunk_json'] for row in rows) + ']') == g['chunks_hash']
    retrieval = {}
    chunks = []
    for ordinal, row in enumerate(rows):
        c = json.loads(row['chunk_json']); chunks.append(c)
        assert row['ordinal'] == ordinal and sha(row['chunk_json']) == row['chunk_hash']
        for field, prop in [('id', 'id'), ('content', 'content'), ('embedding_text', 'embeddingText'),
                            ('document_id', 'documentId'), ('object_id', 'objectId'), ('parent_id', 'parentId')]:
            assert row[field] == c[prop]
        assert sha(c['content']) == c['contentHash'] == row['content_hash']
        assert sha(c['embeddingText']) == c['embeddingTextHash'] == row['embedding_text_hash']
        assert c['sourceLocator'] == json.loads(row['locator_json'])
        assert c['sourceLocator']['sourceHash'] == item['sourceHash']
        assert c['sourceLocator']['parseId'] == item['parseId']
        if c['retrieval']:
            retrieval[c['id']] = c
    assert len(retrieval) == g['retrievable_count']
    postings = dict(db.execute('SELECT chunk_id,content FROM research_scientific_fts WHERE generation_id=?', (g['id'],)))
    assert postings == {cid: c['embeddingText'] for cid, c in retrieval.items()}, 'FTS content'
    relations = [dict(r) for r in db.execute('SELECT chunk_id,relation_id,relation_json FROM research_scientific_chunk_relations WHERE generation_id=? ORDER BY chunk_id,relation_id', (g['id'],))]
    assert sha(compact(relations)) == g['relations_hash']
    assert {(r['chunk_id'], r['relation_id']) for r in relations} == {(c['id'], rid) for c in chunks for rid in c['relationIds']}
    original_relations = {r['id']: r for r in ir['relations']}
    assert all(json.loads(r['relation_json']) == original_relations[r['relation_id']] for r in relations)
    vectors = list(db.execute('SELECT * FROM research_scientific_embeddings WHERE generation_id=?', (g['id'],)))
    assert len(vectors) == (len(retrieval) if key in ('a', 'b') else 0)
    for vector in vectors:
        c = retrieval[vector['chunk_id']]
        assert vector['input_hash'] == c['embeddingTextHash'] and vector['input_version'] == c['inputVersion']
        assert vector['config_id'] == g['embedding_config_id'] and vector['config_revision'] == g['embedding_config_revision']
        assert vector['dimensions'] == 3 and vector['model'] == 'controlled-one-hot'
        assert sha(vector['embedding']) == vector['embedding_hash']
        assert struct.unpack('<fff', vector['embedding']) == (1.0, 0.0, 0.0)
    return len(rows)


def verify_observations(run):
    observations, events = run['observations'], run['events']
    assert len(observations) == 45 and len(events) == 135 and len(run['foreground']) == 225
    assert run['quality'] == {'recall': None, 'answerCorrectness': None, 'realProjectAcceptance': None}
    for index, item in enumerate(observations):
        assert item['failedCandidatePreserved'] and item['candidateCancelled']
        assert item['restoredGeneration'] == item['a'] and item['finalGeneration'] == item['b']
        assert item['baseline']['hits'] and item['degraded']['hits']
        assert item['degraded']['ranking']['degradation'] == 'network'
        for result in [item['baseline'], item['degraded']]:
            assert all(h['documentId'] == 'document:' + item['parseId'] for h in result['hits'])
        group = run['foreground'][index * 5:index * 5 + 5]
        for offset, f in enumerate(group):
            query = item['query'] + (' degradationprobe' if offset == 2 else '')
            assert f['queryHash'] == sha(query) and f['resultHash'] == f['returnedHash']
            assert f['sameObject'] is True and f['calls'] == 1
        assert len({group[i]['stableResultHash'] for i in [0, 1, 3, 4]}) == 1
        for offset, key in enumerate(['compared', 'degradedEvent', 'failure']):
            e = item[key]; assert e == events[index * 3 + offset]
            query = item['query'] + (' degradationprobe' if offset == 1 else '')
            assert e['queryHash'] == sha(compact(query)) and e['projectId'] == run['projectId']
            assert e['status'] == ('failed' if offset == 2 else 'compared') and e['recall'] is None
            assert e['legacy']['status'] == 'ok' and e['legacy']['ranked']
            if offset == 2:
                assert e['scientific']['error'] == 'research_scientific_fts_invalid'
            else:
                assert e['scientific']['status'] == 'ok' and e['scientific']['ranked']
                left = {r['source'] for r in e['legacy']['ranked'] if r['source']}
                right = {r['source'] for r in e['scientific']['ranked'] if r['source']}
                assert (e['overlap']['common'], e['overlap']['legacy'], e['overlap']['scientific']) == (len(left & right), len(left), len(right))
                assert e['overlap']['jaccard'] == (len(left & right) / len(left | right) if left | right else None)
                if offset == 1:
                    assert 'network' in e['scientific']['degradation']
    assert {g['generationId'] for g in run['multiple']['snapshot']['generations']} == {o['b'] for o in observations}
    assert run['multiple']['hits']


def verify(report_path):
    report = read(report_path); root = Path(report['root'])
    assert report['kind'] == 'public45-isolated-rollout-engineering-rehearsal'
    for path, digest in report['codeHashes'].items():
        pin(path, digest)
    for item in report['inputs']:
        pin(item['path'], item['sha256'])
        assert str(Path(item['path']).stat().st_mtime_ns) == item['mtimeNs']
    for item in report['copies']:
        pin(item['source'], item['sha256']); pin(item['path'], item.get('derivedSha256', item['sha256']))
        if 'derivedSha256' in item:
            original, derived = read(item['source']), read(item['path'])
            assert {k: v for k, v in original.items() if k not in ('blocks', 'quality')} == {k: v for k, v in derived.items() if k not in ('blocks', 'quality')}
    for item in report['outputs']:
        pin(item['path'], item['sha256'])
    previous = read(report['sourceReport']['path'], report['sourceReport']['sha256'])
    cohort = next(c for c in previous['cohorts'] if c['rows'] == 45)
    source_run = read(cohort['run'])
    run = read(root / 'run.json'); verify_observations(run)
    assert len(source_run['rows']) == len(run['observations']) == 45
    assert [s['paperId'] for s in source_run['rows']] == [o['paperId'] for o in run['observations']]
    before = sqlite3.connect(f'{(root / "before.db").as_uri()}?mode=ro', uri=True)
    after = sqlite3.connect(f'{(root / "research.db").as_uri()}?mode=ro', uri=True)
    before.row_factory = after.row_factory = sqlite3.Row
    try:
        for db in [before, after]:
            assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
            assert not db.execute('PRAGMA foreign_key_check').fetchall()
        preserved = verify_preservation(before, after, read(root / 'protected-before.json'), read(root / 'protected-after.json'))
        chunks = 0
        for item, original in zip(run['observations'], source_run['rows']):
            assert item['sourceHash'] == original['sourceHash']
            pin(root / 'sources' / (item['paperId'] + '.pdf'), original['sourceHash'])
            assert item['pdf']['pages'] == original['pageCount'] and item['pdf']['textItems'] > 0
            ir = read(root / item['paperIR']['path'], item['paperIR']['sha256'])
            assert ir['identity'] == item['paperIR']['identity']
            assert ir['identity']['documentId'] == item['documentId'] and ir['identity']['sourceHash'] == item['sourceHash']
            doc = after.execute('SELECT * FROM research_documents WHERE id=?', (item['documentId'],)).fetchone()
            assert doc['source_hash'] == item['sourceHash'] and doc['current_parse_id'] == item['parseId']
            assert after.execute('SELECT 1 FROM research_library_projects WHERE item_id=? AND project_id=?', (doc['library_item_id'], run['projectId'])).fetchone()
            assert not after.execute('SELECT 1 FROM research_library_projects WHERE item_id=? AND project_id=?', (doc['library_item_id'], run['foreignProjectId'])).fetchone()
            for key, state in [('a', 'retired'), ('b', 'active'), ('failed', 'failed'), ('pending', 'cancelled')]:
                chunks += verify_generation(after, item, state, key, ir)
                old = dict(before.execute('SELECT * FROM research_scientific_index_generations WHERE id=?', (item[key],)).fetchone())
                new = dict(after.execute('SELECT * FROM research_scientific_index_generations WHERE id=?', (item[key],)).fetchone())
                if key == 'pending':
                    assert old['status'] == 'building' and old['error'] is None
                    assert new['error'] == 'research_scientific_rollback_superseded'
                    old.update(status=new['status'], error=new['error'])
                assert old == new, 'unrelated generation metadata changed'
            evidence = after.execute('SELECT * FROM research_evidence WHERE id=?', (item['evidence']['id'],)).fetchone()
            assert evidence['project_id'] == run['projectId'] and evidence['excerpt'] == item['evidence']['excerpt']
            assert sha(evidence['excerpt']) == evidence['content_hash'] == item['evidence']['contentHash']
            assert after.execute('SELECT content FROM research_knowledge_chunks WHERE id=?', (evidence['chunk_id'],)).fetchone()[0] == evidence['excerpt']
            wiki = after.execute('SELECT snapshot_json FROM research_wiki_revisions WHERE page_id=? AND revision=?', (item['pageId'], item['revision']['revision'])).fetchone()
            assert json.loads(wiki[0]) == item['revision']
            match = ' OR '.join('"' + word + '"' for word in item['query'].split())
            assert after.execute('SELECT 1 FROM research_scientific_fts WHERE research_scientific_fts MATCH ? AND generation_id=? LIMIT 1', (match, item['b'])).fetchone(), 'active FTS query'
        assert after.execute('SELECT count(*) FROM research_scientific_index_generations').fetchone()[0] == 180
        assert after.execute("SELECT count(*) FROM research_scientific_index_generations WHERE status='building'").fetchone()[0] == 0
    finally:
        before.close(); after.close()
    counts = {'papers': 45, 'pages': sum(o['pdf']['pages'] for o in run['observations']), 'shadowEvents': 135,
              'compared': 90, 'expectedFailures': 45, 'retainedEvidence': 45, 'retainedWikiRevisions': 45}
    assert counts == report['counts'] and counts['pages'] == 429
    assert report['quality'] == run['quality']
    for item in report['outputs']:
        pin(item['path'], item['sha256'])
    return {'status': 'verified', 'report': str(report_path), 'reportSha256': sha(Path(report_path).read_bytes()),
            'verifierSha256': sha(Path(__file__).read_bytes()), 'counts': counts, 'generationRows': 180,
            'chunkRows': chunks, 'preservedTables': preserved, 'unchangedInputs': len(report['inputs']),
            'foregroundCalls': 225, 'quality': report['quality'],
            'limitations': ['Controlled vectors and source-text probes establish engineering behavior only.',
                            'PDF page counts agree with prior parser receipts; renderer preview is not checked.',
                            'FTS internal table repacking is excluded; authoritative postings are compared and queried.']}


if __name__ == '__main__':
    result = verify(Path(sys.argv[1]).resolve())
    with Path(sys.argv[2]).open('x') as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2); stream.write('\n')
    print(json.dumps({k: v for k, v in result.items() if k != 'preservedTables'}, ensure_ascii=False))
