import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open, rename, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import type {z} from 'zod';
import {type hfFileSchema, type HfIdentity} from '../../../shared/schemas/research-huggingface';
import type {HfDownloadReceipt, HfDownloadRequestReceipt} from '../../../shared/schemas/research-huggingface-downloads';
import type {LiteratureProviderGovernor} from './literature-provider-governor';

export type HfDownloadProgress = {
  receipt: HfDownloadReceipt;
  save(): void;
};
type HfFile = z.infer<typeof hfFileSchema>;
export function huggingFaceResolveUrl(identity: HfIdentity, path: string): string {
  return `https://huggingface.co/${identity.kind === 'dataset' ? 'datasets/' : ''}${identity.repo}/resolve/${identity.revision}/${path.split('/').map(encodeURIComponent).join('/')}`;
}
export function requireHuggingFaceDownloadUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || /^https:\/\/[^/]*@/u.test(url.href) || url.port !== '' || url.hash !== '' ||
    !(url.hostname === 'huggingface.co' || url.hostname.endsWith('.huggingface.co') || url.hostname.endsWith('.hf.co'))) {
    throw new Error('research_hf_download_redirect_rejected');
  }
  return url;
}
export async function removeHuggingFacePartial(path: string): Promise<void> {
  try {await unlink(path);}
  catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
}

/** No tokens, resume, execution, arbitrary CDN hosts or signed URLs in receipts. */
export class HuggingFaceDownloader {
  constructor(private readonly governor: LiteratureProviderGovernor,
    private readonly fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = fetch,
    private readonly now: () => string = () => new Date().toISOString()) {}

  async download(file: HfFile, index: number, directory: string, progress: HfDownloadProgress, signal: AbortSignal,
    requireScope: () => void): Promise<void> {
    const storageName = `file-${index}`;
    const partial = join(directory, `${storageName}.part`);
    const handle = await open(partial, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    let closed = false;
    try {
      const sha256 = createHash('sha256');
      const git = createHash('sha1').update(`blob ${file.size}\0`);
      let written = 0;
      let checkpoint = progress.receipt.lastRecordedTransferredBytes;
      const initialUrl = huggingFaceResolveUrl(progress.receipt.observation.request, file.path);
      await this.transfer(initialUrl, file.path, progress, signal, requireScope, async chunk => {
        progress.receipt.lastRecordedTransferredBytes += chunk.byteLength;
        if (written + chunk.byteLength > file.size || progress.receipt.lastRecordedTransferredBytes > progress.receipt.request.maxBytes) {
          throw new Error('research_hf_download_byte_limit');
        }
        signal.throwIfAborted();
        let offset = 0;
        while (offset < chunk.byteLength) {
          const result = await handle.write(chunk, offset, chunk.byteLength - offset, written + offset);
          if (result.bytesWritten === 0) throw new Error('research_hf_download_storage_failed');
          offset += result.bytesWritten;
        }
        written += chunk.byteLength;
        sha256.update(chunk); git.update(chunk);
        if (progress.receipt.lastRecordedTransferredBytes - checkpoint >= 1024 * 1024) {
          progress.save(); checkpoint = progress.receipt.lastRecordedTransferredBytes;
        }
      }, file.size);
      const actualHash = sha256.digest('hex');
      if (written !== file.size) throw new Error('research_hf_download_size_mismatch');
      if (file.lfs === null ? git.digest('hex') !== file.blobId : actualHash !== file.lfs.sha256) {
        throw new Error('research_hf_download_hash_mismatch');
      }
      signal.throwIfAborted(); requireScope();
      if ((await handle.stat()).size !== written) throw new Error('research_hf_download_storage_failed');
      await handle.sync();
      await handle.close(); closed = true;
      signal.throwIfAborted(); requireScope();
      await rename(partial, join(directory, storageName));
      // Rename is the commit boundary: retain the verified file even if cancellation arrives here.
      progress.receipt.files.push({source: file, storageName, sha256: actualHash, verifiedAt: this.now()});
      progress.receipt.verifiedBytes += written;
      progress.save();
    } finally {
      if (!closed) await handle.close();
      await removeHuggingFacePartial(partial);
    }
  }

  private async transfer(initialUrl: string, filePath: string, progress: HfDownloadProgress, signal: AbortSignal,
    requireScope: () => void, write: (chunk: Uint8Array) => Promise<void>, expectedSize: number): Promise<void> {
    let url = requireHuggingFaceDownloadUrl(initialUrl);
    for (let redirects = 0; ; redirects++) {
      let redirected: URL | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        signal.throwIfAborted(); requireScope();
        const release = await this.governor.acquire('huggingface.co', signal);
        const receipt: HfDownloadRequestReceipt = {filePath, host: url.hostname, startedAt: this.now(), endedAt: null,
          status: null, retryAfterMs: null, errorCode: null};
        progress.receipt.requests.push(receipt);
        let response: Response | null = null;
        try {
          progress.save();
          response = await this.fetchImpl(url.toString(), {method: 'GET', redirect: 'manual', credentials: 'omit',
            headers: {'accept-encoding': 'identity'}, signal});
          signal.throwIfAborted();
          receipt.status = response.status;
          this.governor.responseLimits('huggingface.co', response.headers);
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            if (redirects >= 5) throw new Error('research_hf_download_redirect_limit');
            const location = response.headers.get('location');
            if (location === null) throw new Error('research_hf_download_redirect_rejected');
            redirected = requireHuggingFaceDownloadUrl(new URL(location, url).toString());
            break;
          }
          if (response.status !== 200) {
            const header = response.headers.get('retry-after');
            if (header !== null) {
              const seconds = Number(header);
              const value = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.parse(this.now());
              if (Number.isFinite(value)) receipt.retryAfterMs = Math.max(0, value);
            }
            receipt.errorCode = `research_hf_download_http_${response.status}`;
            this.governor.failure('huggingface.co', receipt.retryAfterMs);
            if ((response.status === 429 || response.status >= 500) && attempt < 2) continue;
            throw new Error(receipt.errorCode);
          }
          const length = response.headers.get('content-length');
          const encoding = response.headers.get('content-encoding');
          if (encoding !== null && encoding !== 'identity' ||
            length !== null && (!/^\d+$/u.test(length) || Number(length) !== expectedSize)) {
            throw new Error('research_hf_download_size_mismatch');
          }
          progress.receipt.requests[progress.receipt.requests.length - 1] = receipt;
          progress.save();
          if (response.body !== null) {
            const reader = response.body.getReader();
            try {
              for (;;) {
                signal.throwIfAborted();
                const chunk = await reader.read();
                signal.throwIfAborted();
                if (chunk.done) break;
                await write(chunk.value);
              }
            } finally {await reader.cancel(); reader.releaseLock();}
          }
          this.governor.success('huggingface.co');
          return;
        } catch (error) {
          const code = error instanceof Error ? error.message : '';
          receipt.errorCode = code.startsWith('research_hf_download_') && /^research_hf_download_[a-z0-9_]+$/u.test(code)
            ? code : signal.aborted ? 'research_hf_download_aborted' : 'research_hf_download_transport_failed';
          throw error;
        } finally {
          receipt.endedAt = this.now();
          // Parsing in repository creates new objects; replace the receipt by index on save.
          const position = progress.receipt.requests.length - 1;
          progress.receipt.requests[position] = receipt;
          try {if (response?.body !== null && response?.body !== undefined && !response.body.locked) await response.body.cancel();}
          finally {try {progress.save();} finally {release();}}
          if (receipt.status !== null && (receipt.status === 429 || receipt.status >= 500) && receipt.retryAfterMs === null && attempt < 2) {
            await delay(250 * 2 ** attempt, undefined, {signal});
          }
        }
      }
      if (redirected === null) throw new Error('research_hf_download_redirect_rejected');
      url = redirected;
    }
  }
}
