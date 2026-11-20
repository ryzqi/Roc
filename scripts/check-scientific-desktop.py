"""Read-only, standard-library source/SQLite verification of desktop receipts."""
import hashlib
import json
import copy
from pathlib import Path
import sqlite3
import sys
import tempfile


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def dump(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def fingerprint(db, table):
    assert table.replace('_', '').isalnum()
    columns = [r[1] for r in db.execute(f'PRAGMA table_info("{table}")')]
    h = hashlib.sha256((dump(['rowid'] + columns) + '\n').encode())
    count = 0
    for row in db.execute(f'SELECT rowid,* FROM "{table}" ORDER BY rowid'):
        encoded = []
        for v in row:
            if isinstance(v, bytes):
                encoded.append(['blob', v.hex()])
            elif isinstance(v, int):
                encoded.append(['integer', str(v)])
            elif isinstance(v, str):
                encoded.append(['string', v])
            elif v is None:
                encoded.append(['object', None])
            else:
                encoded.append(['number', v])
        h.update((dump(encoded) + '\n').encode())
        count += 1
    return {'count': count, 'sha256': h.hexdigest(), 'columns': columns}


def verify(path):
    report = json.loads(Path(path).read_text())
    assert report['status'] == 'Verified passing'
    receipt_file = report['receipt']
    assert sha(receipt_file['path']) == receipt_file['sha256']
    receipt = json.loads(Path(receipt_file['path']).read_text())
    assert sha('scripts/verify-scientific-desktop.mjs') == report['scriptHash']
    assert sha(receipt['launcher']['path']) == receipt['launcher']['sha256']
    assert sha(receipt['sourceRun']['path']) == receipt['sourceRun']['sha256']
    seed = json.loads(Path(receipt['sourceRun']['path']).read_text())
    assert sha(receipt['sourceReport']['path']) == receipt['sourceReport']['sha256']
    assert sha(Path(receipt['root']) / 'prepared.db') == receipt['preparedHash']
    assert report['quality'] == {'recall': None, 'answerCorrectness': None, 'realProjectAcceptance': None}
    assert report['errors'] == []
    assert report['before'] == report['after']
    assert set(report['after']) == {'research_documents', 'research_document_parses',
        'research_evidence', 'research_evidence_source_metadata', 'research_evidence_source_locators',
        'research_wiki_revisions', 'research_scientific_chunks', 'research_scientific_embeddings'}
    assert len(report['rows']) == len(seed['observations']) == 45
    assert sum(r['pageCount'] for r in report['rows']) == 429
    db = sqlite3.connect('file:' + receipt['database'] + '?mode=ro', uri=True)
    assert sha(report['baseline']['path']) == report['baseline']['sha256']
    before = sqlite3.connect('file:' + report['baseline']['path'] + '?mode=ro', uri=True)
    prepared = sqlite3.connect('file:' + str(Path(receipt['root']) / 'prepared.db') + '?mode=ro', uri=True)
    try:
        assert db.execute('PRAGMA integrity_check').fetchall() == [('ok',)]
        assert db.execute('PRAGMA foreign_key_check').fetchall() == []
        for table, expected in report['after'].items():
            assert fingerprint(db, table) == fingerprint(before, table) == expected, table
            if table in ('research_wiki_revisions', 'research_scientific_chunks'):
                # Prior failed startup trials appended derived rows. Preserve every
                # original row including its rowid; no history may be rewritten.
                for old in prepared.execute(f'SELECT rowid,* FROM "{table}"'):
                    assert db.execute(f'SELECT rowid,* FROM "{table}" WHERE rowid=?', (old[0],)).fetchone() == old, table
            else:
                assert fingerprint(prepared, table) == expected, table
        for row, source in zip(report['rows'], seed['observations']):
            assert row['paperId'] == source['paperId']
            assert row['documentId'] == source['documentId'] and row['parseId'] == source['parseId']
            assert row['pageCount'] == source['pdf']['pages']
            assert row['bytes']['sha256'] == source['sourceHash']
            assert row['raster']['width'] > 0 and row['raster']['height'] > 0
            assert row['raster']['label'] == '原 PDF 第 1 页'
            assert sha(row['screenshot']['path']) == row['screenshot']['sha256']
            assert Path(row['screenshot']['path']).read_bytes().startswith(b'\x89PNG\r\n\x1a\n')
            assert row['legacy']['hits'] and row['legacy']['ranking']['degradation'] in ('network', 'provider_unavailable')
            assert all(h['documentId'] == 'document:' + source['parseId'] for h in row['legacy']['hits'])
            for key, generation in [('scientific', source['b']), ('rolledBack', source['a'])]:
                result = row[key]
                assert result['hits']
                assert [g['generationId'] for g in result['snapshot']['generations']] == [generation]
                assert all(h['documentId'] == source['documentId'] and h['generationId'] == generation for h in result['hits'])
            active = db.execute("SELECT id FROM research_scientific_index_generations WHERE document_id=? AND status='active'", (source['documentId'],)).fetchall()
            assert active == [(source['b'],)]
            assert db.execute('SELECT project_id,parse_id,source_hash FROM research_scientific_index_generations WHERE id=?',
                              (source['b'],)).fetchone() == (None, source['parseId'], source['sourceHash'])
            document = db.execute('SELECT source_path,source_hash,size,current_parse_id FROM research_documents WHERE id=?', (source['documentId'],)).fetchone()
            assert document[1:] == (source['sourceHash'], row['bytes']['size'], source['parseId'])
            assert sha(Path(receipt['libraryRoot']) / document[0]) == source['sourceHash']
            assert row['revisionHash'] == hashlib.sha256(dump(source['revision']).encode()).hexdigest()
        assert len(report['multiple']['snapshot']['generations']) == 45
        assert set(g['generationId'] for g in report['multiple']['snapshot']['generations']) == set(r['b'] for r in seed['observations'])
        assert report['multiple']['hits']
    finally:
        db.close()
        before.close()
        prepared.close()
    assets = [p for p in receipt['copies'] if p['target'].startswith(receipt['libraryRoot'] + '/')]
    for asset in assets:
        assert sha(asset['target']) == sha(asset['source']) == asset['sha256'], asset['target']
        assert str(Path(asset['source']).stat().st_mtime_ns) == asset['mtimeNs']
    return {'status': 'Verified passing', 'papers': 45, 'pages': 429, 'sourceFilesUnchanged': len(assets),
            'preservedTables': list(report['after']), 'reportSha256': sha(path)}


def negative_controls(path):
    original = json.loads(Path(path).read_text())
    mutations = {
        'missing_paper': lambda r: r['rows'].pop(),
        'invented_quality': lambda r: r['quality'].update(answerCorrectness=1),
        'missing_preserved_table': lambda r: (r['before'].pop('research_evidence'), r['after'].pop('research_evidence')),
        'wrong_pdf_size': lambda r: r['rows'][0]['bytes'].update(size=1),
        'wrong_legacy_document': lambda r: r['rows'][0]['legacy']['hits'][0].update(documentId='foreign'),
        'wrong_rollback_generation': lambda r: r['rows'][0]['rolledBack']['snapshot']['generations'][0].update(generationId='foreign'),
        'wrong_revision': lambda r: r['rows'][0].update(revisionHash='0' * 64),
    }
    with tempfile.TemporaryDirectory(prefix='roc-desktop-guards-') as directory:
        for name, mutate in mutations.items():
            candidate = copy.deepcopy(original)
            mutate(candidate)
            target = Path(directory) / (name + '.json')
            target.write_text(dump(candidate))
            try:
                verify(target)
            except AssertionError:
                continue
            raise AssertionError('accepted_negative_control:' + name)
    return list(mutations)


if __name__ == '__main__':
    result = verify(sys.argv[1])
    result['negativeControls'] = negative_controls(sys.argv[1])
    if len(sys.argv) > 2:
        with Path(sys.argv[2]).open('x') as out:
            json.dump(result, out, indent=2)
            out.write('\n')
    print(json.dumps(result))
