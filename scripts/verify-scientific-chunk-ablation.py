"""Independent saved source/readback arithmetic. No production chunker import."""
import hashlib
import json
import pathlib
import statistics
import sys


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read(path, expected=None):
    data = pathlib.Path(path).read_bytes()
    if expected is not None:
        assert sha(data) == expected, path
    return json.loads(data)


def slice16(text, start, end):
    return text.encode('utf-16-le')[2 * start:2 * end].decode('utf-16-le')


def measure(ir, chunks, legacy):
    blocks = {b['blockId']: b for b in ir['blocks']}
    if legacy:
        parents = {c['structure']['parentId'] for c in chunks if c['structure'] and c['structure']['parentId']}
        retrieved = [c for c in chunks if c['id'] not in parents and c['content'].strip()]
        for c in chunks:
            block = blocks[c['semantic']['blockId']]
            span = c['structure']
            assert c['content'] == (slice16(block['text'], span['start'], span['end']) if span else block['text'])
        def candidates(obj):
            return [c for c in retrieved if c['semantic']['blockId'] == obj['blockId']]
        def texts(c):
            return [c['content']]
    else:
        retrieved = [c for c in chunks if c['retrieval']]
        objects = {o['id']: o for key in ['blocks', 'tables', 'equations', 'figures', 'algorithms'] for o in ir[key]}
        objects.update({c['id']: c for t in ir['tables'] for c in t['cells']})
        objects.update({s['id']: s for a in ir['algorithms'] for s in a['steps']})
        assert len({c['id'] for c in chunks}) == len(chunks)
        for c in chunks:
            assert all(c[key] == ir['identity'][key] for key in ['paperId', 'documentId', 'parseId'])
            assert c['contentHash'] == sha(c['content'].encode())
            assert c['embeddingTextHash'] == sha(c['embeddingText'].encode())
            original = objects[c['objectId']]['sourceLocator']
            assert {k:v for k,v in c['sourceLocator'].items() if k != 'textSpan'} == {k:v for k,v in original.items() if k != 'textSpan'}
            for part in c['sources']:
                obj = objects[part['locator']['objectId']]
                assert {k:v for k,v in part['locator'].items() if k != 'textSpan'} == {k:v for k,v in obj['sourceLocator'].items() if k != 'textSpan'}
                field = part['field']
                if field in ['text', 'caption', 'context', 'variable']:
                    span = part['locator'].get('textSpan')
                    value = slice16(obj['text'], span['start'], span['end']) if span else obj['text']
                elif field in ['cell', 'header', 'step']:
                    value = obj['text']
                elif field == 'latex':
                    value = obj['data']['rawLatex'] if obj['data']['rawLatex'] is not None else blocks[obj['blockId']]['text']
                elif field == 'html-caption':
                    value = obj['data']['caption']
                elif field == 'footnote':
                    assert part['text'] in obj['data']['footnotes']
                    continue
                else:
                    raise AssertionError(field)
                assert part['text'] == value
            obj, selection = objects[c['objectId']], c['selection']
            kind = c['chunkType']
            if kind in ['paragraph', 'caption']:
                block = blocks[obj['blockId']]
                span = selection.get('span')
                expected = slice16(block['text'], span['start'], span['end']) if span else block['text']
            elif kind in ['table', 'table_row_group']:
                rows = selection.get('rows', [r['index'] for r in obj['data']['rows']])
                cells = [(r['index'], cell) for r in obj['data']['rows'] for cell in r['cells']
                         if any(r['index'] <= row < r['index'] + cell['rowSpan'] for row in rows)]
                expected = '\n'.join(f'Row {r}, column {cell["column"]}, span {cell["rowSpan"]}x{cell["colSpan"]}: {cell["text"]}'
                                     for r, cell in cells)
                source_ids = {p['locator']['objectId'] for p in c['sources'] if p['field'] in ['cell', 'header']}
                original_to_ir = {cell['originalId']: cell['id'] for cell in obj['cells']}
                assert all(original_to_ir[cell['id']] in source_ids for _, cell in cells)
                assert all(original_to_ir[cell_id] in source_ids for col in obj['data']['columns'] for cell_id in col['headerCellIds'])
            elif kind == 'equation':
                expected = obj['data']['rawLatex'] if obj['data']['rawLatex'] is not None else blocks[obj['blockId']]['text']
                assert expected in c['embeddingText']
            elif kind == 'figure':
                expected = '\n'.join(p['text'] for p in c['sources'])
            elif kind == 'algorithm':
                expected = '\n'.join(objects[s]['text'] for s in selection['steps']) if 'steps' in selection else obj['text']
            else:
                raise AssertionError(kind)
            assert c['content'] == expected
        def candidates(obj):
            return [c for c in retrieved if c['sourceLocator']['blockId'] == obj['blockId']]
        def texts(c):
            return [c['content']] + [p['text'] for p in c['sources']]
    cells = [(t, c['text']) for t in ir['tables'] for c in t['cells'] if c['text'].strip()]
    equations = [(e, e['data']['rawLatex'] if e['data']['rawLatex'] is not None else blocks[e['blockId']]['text']) for e in ir['equations']]
    equations = [(o, text) for o, text in equations if text.strip()]
    captions = [(f, c['evidence']['text']) for f in ir['figures'] for c in f['data']['captions']
                if c['status'] == 'linked' and c['evidence']['text'].strip()]
    result = {'retrievalChunks': len(retrieved)}
    for key, items in [('tableCellTextCoverage', cells), ('wholeEquationTextCoverage', equations), ('linkedFigureCaptionCoverage', captions)]:
        found = sum(any(text in value for c in candidates(obj) for value in texts(c)) for obj, text in items)
        result[key] = {'matched': found, 'applicable': len(items), 'value': found / len(items) if items else None}
    return result


def main():
    report_path = pathlib.Path(sys.argv[1])
    report = read(report_path)
    protocol = read(report['protocol']['path'], report['protocol']['sha256'])
    source_report = read(protocol['sourceReport']['path'], protocol['sourceReport']['sha256'])
    original_rows = read(pathlib.Path(source_report['root']) / 'trial-0.json')
    assert protocol['irRoot'] == source_report['root']
    assert protocol['selection'] == [{k: row[k] for k in protocol['selection'][i]} for i, row in enumerate(original_rows)]
    for pin in protocol['inputs']:
        path = pathlib.Path(pin['path'])
        assert sha(path.read_bytes()) == pin['sha256']
        assert str(path.stat().st_mtime_ns) == pin['mtimeNs']
    for path, digest in protocol['codeHashes'].items():
        assert sha(pathlib.Path(path).read_bytes()) == digest
    assert len(report['trials']) == protocol['repeats'] == 3
    assert list(protocol['arms']) == ['legacy', 'structured512', 'structured450']
    outputs, metrics, samples = {}, [], {arm: [] for arm in protocol['arms']}
    selected = protocol['selection']
    for repeat, trial in enumerate(report['trials']):
        records = read(trial['path'], trial['sha256'])
        assert len(records) == len(selected)
        scored = []
        for i, (row, selection) in enumerate(zip(records, selected)):
            assert row['ordinal'] == i and row['sourceHash'] == selection['sourceHash']
            assert row['status'] == selection['status'] and row['failure'] == selection['failure']
            if row['status'] != 'parsed':
                assert row['arms'] is None and row['failure'] is not None
                scored.append({'ordinal': i, 'status': row['status'], 'arms': None})
                continue
            receipt = selection['receipt']
            ir = read(pathlib.Path(protocol['irRoot']) / receipt['path'], receipt['sha256'])
            read(pathlib.Path(protocol['irRoot']) / selection['contentPath'], receipt['identity']['parseHash'])
            assert set(row['arms']) == set(protocol['arms'])
            values = {}
            for name, arm in row['arms'].items():
                assert protocol['createdAt'] <= arm['startedAt'] <= report['completedAt']
                data = pathlib.Path(arm['path']).read_bytes()
                assert sha(data) == arm['sha256'] and len(data) == arm['bytes']
                assert arm['elapsedMs'] >= 0
                if repeat == 0:
                    outputs[i, name] = data
                else:
                    assert data == outputs[i, name]
                values[name] = measure(ir, json.loads(data), name == 'legacy')
                samples[name].append({'elapsedMs': arm['elapsedMs'], 'outputBytes': arm['bytes']})
            scored.append({'ordinal': i, 'status': 'parsed', 'arms': values})
        metrics.append(scored)
    assert metrics[0] == metrics[1] == metrics[2]
    totals = {}
    for name in protocol['arms']:
        total = {'retrievalChunks': sum(r['arms'][name]['retrievalChunks'] for r in metrics[0] if r['arms'])}
        for key in protocol['metrics'][1:]:
            matched = sum(r['arms'][name][key]['matched'] for r in metrics[0] if r['arms'])
            applicable = sum(r['arms'][name][key]['applicable'] for r in metrics[0] if r['arms'])
            total[key] = {'matched': matched, 'applicable': applicable, 'value': matched / applicable if applicable else None}
        total['resources'] = {'samples': len(samples[name]), 'totalElapsedMs': sum(s['elapsedMs'] for s in samples[name]),
                              'medianSourceElapsedMs': statistics.median(s['elapsedMs'] for s in samples[name]),
                              'totalOutputBytes': sum(s['outputBytes'] for s in samples[name])}
        totals[name] = total
    result = {'version': 1, 'status': 'verified-component-observation', 'report': {'path': str(report_path), 'sha256': sha(report_path.read_bytes())},
              'sources': len(selected), 'failedSources': sum(r['status'] != 'parsed' for r in selected),
              'repeats': 3, 'totals': totals, 'perSource': metrics[0], 'scientificQuality': False,
              'fullSystemBenefitEstablished': False, 'limitations': protocol['limitations']}
    pathlib.Path(sys.argv[2]).write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({k:v for k,v in result.items() if k != 'perSource'}))


if __name__ == '__main__':
    main()
