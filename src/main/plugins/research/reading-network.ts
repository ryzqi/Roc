import {lookup} from 'node:dns/promises';
import {request} from 'node:https';
import {isIP} from 'node:net';

export type ReadingFetch = (url: string, options?: {signal?: AbortSignal; method?: string; body?: string; headers?: Record<string,string>}) => Promise<string>;
export function publicReadingUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443')
    throw new Error('订阅与翻译端点必须是无凭据的 HTTPS 地址。');
  return url;
}
function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a,b] = address.split('.').map(Number);
    return a !== 0 && a !== 10 && a !== 127 && a! < 224 && !(a === 169 && b === 254) &&
      !(a === 172 && b! >= 16 && b! <= 31) && !(a === 192 && b === 168) && !(a === 100 && b! >= 64 && b! <= 127);
  }
  const lower = address.toLowerCase();
  return isIP(lower) === 6 && /^[23]/u.test(lower) && !lower.startsWith('2001:db8:');
}
/** Pin the validated DNS address for this request, and revalidate every redirect. */
export const fetchReadingText: ReadingFetch = async (raw, options = {}) => {
  const signal = options.signal === undefined ? AbortSignal.timeout(45000) : AbortSignal.any([options.signal, AbortSignal.timeout(45000)]);
  let url = publicReadingUrl(raw);
  for (let redirects = 0; redirects <= 4; redirects++) {
    signal.throwIfAborted();
    const addresses = await lookup(url.hostname, {all: true});
    if (addresses.length === 0 || addresses.some(row => !publicAddress(row.address))) throw new Error('该地址不是公开互联网端点。');
    const address = addresses[0]!;
    const result = await new Promise<{text: string; location: string | null}>((resolve, reject) => {
      const req = request(url, {method: options.method ?? 'GET', agent: false, signal,
        lookup: (_hostname, lookupOptions, done) => {
          if (typeof lookupOptions === 'object' && lookupOptions.all) done(null, [address]);
          else done(null, address.address, address.family);
        },
        headers: {'User-Agent': 'Roc/1.0 academic-reader', Accept: 'application/atom+xml, application/rss+xml, application/json, text/html, */*', ...options.headers}}, res => {
        if ([301,302,303,307,308].includes(res.statusCode ?? 0)) {
          res.resume(); if (!res.headers.location) reject(new Error('来源重定向缺少目标地址。'));
          else resolve({text: '', location: res.headers.location}); return;
        }
        if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {res.resume(); reject(new Error(`来源返回 HTTP ${res.statusCode}`)); return;}
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', (chunk: Buffer) => {size += chunk.length;
          if (size > 8_000_000) res.destroy(new Error('来源响应超过 8 MB 限制。')); else chunks.push(chunk);});
        res.on('error', reject); res.on('end', () => resolve({text: Buffer.concat(chunks).toString('utf8'), location: null}));
      });
      req.on('error', reject); req.end(options.body);
    });
    if (result.location === null) return result.text;
    // Never forward provider credentials/body to a redirect destination.
    if (options.method && options.method !== 'GET' || Object.keys(options.headers ?? {}).some(key => /authorization|api.?key|subscription.?key/iu.test(key))) throw new Error('翻译端点发生重定向，请使用最终地址。');
    url = publicReadingUrl(new URL(result.location, url).href);
  }
  throw new Error('来源重定向次数过多。');
};
