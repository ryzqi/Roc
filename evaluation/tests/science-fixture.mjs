import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { preparePython } from '../lib/local-python.mjs';
import { loadDataset, prepareScience } from '../lib/data.mjs';
import { sha256, writeJson } from '../lib/common.mjs';

export async function scienceFixture(root) {
  const source = join(root, 'science-source'); mkdirSync(source);
  for (const name of ['public', 'hidden', 'verifier', 'calibration']) mkdirSync(join(source, name));
  writeFileSync(join(source, 'public', 'input.csv'), '21\n');
  writeFileSync(join(source, 'hidden', 'expected.csv'), '42\n');
  writeFileSync(join(source, 'verifier', 'grade.py'), `import json,sys,pathlib
try:
    actual=float((pathlib.Path(sys.argv[1])/'pred.csv').read_text())
    expected=float((pathlib.Path(sys.argv[2])/'expected.csv').read_text())
    ok=abs(actual-expected)<1e-9
except (ValueError,OSError):
    ok=False
print(json.dumps(dict(success=ok,evidence='independent numeric comparison')))
`);
  for (const [kind, text] of Object.entries({ oracle: '42', alternative: '42.0', 'incorrect-output': '41', 'corrupt-output': 'broken', shortcut: '{"success":true}' })) {
    const path = join(source, 'calibration', kind); mkdirSync(path); writeFileSync(join(path, 'pred.csv'), text);
  }
  const environment = await preparePython('test-stdlib');
  const metadataPath = join(source, 'verified.json');
  writeJson(metadataPath, [{ instance_id: 1, task_inst: 'Compute twice the value in input.csv. Save pred.csv.', output_fname: 'pred.csv', github_name: 'synthetic-fixture' }]);
  const bundle = join(source, 'benchmark_verified.zip'); writeFileSync(bundle, 'synthetic test only; not official benchmark data');
  const recipe = { schemaVersion: 2, split: 'verified', sourceRevision: 'synthetic-test-only', metadataSha256: sha256(readFileSync(metadataPath)), bundleSha256: sha256(readFileSync(bundle)),
    tasks: [{ id: '1', publicDir: 'public', hiddenDir: 'hidden', verifierDir: 'verifier', calibrationDir: 'calibration',
      pythonEnvironment: environment, verifierEnvironment: environment, outputFiles: ['pred.csv'], license: 'synthetic-test' }] };
  const recipePath = join(source, 'recipe.json'); writeJson(recipePath, recipe);
  const path = prepareScience(metadataPath, recipePath, bundle);
  return { source, recipe, path, dataset: loadDataset(path) };
}
