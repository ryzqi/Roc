import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function prepareArtifactDir() {
  const artifactDir = resolve('.artifacts/wave1');
  mkdirSync(artifactDir, { recursive: true });
  return artifactDir;
}

export function writeFatalArtifact(artifactDir, label, text) {
  writeFileSync(join(artifactDir, `electron-smoke-fatal-${label}.txt`), text ?? '', 'utf8');
}

export function writeSmokeResult(artifactDir, result) {
  writeFileSync(join(artifactDir, 'electron-smoke.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}
