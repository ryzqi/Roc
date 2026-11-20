"""Read-only independent checks of paired parser receipts and saved bytes."""
import hashlib
import json
import math
from pathlib import Path
import subprocess
import sys


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read(path):
    return json.loads(path.read_bytes())


if sys.argv[1] == '--retrieval':
    original_path, repeat_path = (Path(value) for value in sys.argv[2:])
    original, repeat = read(original_path), read(repeat_path)
    protocol_path = Path('docs/research-performance-protocol.json')
    protocol = read(protocol_path)['retrieval']
    assert original['protocolSha256'] == digest(protocol_path.read_bytes())
    assert original['recipe'] == protocol
    assert [scale['chunkCount'] for scale in original['scales']] == protocol['scales']
    assert repeat['chunkCount'] == 1000000
    assert repeat['sourceSha256'] == original['scales'][-1]['sourceSha256']
    previous_rows = {(row['projectId'], row['query'], row['cache']): row
                     for row in original['scales'][-1]['rows']}
    for row in repeat['rows']:
        previous = previous_rows[(row['projectId'], row['query'], row['cache'])]
        for field in ['hitsSha256', 'rankingInputHash']:
            assert {sample[field] for sample in row['samples']} == {
                sample[field] for sample in previous['samples']}
    selected = original['scales'][:-1] + [repeat]
    selected_rows = []
    for scale in original['scales'] + [repeat]:
        assert len(scale['rows']) == 8
        identities = set()
        for row in scale['rows']:
            identities.add((row['projectId'], row['query'], row['cache']))
            samples = row['samples']
            assert len(samples) == protocol['samples'] == 20
            assert len({sample['hitsSha256'] for sample in samples}) == 1
            assert len({sample['rankingInputHash'] for sample in samples}) == 1
            for metric, summary in row['summary'].items():
                values = sorted(sample[metric] for sample in samples)
                assert all(math.isfinite(value) and value >= 0 for value in values)
                assert summary == dict(samples=20, p50=values[9], p95=values[18])
            exceeded = [key for key in ['ftsMs', 'vectorMs', 'totalMs']
                        if row['summary'][key]['p95'] > protocol['p95TargetsMs'][key]]
            assert exceeded == row['targetExceeded']
            if any(scale is chosen for chosen in selected):
                assert not exceeded, (scale['chunkCount'], row['query'], exceeded)
                selected_rows.append({'chunks': scale['chunkCount'], 'project': row['projectId'],
                                      'query': row['query'], 'cache': row['cache'],
                                      'p95Ms': row['summary']['totalMs']['p95']})
        assert identities == {(project, query, cache) for project in [None, 'project-0']
                              for query in protocol['queries']
                              for cache in ['connection-cold', 'repeated-connection']}
    print(json.dumps({'status': 'Verified passing', 'selectedSamples': len(selected_rows) * 20,
                      'preservedContaminatedSamples': 160, 'rows': selected_rows,
                      'originalReport': digest(original_path.read_bytes()),
                      'repeatReport': digest(repeat_path.read_bytes())}))
    sys.exit(0)


if sys.argv[1] == '--sustained':
    before, after = (Path(value).resolve() for value in sys.argv[2:])
    for path in [before, after]:
        report = read(path / 'report.json')
        assert report['kind'] == 'scientific-sustained-ocr'
        assert report['fixture']['pages'] == 100
        assert report['fixture']['tailPages'] == 40
        assert report['fixture']['rssScreenGrowthBytes'] == 256 * 1024 * 1024
        assert report['fixture']['rssScreenSlopeBytesPerPage'] == 1024 * 1024
        samples = report['scenarios'][0]['samples']
        assert len(samples) == 100
        tail = [row['rss'] for row in samples[-40:]]
        mean = sum(tail) / 40
        slope = sum((i - 19.5) * (rss - mean) for i, rss in enumerate(tail)) / sum((i - 19.5)**2 for i in range(40))
        growth = tail[-1] - tail[0]
        observations = report['observations']
        assert growth == observations['tailGrowthBytes']
        assert math.isclose(slope, observations['tailSlopeBytesPerPage'], abs_tol=1e-6)
        assert observations['boundedGrowthScreenPassed'] == (growth <= 256 * 1024 * 1024 and slope <= 1024 * 1024)
        assert digest((path / 'scanned-100.pdf').read_bytes()) == report['fixture']['sourceHash']
    assert read(after / 'report.json')['observations']['boundedGrowthScreenPassed']
    for name in ['scanned-100.pdf', 'parsed.json']:
        assert (before / name).read_bytes() == (after / name).read_bytes()
    def inventory(path):
        return {str(p.relative_to(path / 'output')): digest(p.read_bytes())
                for p in (path / 'output').rglob('*') if p.is_file()}
    assert inventory(before) == inventory(after)
    print(json.dumps({'status': 'Verified passing', 'identicalArtifacts': len(inventory(after)),
                      'beforeReport': digest((before / 'report.json').read_bytes()),
                      'afterReport': digest((after / 'report.json').read_bytes())}))
    sys.exit(0)

root = Path(sys.argv[1]).resolve()
report = read(root / 'report.json')
assert report['kind'] == 'scientific-resource-pairs'
assert report['fixture']['trials'] == 3
assert report['source']['lockSha256'] == digest(Path('pnpm-lock.yaml').read_bytes())
assert len(report['scenarios']) == 4
all_rows = []
for scenario in report['scenarios']:
    samples = scenario['samples']
    assert len(samples) == 3
    assert {row['trial'] for row in samples} == {0, 1, 2}
    for row in samples:
        directory = root / f"{row['scenario']}-{row['trial']}-{row['variant']}"
        receipt = read(directory / 'receipt.json')
        assert row == {**receipt, 'trial': row['trial']}
        parsed_bytes = (directory / 'parsed.json').read_bytes()
        parsed = json.loads(parsed_bytes)
        assert parsed['sourceHash'] == row['sourceHash'] == report['fixture']['sourceHashes'][row['scenario']]
        assert parsed['pageCount'] == row['pages']
        assert row['retained'] == 0 and row['created'] == row['released']
        assert row['variant'] in ('before', 'after')
        for name, expected in row['sourceHashes'].items():
            data = (subprocess.check_output(['git', 'show', f"{report['fixture']['baseline']}:{name}"])
                    if row['variant'] == 'before' else Path(name).read_bytes())
            assert digest(data) == expected, name
        files = {str(path.relative_to(directory / 'output')): digest(path.read_bytes())
                 for path in (directory / 'output').rglob('*') if path.is_file()}
        assert files == {item['path']: item['sha256'] for item in row['artifacts']}
        # Preserve JS insertion order and UTF-8 JSON serialization used by the runner.
        behavior = json.dumps({'parsed': parsed, 'artifacts': row['artifacts']},
                              ensure_ascii=False, separators=(',', ':')).encode()
        assert digest(behavior) == row['behaviorSha256']
        stages = read(directory / 'stages.json')
        assert all(a['elapsedMs'] <= b['elapsedMs'] for a, b in zip(stages, stages[1:]))
        stage = 'native-text' if row['scenario'] == 'native-400' else 'ocr-inference'
        pages = [value for value in stages if value['stage'] == stage]
        assert len(pages) == row['pages']
        tail = pages[-100:]
        assert tail[-1]['rss'] - tail[0]['rss'] == row['tailGrowthBytes']
        assert max(value['rss'] for value in stages) <= row['peakRssBytes']
        assert row['elapsedMs'] >= stages[-1]['elapsedMs']
        all_rows.append(row)
    for metric, summary in scenario['summary'].items():
        values = sorted(row[metric] for row in samples)
        assert summary == dict(count=3, min=values[0], p50=values[1], p95=values[2], max=values[2])

for name, maximum_ratio in [('native-400', 1.2), ('scanned-3', 1.5)]:
    selected = [row for row in all_rows if row['scenario'] == name]
    assert len({row['behaviorSha256'] for row in selected}) == 1
    medians = {variant: sorted(row['elapsedMs'] for row in selected if row['variant'] == variant)[1]
               for variant in ('before', 'after')}
    assert medians['after'] / medians['before'] <= maximum_ratio
    source = root / ('native-400.pdf' if name == 'native-400' else 'scanned/source.pdf')
    assert digest(source.read_bytes()) == report['fixture']['sourceHashes'][name]
    if name == 'native-400':
        assert max(row['tailGrowthBytes'] for row in selected if row['variant'] == 'after') <= 128 * 1024 * 1024
assert read(root / 'assessment.json') == {'failures': []}
print(json.dumps({'status': 'Verified passing', 'runs': len(all_rows), 'artifactFiles':
                  sum(len(row['artifacts']) for row in all_rows), 'reportSha256': digest((root / 'report.json').read_bytes())}))
