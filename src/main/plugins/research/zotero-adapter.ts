import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import type {z} from 'zod';
import {
  zoteroServerIdSchema, zoteroProbeSchema, zoteroGroupsRequestSchema, zoteroGroupSchema,
  zoteroPageRequestSchema, zoteroItemsRequestSchema, zoteroItemSchema, zoteroCollectionSchema,
  zoteroScopeSchema, zoteroItemKeySchema,
  type ZoteroScope
} from '../../../shared/schemas/research-zotero';

type ZoteroFetch = (url: string, init: RequestInit) => Promise<Response>;
const base = 'http://127.0.0.1:23119/api/';
const integer = (value: string | null): number => {
  if (value === null || !/^(0|[1-9][0-9]*)$/u.test(value)) throw new Error('zotero_response_invalid');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('zotero_response_invalid');
  return parsed;
};
const prefix = (scope: ZoteroScope): string =>
  scope.library.kind === 'user' ? 'users/0' : `groups/${scope.library.id}`;

/** Fixed loopback origin, GET only, no keys, connector calls, redirects or file reads. */
export class ZoteroAdapter {
  private readonly lifetime = new AbortController();
  private readonly active = new Set<Promise<unknown>>();

  constructor(private readonly fetchImpl: ZoteroFetch = (url, init) => fetch(url, init),
    private readonly now: () => string = () => new Date().toISOString()) {}

  async probe(signal?: AbortSignal): Promise<z.infer<typeof zoteroProbeSchema>> {
    const checkedAt = this.now();
    try {
      const response = await this.request('', null, signal);
      return {status: 'connected', serverId: response.serverId, apiVersion: 3,
        schemaVersion: response.schemaVersion, checkedAt};
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (['zotero_closed', 'zotero_cancelled'].includes(code)) throw error;
      const status = code === 'zotero_api_disabled' ? 'disabled' :
        code === 'zotero_unreachable' || code === 'zotero_timeout' ? 'unreachable' :
        code === 'zotero_api_unsupported' ? 'unsupported' : 'invalid_response';
      if (!code.startsWith('zotero_')) throw error;
      return {status, errorCode: code, checkedAt};
    }
  }

  async groups(input: unknown, signal?: AbortSignal): Promise<z.infer<typeof import('../../../shared/schemas/research-zotero').zoteroGroupsPageSchema>> {
    const request = zoteroGroupsRequestSchema.parse(input);
    const query = new URLSearchParams({format: 'json', start: String(request.offset), limit: String(request.limit),
      sort: 'title', direction: 'asc'});
    const response = await this.request(`users/0/groups?${query}`, request.serverId, signal);
    const records = this.parse(response.text, zoteroGroupSchema.array());
    const total = integer(response.headers.get('Total-Results'));
    this.validatePage(records.length, request.offset, request.limit, total);
    if (new Set(records.map(item => item.id)).size !== records.length) throw new Error('zotero_page_duplicate');
    return {serverId: response.serverId, offset: request.offset, total,
      nextOffset: request.offset + records.length < total ? request.offset + records.length : null,
      responseHash: response.hash, fetchedAt: response.fetchedAt, records};
  }

  async collections(input: unknown, signal?: AbortSignal): Promise<z.infer<typeof import('../../../shared/schemas/research-zotero').zoteroCollectionsPageSchema>> {
    const request = zoteroPageRequestSchema.parse(input);
    const query = new URLSearchParams({format: 'json', start: String(request.offset), limit: String(request.limit),
      sort: 'title', direction: 'asc'});
    return this.page(request, `${prefix(request)}/collections?${query}`, zoteroCollectionSchema, signal);
  }

  async items(input: unknown, signal?: AbortSignal): Promise<z.infer<typeof import('../../../shared/schemas/research-zotero').zoteroItemsPageSchema>> {
    const request = zoteroItemsRequestSchema.parse(input);
    const query = new URLSearchParams({format: 'json', include: 'data', start: String(request.offset),
      limit: String(request.limit), sort: 'dateAdded', direction: 'asc'});
    if (request.since !== null) query.set('since', String(request.since));
    const path = request.collectionKey === null ? 'items' : `collections/${request.collectionKey}/items`;
    return this.page(request, `${prefix(request)}/${path}?${query}`, zoteroItemSchema, signal);
  }

  /** A path reference is not filesystem authorization; the import boundary must validate access. */
  async attachmentPath(scopeInput: unknown, keyInput: unknown, signal?: AbortSignal): Promise<string> {
    const scope = zoteroScopeSchema.parse(scopeInput);
    const key = zoteroItemKeySchema.parse(keyInput);
    const response = await this.request(`${prefix(scope)}/items/${key}/file/view/url`, scope.serverId, signal);
    let url: URL;
    try { url = new URL(response.text); }
    catch (cause) { throw new Error('zotero_attachment_url_invalid', {cause}); }
    if (url.protocol !== 'file:' || !['', 'localhost'].includes(url.hostname) ||
        url.username || url.password || url.search || url.hash) throw new Error('zotero_attachment_url_invalid');
    return fileURLToPath(url);
  }

  async shutdown(): Promise<void> {
    this.lifetime.abort();
    await Promise.allSettled([...this.active]);
  }

  private async page<T extends {key: string; version: number}>(request: z.infer<typeof zoteroPageRequestSchema>,
    path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<{
      serverId: string; library: ZoteroScope['library']; libraryVersion: number; offset: number;
      total: number; nextOffset: number | null; responseHash: string; fetchedAt: string; records: T[]
    }> {
    const response = await this.request(path, request.serverId, signal);
    const libraryVersion = integer(response.headers.get('Last-Modified-Version'));
    if (request.expectedLibraryVersion !== null && libraryVersion !== request.expectedLibraryVersion) {
      throw new Error('zotero_library_version_changed');
    }
    const records = this.parse(response.text, schema.array());
    const total = integer(response.headers.get('Total-Results'));
    this.validatePage(records.length, request.offset, request.limit, total);
    if (new Set(records.map(item => item.key)).size !== records.length) throw new Error('zotero_page_duplicate');
    if (records.some(item => item.version > libraryVersion)) throw new Error('zotero_response_invalid');
    return {serverId: response.serverId, library: request.library, libraryVersion, offset: request.offset, total,
      nextOffset: request.offset + records.length < total ? request.offset + records.length : null,
      responseHash: response.hash, fetchedAt: response.fetchedAt, records};
  }

  private validatePage(count: number, offset: number, limit: number, total: number): void {
    if (count !== Math.min(limit, Math.max(0, total - offset))) throw new Error('zotero_page_incomplete');
  }

  private parse<T>(text: string, schema: z.ZodType<T>): T {
    try { return schema.parse(JSON.parse(text)); }
    catch (cause) { throw new Error('zotero_response_invalid', {cause}); }
  }

  private async request(path: string, serverId: string | null, signal?: AbortSignal): Promise<{
    serverId: string; schemaVersion: number; headers: Headers; text: string; hash: string; fetchedAt: string
  }> {
    if (this.lifetime.signal.aborted) throw new Error('zotero_closed');
    if (signal?.aborted) throw new Error('zotero_cancelled');
    const pending = this.read(path, serverId, signal);
    this.active.add(pending);
    try { return await pending; }
    finally { this.active.delete(pending); }
  }

  private async read(path: string, serverId: string | null, parentSignal?: AbortSignal): Promise<{
    serverId: string; schemaVersion: number; headers: Headers; text: string; hash: string; fetchedAt: string
  }> {
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(10_000),
      ...(parentSignal === undefined ? [] : [parentSignal])]);
    const abortedCode = (): string =>
      this.lifetime.signal.aborted || parentSignal?.aborted ? 'zotero_cancelled' : 'zotero_timeout';
    const url = new URL(path, base);
    if (url.origin !== new URL(base).origin || !url.pathname.startsWith('/api/')) throw new Error('zotero_url_invalid');
    let response: Response;
    try {
      response = await this.fetchImpl(url.href, {method: 'GET', redirect: 'manual', signal,
        headers: {Accept: 'application/json', 'Zotero-API-Version': '3',
          ...(serverId === null ? {} : {'Zotero-Server-ID': serverId})}});
    } catch (cause) {
      throw new Error(signal.aborted ? abortedCode() : 'zotero_unreachable', {cause});
    }
    try {
      if (signal.aborted) throw new Error(abortedCode());
      if (response.status === 403) throw new Error('zotero_api_disabled');
      if (response.status === 412) throw new Error('zotero_server_changed');
      if (response.status === 501) throw new Error('zotero_api_unsupported');
      if (response.status !== 200) throw new Error(`zotero_http_${response.status}`);
      if (response.headers.get('Zotero-API-Version') !== '3' || response.headers.get('Zotero-Server-ID') === null) {
        throw new Error('zotero_api_unsupported');
      }
      const identity = zoteroServerIdSchema.safeParse(response.headers.get('Zotero-Server-ID'));
      if (!identity.success) throw new Error('zotero_response_invalid');
      const observedId = identity.data;
      if (serverId !== null && serverId !== observedId) throw new Error('zotero_server_changed');
      const schemaVersion = integer(response.headers.get('Zotero-Schema-Version'));
      if (response.body === null) throw new Error('zotero_response_invalid');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 8 * 1024 * 1024) throw new Error('zotero_response_too_large');
          chunks.push(next.value);
        }
      } finally { await reader.cancel(); }
      if (signal.aborted) throw new Error(abortedCode());
      const bytes = Buffer.concat(chunks);
      return {serverId: observedId, schemaVersion, headers: response.headers, text: bytes.toString('utf8'),
        hash: createHash('sha256').update(bytes).digest('hex'), fetchedAt: this.now()};
    } catch (cause) {
      if (signal.aborted) throw new Error(abortedCode(), {cause});
      throw cause;
    } finally {
      if (response.body !== null && !response.body.locked) await response.body.cancel();
    }
  }
}
