import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fetchModel,
  huggingfaceResolveUrl,
  inspectInstalledModels,
  readSources,
  verifyFiles,
  type ModelSource
} from '../../../scripts/research/fetch-models';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-fetch-models-')));
  roots.push(root);
  return root;
}

function digest(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function source(files: Record<string, string>): ModelSource {
  return {
    repoId: 'owner/model',
    revision: 'a'.repeat(40),
    directory: 'model',
    license: 'Apache-2.0',
    files
  };
}

describe('research fetch models', () => {
  it('reads a lock file and builds huggingface resolve urls', () => {
    const sources = readSources({
      schemaVersion: 1,
      models: [{
        repoId: 'docling-project/docling-layout-heron',
        revision: '8f39ad3c0b4c58e9c2d2c84a38465abf757272d8',
        directory: 'docling-project--docling-layout-heron',
        license: 'Apache-2.0',
        files: { 'model.safetensors': 'b'.repeat(64), 'nested/config.json': 'c'.repeat(64) }
      }]
    });
    expect(huggingfaceResolveUrl(sources[0], 'nested/config.json')).toBe(
      'https://huggingface.co/docling-project/docling-layout-heron/resolve/8f39ad3c0b4c58e9c2d2c84a38465abf757272d8/nested/config.json'
    );
  });

  it('downloads listed files, writes the source marker, and reuses a verified directory', async () => {
    const root = await workspace();
    const weights = Buffer.from('weights');
    const config = Buffer.from('config');
    const model = source({ 'model.safetensors': digest(weights), 'config.json': digest(config) });
    const urls: string[] = [];
    await fetchModel(model, root, {
      download: async (url, sha256, target) => {
        urls.push(url);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, url.endsWith('config.json') ? config : weights);
        expect(sha256).toBe(url.endsWith('config.json') ? digest(config) : digest(weights));
        return target;
      }
    });
    expect(urls).toEqual([
      huggingfaceResolveUrl(model, 'model.safetensors'),
      huggingfaceResolveUrl(model, 'config.json')
    ]);
    expect(await readFile(join(root, 'model/model.safetensors'))).toEqual(weights);
    expect(JSON.parse(await readFile(join(root, 'model/roc-source.json'), 'utf8'))).toEqual({
      repoId: 'owner/model', revision: 'a'.repeat(40), license: 'Apache-2.0'
    });
    urls.length = 0;
    await fetchModel(model, root, {
      download: async () => {
        throw new Error('network_should_not_run');
      }
    });
    expect(urls).toHaveLength(0);
  });

  it('keeps partial bytes in the download cache across a failed invocation', async () => {
    const root = await workspace();
    const data = Buffer.from('weights');
    const model = source({ 'model.safetensors': digest(data) });
    let attempts = 0;
    const download = async (_url: string, _sha256: string, target: string): Promise<string> => {
      attempts += 1;
      await mkdir(dirname(target), { recursive: true });
      if (attempts === 1) {
        await writeFile(target, data.subarray(0, 3));
        throw new Error('connection interrupted');
      }
      expect(await readFile(target)).toEqual(data.subarray(0, 3));
      await writeFile(target, data);
      return target;
    };
    await expect(fetchModel(model, root, { download })).rejects.toMatchObject({ message: 'connection interrupted' });
    expect(await readFile(join(root, `.downloads/model-${model.revision}/model.safetensors`))).toEqual(data.subarray(0, 3));
    await fetchModel(model, root, { download });
    expect(await readFile(join(root, 'model/model.safetensors'))).toEqual(data);
    expect(attempts).toBe(2);
  });

  it('verifies configuration hashes as well as weight hashes', async () => {
    const root = await workspace();
    await writeFile(join(root, 'model.safetensors'), 'weights');
    await writeFile(join(root, 'config.json'), 'config');
    const model = source({ 'model.safetensors': digest('weights'), 'config.json': digest('config') });
    await verifyFiles(root, model);
    await writeFile(join(root, 'config.json'), 'changed');
    await expect(verifyFiles(root, model)).rejects.toMatchObject({
      message: 'research_model_hash_mismatch:model/config.json'
    });
  });

  it('rejects invalid lock fields and duplicate directories', () => {
    expect(() => readSources({ schemaVersion: 1, models: [] })).toThrow('research_models_lock_invalid');
    expect(() => readSources({
      schemaVersion: 1,
      models: [{
        repoId: 'owner/model', revision: 'a'.repeat(40), directory: 'model', license: 'Apache-2.0',
        files: { '../escape': 'b'.repeat(64) }
      }]
    })).toThrow('research_model_file_path_invalid');
    expect(() => readSources({
      schemaVersion: 1,
      models: [
        { repoId: 'owner/one', revision: 'a'.repeat(40), directory: 'same', license: 'Apache-2.0', files: { a: 'b'.repeat(64) } },
        { repoId: 'owner/two', revision: 'c'.repeat(40), directory: 'same', license: 'MIT', files: { a: 'd'.repeat(64) } }
      ]
    })).toThrow('research_model_directory_duplicate');
  });

  it('rejects unlisted files and symlinks', async () => {
    const root = await workspace();
    await writeFile(join(root, 'model'), 'model');
    const model = source({ model: digest('model') });
    await writeFile(join(root, 'extra'), 'extra');
    await expect(verifyFiles(root, model)).rejects.toMatchObject({ message: 'research_model_unexpected_file' });
    await rm(join(root, 'extra'));
    await symlink('model', join(root, 'link'));
    await expect(verifyFiles(root, model)).rejects.toMatchObject({ message: 'research_model_symlink' });
  });

  it('reports missing model directories as unavailable', async () => {
    const root = await workspace();
    const lock = {
      schemaVersion: 1,
      models: [{
        repoId: 'owner/model',
        revision: 'a'.repeat(40),
        directory: 'model',
        license: 'Apache-2.0',
        files: { 'model.safetensors': digest('weights') }
      }]
    };
    await expect(inspectInstalledModels(null, lock)).resolves.toMatchObject({
      available: false, ready: false, error: 'research_models_unavailable', models: []
    });
    await expect(inspectInstalledModels(root, lock)).resolves.toMatchObject({
      available: true, ready: false, error: 'research_models_unavailable',
      models: [{ directory: 'model', repoId: 'owner/model', ready: false }]
    });
  });

  it('treats a matching marker and present files as ready without hashing', async () => {
    const root = await workspace();
    const model = source({ 'model.safetensors': digest('weights') });
    await mkdir(join(root, 'model'));
    await writeFile(join(root, 'model/model.safetensors'), 'wrong-bytes');
    await writeFile(join(root, 'model/roc-source.json'), JSON.stringify({
      repoId: model.repoId, revision: model.revision, license: model.license
    }));
    await expect(inspectInstalledModels(root, {
      schemaVersion: 1,
      models: [model]
    })).resolves.toMatchObject({
      available: true, ready: true, error: null,
      models: [{ directory: 'model', repoId: 'owner/model', ready: true }]
    });
    await expect(inspectInstalledModels(root, {
      schemaVersion: 1,
      models: [model]
    }, { verifyHashes: true })).resolves.toMatchObject({
      available: true, ready: false, error: 'research_model_hash_mismatch'
    });
  });
});
