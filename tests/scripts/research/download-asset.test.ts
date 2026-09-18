import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { downloadRanges, downloadVerified, probe, type RemoteFile } from '../../../scripts/research/download-asset';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-download-asset-')));
  roots.push(root);
  return root;
}

async function rangeServer(
  data: Buffer,
  options: { truncateFirst?: boolean; changed?: boolean } = {}
): Promise<{ url: string; requests: Array<[number, number]>; close: () => Promise<void> }> {
  const requests: Array<[number, number]> = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const match = /^bytes=(\d+)-(\d+)$/u.exec(request.headers.range ?? '');
    if (match === null) {
      response.statusCode = 400;
      response.end();
      return;
    }
    const start = Number(match[1]);
    const end = Number(match[2]);
    requests.push([start, end]);
    const body = data.subarray(start, end + 1);
    response.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${data.length}`,
      'Content-Length': String(body.length),
      ETag: options.changed ? '"changed"' : '"fixed"',
      Connection: 'close'
    });
    if (options.truncateFirst === true && requests.length === 1) {
      response.end(body.subarray(0, 3));
      return;
    }
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server_address_required');
  return {
    url: `http://127.0.0.1:${address.port}/asset`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  };
}

describe('research download asset', () => {
  it('retains partial bytes and resumes across invocations', async () => {
    const data = Buffer.from('resume these exact bytes');
    const root = await workspace();
    const server = await rangeServer(data, { truncateFirst: true });
    try {
      const target = join(root, 'bundle.tar');
      const remote: RemoteFile = { url: server.url, size: data.length, etag: '"fixed"' };
      await expect(downloadRanges(remote, target, { workers: 1, chunkSize: 16, attempts: 1 }))
        .rejects.toMatchObject({ message: expect.stringContaining('chunk_incomplete') });
      expect(await readFile(join(root, 'bundle.tar.parts/000000.part'))).toEqual(data.subarray(0, 3));
      await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
      await downloadRanges(remote, target, { workers: 1, chunkSize: 16 });
      expect(await readFile(target)).toEqual(data);
      expect(server.requests).toContainEqual([3, 15]);
      expect(server.requests.filter((range) => range[0] === 0 && range[1] === 15)).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('uses 36 default range-download attempts for flaky proxies', async () => {
    const source = await readFile(new URL('../../../scripts/research/download-asset.ts', import.meta.url), 'utf8');
    expect(source).toContain('const DEFAULT_ATTEMPTS = 36;');
    expect(source).not.toContain('const DEFAULT_ATTEMPTS = 12;');
  });

  it('rejects a changed etag before writing content', async () => {
    const root = await workspace();
    const server = await rangeServer(Buffer.from('12345'), { changed: true });
    try {
      const target = join(root, 'asset');
      await expect(downloadRanges({ url: server.url, size: 5, etag: '"fixed"' }, target))
        .rejects.toMatchObject({ message: 'research_download_source_changed' });
      await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(root, 'asset.parts/000000.part'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await server.close();
    }
  });

  it('verifies a download and reuses the file without another network fetch', async () => {
    const data = Buffer.from('a small locked asset');
    const digest = createHash('sha256').update(data).digest('hex');
    const root = await workspace();
    const server = await rangeServer(data);
    try {
      const target = join(root, 'asset');
      expect((await probe(server.url)).size).toBe(data.length);
      await downloadVerified(server.url, digest, target, { expectedSize: data.length });
      expect(await readFile(target)).toEqual(data);
      const count = server.requests.length;
      await downloadVerified(server.url, digest, target);
      expect(server.requests).toHaveLength(count);
      await writeFile(target, 'corrupt');
      await expect(downloadVerified(server.url, digest, target))
        .rejects.toMatchObject({ message: expect.stringContaining('hash_mismatch') });
    } finally {
      await server.close();
    }
  });

  it('rejects symlink targets and cache directories', async () => {
    const root = await workspace();
    const target = join(root, 'asset');
    const protectedPath = join(root, 'protected');
    await writeFile(protectedPath, 'keep');
    await symlink(protectedPath, target);
    await expect(downloadVerified('https://unused.invalid', 'a'.repeat(64), target))
      .rejects.toMatchObject({ message: 'research_download_target_symlink' });
    expect(await readFile(protectedPath, 'utf8')).toBe('keep');
    await rm(target);
    await symlink(root, join(root, 'asset.parts'));
    await expect(downloadRanges({ url: 'https://unused.invalid', size: 10, etag: null }, target))
      .rejects.toMatchObject({ message: 'research_download_cache_symlink' });
  });

  it('follows a 302 before probing range identity', async () => {
    const data = Buffer.from('redirected asset body');
    const digest = createHash('sha256').update(data).digest('hex');
    const root = await workspace();
    const origin = await rangeServer(data);
    const bounce = createServer((_request, response) => {
      response.writeHead(302, { Location: origin.url });
      response.end();
    });
    await new Promise<void>((resolve) => bounce.listen(0, '127.0.0.1', resolve));
    try {
      const address = bounce.address();
      if (address === null || typeof address === 'string') throw new Error('server_address_required');
      const target = join(root, 'asset');
      await downloadVerified(`http://127.0.0.1:${address.port}/start`, digest, target, { expectedSize: data.length });
      expect(await readFile(target)).toEqual(data);
    } finally {
      bounce.closeAllConnections();
      await new Promise<void>((resolve, reject) => bounce.close((error) => error ? reject(error) : resolve()));
      await origin.close();
    }
  });

  it('retries a failed transfer without discarding partial bytes', async () => {
    const data = Buffer.from('a short body with more than three bytes');
    const root = await workspace();
    const server = await rangeServer(data, { truncateFirst: true });
    try {
      const target = join(root, 'asset');
      await downloadRanges(
        { url: server.url, size: data.length, etag: '"fixed"' },
        target,
        { workers: 1, delay: async () => undefined }
      );
      expect(await readFile(target)).toEqual(data);
      expect(server.requests[1]?.[0]).toBe(3);
    } finally {
      await server.close();
    }
  });
});
