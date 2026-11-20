"""Corrupt saved real outputs to exercise the independent source verifier."""
import copy
import importlib.util
import json
import pathlib
import sys
import tempfile

spec = importlib.util.spec_from_file_location('ablation', pathlib.Path(__file__).with_name('verify-scientific-chunk-ablation.py'))
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)
report = verifier.read(sys.argv[1])
protocol = verifier.read(report['protocol']['path'], report['protocol']['sha256'])
rows = verifier.read(report['trials'][0]['path'], report['trials'][0]['sha256'])
cases = []


def rejects(name, operation):
    try:
        operation()
    except AssertionError:
        cases.append(name)
    else:
        raise AssertionError(f'corruption accepted: {name}')


for selection, row in zip(protocol['selection'], rows):
    if row['status'] != 'parsed':
        continue
    receipt = selection['receipt']
    ir = verifier.read(pathlib.Path(protocol['irRoot']) / receipt['path'], receipt['sha256'])
    chunks = verifier.read(row['arms']['structured512']['path'], row['arms']['structured512']['sha256'])
    equations = [i for i, c in enumerate(chunks) if c['chunkType'] == 'equation']
    tables = [i for i, c in enumerate(chunks) if c['chunkType'] == 'table' and any(p['field'] == 'cell' for p in c['sources'])]
    if not equations or not tables:
        continue
    verifier.measure(ir, chunks, False)
    changed = copy.deepcopy(chunks)
    changed[equations[0]]['content'] = 'invented equation'
    changed[equations[0]]['contentHash'] = verifier.sha(b'invented equation')
    rejects('invented content with recomputed hash', lambda: verifier.measure(ir, changed, False))
    changed = copy.deepcopy(chunks)
    changed[equations[0]]['sourceLocator']['page'] = 9999
    rejects('changed original locator', lambda: verifier.measure(ir, changed, False))
    changed = copy.deepcopy(chunks)
    changed[tables[0]]['sources'] = [p for p in changed[tables[0]]['sources'] if p['field'] not in ['cell', 'header']]
    rejects('missing original table cells', lambda: verifier.measure(ir, changed, False))
    rejects('duplicated chunk', lambda: verifier.measure(ir, chunks + [chunks[0]], False))
    changed = copy.deepcopy(chunks)
    changed[0]['documentId'] = 'foreign-document'
    rejects('foreign document identity', lambda: verifier.measure(ir, changed, False))
    with tempfile.TemporaryDirectory(prefix='roc-ablation-corruption-') as root:
        path = pathlib.Path(root) / 'receipt.json'
        path.write_text('{}')
        rejects('changed saved receipt', lambda: verifier.read(path, '0' * 64))
    break
assert len(cases) == 6, 'saved corpus lacks required original objects'
print(json.dumps({'status': 'passed', 'checks': cases}))
