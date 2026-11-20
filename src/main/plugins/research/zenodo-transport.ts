import {z} from 'zod';
import type {RocPluginContext} from '../../kernel/types';
import {LiteratureProviderGovernor, LiteratureProviderAdmissionError} from './literature-provider-governor';
import {projectResearchPublicValue} from './export-public-projection';
import {zenodoRemoteSnapshotSchema, type ZenodoRemoteSnapshot} from '../../../shared/schemas/research-zenodo-remote';
import {sealZenodo} from './zenodo-preparation';
import {setTimeout as delay} from 'node:timers/promises';

export const zenodoOrigins = {sandbox: 'https://sandbox.zenodo.org', production: 'https://zenodo.org'} as const;
type Environment = keyof typeof zenodoOrigins;
export type ZenodoFetch = (url: string, init: RequestInit & {duplex?: 'half'}) => Promise<Response>;
export class ZenodoTransportError extends Error {
  constructor(readonly code: string, readonly attempted: boolean, readonly status: number | null = null,
    readonly retryAfterMs: number | null = null) {super(code);}
}
const deposition = z.object({id: z.number().int().positive(), owner: z.number().int().positive(), modified: z.iso.datetime({offset: true}),
  state: z.enum(['inprogress', 'done', 'error']), submitted: z.boolean(), metadata: z.record(z.string(), z.json()),
  files: z.array(z.object({id: z.string().min(1).max(128), filename: z.string().min(1).max(200),
    filesize: z.number().int().nonnegative().max(512 * 1024 * 1024), checksum: z.string().regex(/^[a-f0-9]{32}$/u)})).max(20),
  links: z.object({bucket: z.string().optional()}).optional(), doi: z.string().max(256).optional(),
  record_id: z.number().int().positive().optional(), record_url: z.string().max(2048).optional()});
export function readZenodoDeposition(input: unknown, environment: Environment): ZenodoRemoteSnapshot {
  const raw = deposition.parse(input), projection = projectResearchPublicValue(raw.metadata);
  if (projection.omittedFields.length !== 0) throw new Error('research_zenodo_private_remote_metadata');
  const bucket = raw.links?.bucket ?? null;
  if (bucket !== null) zenodoBucket(bucket, environment);
  const recordUrl = raw.record_url ?? null;
  if (recordUrl !== null) {
    const url = new URL(recordUrl);
    if (url.origin !== zenodoOrigins[environment] || url.username || url.password || url.search || url.hash ||
      !/^\/records?\/\d+$/u.test(url.pathname)) throw new Error('research_zenodo_remote_url_invalid');
    if (raw.record_id !== undefined && Number(url.pathname.split('/').at(-1)) !== raw.record_id) {
      throw new Error('research_zenodo_remote_url_invalid');
    }
  }
  const body = zenodoRemoteSnapshotSchema.omit({contentHash: true}).parse({id: raw.id, owner: raw.owner,
    modified: raw.modified, state: raw.state, submitted: raw.submitted, metadata: raw.metadata,
    files: raw.files.map(file => ({id: file.id, name: file.filename, size: file.filesize, md5: file.checksum})),
    bucket, doi: raw.doi ?? null, recordId: raw.record_id ?? null, recordUrl});
  if (new Set(body.files.map(file => file.name.toLowerCase())).size !== body.files.length) throw new Error('research_zenodo_remote_files_invalid');
  return zenodoRemoteSnapshotSchema.parse(sealZenodo(body));
}
export function zenodoBucket(value: string, environment: Environment): string {
  const url = new URL(value);
  if (url.origin !== zenodoOrigins[environment] || url.username || url.password || url.search || url.hash ||
    !/^\/api\/files\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(url.pathname)) throw new Error('research_zenodo_bucket_invalid');
  return url.href;
}

export class ZenodoTransport {
  private readonly governor: LiteratureProviderGovernor;
  constructor(private readonly secrets: RocPluginContext['secrets'], private readonly fetch: ZenodoFetch = globalThis.fetch,
    governor?: LiteratureProviderGovernor) {
    this.governor = governor ?? new LiteratureProviderGovernor(Object.fromEntries(Object.values(zenodoOrigins).map(origin =>
      [new URL(origin).hostname, {minIntervalMs: 1000, maxRequests: 300, windowMs: 3600000, failureThreshold: 3, cooldownMs: 60000}])),
    Date.now, (ms, signal) => delay(ms, undefined, {signal}));
  }
  async credential(environment: Environment): Promise<string> {
    let token: string | null;
    try {token = await this.secrets.get(`zenodo-${environment}`);}
    catch {throw new ZenodoTransportError('research_zenodo_credential_storage_failed', false);}
    if (token === null || token.length === 0) throw new ZenodoTransportError('research_zenodo_credential_required', false);
    return token;
  }
  async request(environment: Environment, path: string, method: 'GET' | 'POST' | 'PUT', expected: number,
    signal: AbortSignal, body?: BodyInit, uploadSize?: number): Promise<unknown> {
    const url = new URL(path, `${zenodoOrigins[environment]}/api/`);
    if (url.origin !== zenodoOrigins[environment] || url.username || url.password || url.hash ||
      !url.pathname.startsWith('/api/') || [...url.searchParams.keys()].some(key => !['size', 'page', 'all_versions'].includes(key))) {
      throw new ZenodoTransportError('research_zenodo_endpoint_invalid', false);
    }
    const upload = uploadSize !== undefined;
    if (upload && (!Number.isInteger(uploadSize) || uploadSize < 0 || uploadSize > 512 * 1024 * 1024)) {
      throw new ZenodoTransportError('research_zenodo_upload_limit', false);
    }
    const host = url.hostname, token = await this.credential(environment);
    const combined = AbortSignal.any([signal, AbortSignal.timeout(upload ? 180000 : 30000)]);
    let release: (() => void) | null = null, attempted = false;
    try {
      release = await this.governor.acquire(host, combined);
      combined.throwIfAborted(); attempted = true;
      const headers: Record<string, string> = {authorization: `Bearer ${token}`, accept: 'application/json'};
      if (!upload && body !== undefined) headers['content-type'] = 'application/json';
      if (upload) {
        headers['content-type'] = 'application/octet-stream';
        headers['content-length'] = String(uploadSize);
      }
      const response = await this.fetch(url.href, {method, headers, redirect: 'error', signal: combined,
        ...(body === undefined ? {} : {body}), ...(upload ? {duplex: 'half' as const} : {})});
      if (response.status !== expected) {
        const retry = response.headers.get('retry-after');
        const seconds = retry === null ? NaN : Number(retry);
        const date = retry === null ? NaN : Date.parse(retry);
        const retryAfterMs = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) :
          Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
        await response.body?.cancel();
        throw new ZenodoTransportError(`research_zenodo_http_${response.status}`, true, response.status, retryAfterMs);
      }
      const bytes: Uint8Array[] = []; let size = 0;
      if (response.body === null) throw new ZenodoTransportError('research_zenodo_response_missing', true);
      const reader = response.body.getReader();
      const abort = () => {void reader.cancel().catch(() => {});};
      combined.addEventListener('abort', abort, {once: true});
      try {
        while (true) {
          combined.throwIfAborted();
          const result = await reader.read(); if (result.done) break;
          size += result.value.byteLength;
          if (size > 4 * 1024 * 1024) {await reader.cancel(); throw new ZenodoTransportError('research_zenodo_response_limit', true);}
          bytes.push(result.value);
        }
        combined.throwIfAborted();
      } finally {
        combined.removeEventListener('abort', abort);
        reader.releaseLock();
      }
      let value: unknown;
      try {
        const text = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(bytes));
        if (text.includes(token)) throw new Error('credential_in_response');
        value = JSON.parse(text);
      }
      catch {throw new ZenodoTransportError('research_zenodo_response_invalid', true);}
      this.governor.success(host); return value;
    } catch (error) {
      if (error instanceof LiteratureProviderAdmissionError) throw new ZenodoTransportError(error.code, false, null, error.retryAfterMs);
      if (attempted) this.governor.failure(host, error instanceof ZenodoTransportError ? error.retryAfterMs : null);
      if (error instanceof ZenodoTransportError) throw error;
      throw new ZenodoTransportError('research_zenodo_transport_unknown', attempted);
    } finally {release?.();}
  }
}
