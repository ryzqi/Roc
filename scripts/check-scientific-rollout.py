"""Negative controls for saved observations and independent SQLite preservation."""
import copy
import importlib.util
import json
import sqlite3
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location('rollout', Path(__file__).with_name('verify-scientific-rollout.py'))
v = importlib.util.module_from_spec(spec); spec.loader.exec_module(v)
report = v.read(sys.argv[1]); run = v.read(Path(report['root']) / 'run.json')
v.verify_observations(run)
checks = []


def rejects(name, operation):
    try:
        operation()
    except AssertionError:
        checks.append(name)
    else:
        raise AssertionError('accepted corruption: ' + name)


for name, mutate in [
    ('missing paper', lambda r: r['observations'].pop()),
    ('fabricated foreground identity', lambda r: r['foreground'][0].update(sameObject=False)),
    ('changed foreground content', lambda r: r['foreground'][0].update(returnedHash='0' * 64)),
    ('duplicate legacy execution', lambda r: r['foreground'][0].update(calls=2)),
    ('invented quality', lambda r: r['quality'].update(recall=1)),
    ('lost degradation', lambda r: r['observations'][0]['degraded']['ranking'].update(degradation=None)),
    ('foreign result', lambda r: r['observations'][0]['baseline']['hits'][0].update(documentId='foreign')),
    ('wrong restored generation', lambda r: r['observations'][0].update(restoredGeneration='wrong')),
    ('partial project snapshot', lambda r: r['multiple']['snapshot']['generations'].pop()),
]:
    changed = copy.deepcopy(run); mutate(changed)
    rejects(name, lambda: v.verify_observations(changed))
# Recompute both receipts after a protected business mutation: equality must still reject it.
before, after = sqlite3.connect(':memory:'), sqlite3.connect(':memory:')
before.row_factory = after.row_factory = sqlite3.Row
for db in [before, after]:
    db.executescript("CREATE TABLE research_evidence (id TEXT, excerpt TEXT); INSERT INTO research_evidence VALUES ('e1','original');")
old = {'research_evidence': v.rows_hashes(before, 'research_evidence')}
v.verify_preservation(before, after, old, old)
after.execute("UPDATE research_evidence SET excerpt='invented'")
new = {'research_evidence': v.rows_hashes(after, 'research_evidence')}
rejects('protected content changed with recomputed receipts', lambda: v.verify_preservation(before, after, old, new))
rejects('snapshot hides protected mutation', lambda: v.verify_preservation(before, after, old, old))
before.close(); after.close()
assert len(checks) == 11
print(json.dumps({'status': 'passed', 'checks': checks}))
