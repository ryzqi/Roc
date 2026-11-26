import {lookup} from 'node:dns/promises';
import type {LookupAddress} from 'node:dns';
import https, {Agent, request} from 'node:https';
import {isIP} from 'node:net';
import type {Duplex} from 'node:stream';

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
function readingAddresses(hostname: string, signal: AbortSignal): Promise<LookupAddress[]> {
  signal.throwIfAborted();
  return new Promise((resolve,reject) => {
    const abort = () => {signal.removeEventListener('abort',abort); reject(signal.reason);};
    signal.addEventListener('abort',abort,{once:true});
    void lookup(hostname,{all:true}).then(addresses => {
      signal.removeEventListener('abort',abort); resolve(addresses);
    },error => {signal.removeEventListener('abort',abort); reject(error);});
  });
}
function readingAgent(): {agent: Agent; dispose: () => void} {
  // Read the current global agent: macOS bootstrap can update its proxy settings.
  // Node applies NO_PROXY to the original host and lets the configured proxy
  // resolve it. Pinning local DNS into CONNECT defeats proxy DNS on restricted networks.
  const agent = new Agent({...https.globalAgent.options,keepAlive:false,timeout:0});
  const sockets = new Set<Duplex>(), createConnection = agent.createConnection.bind(agent);
  agent.createConnection = (options,callback) => {
    const socket = createConnection(options,callback);
    if (socket) {sockets.add(socket); socket.once('close',() => sockets.delete(socket));}
    return socket;
  };
  return {agent,dispose() {
    agent.destroy();
    // Pending CONNECT sockets have not entered the agent's pool yet.
    for (const socket of sockets) socket.destroy();
  }};
}
/** Validate every target, pin direct DNS, and preserve the configured proxy's DNS and TLS identity. */
export const fetchReadingText: ReadingFetch = async (raw, options = {}) => {
  const signal = options.signal === undefined ? AbortSignal.timeout(45000) : AbortSignal.any([options.signal, AbortSignal.timeout(45000)]);
  try {
    let url = publicReadingUrl(raw);
    for (let redirects = 0; redirects <= 4; redirects++) {
      signal.throwIfAborted();
      const hostname = url.hostname.replace(/^\[|\]$/gu,'');
      const addresses = await readingAddresses(hostname,signal);
      if (addresses.length === 0 || addresses.some(row => !publicAddress(row.address))) throw new Error('该地址不是公开互联网端点。');
      signal.throwIfAborted();
      const address = addresses[0]!, transport = readingAgent();
      let result: {text: string; location: string | null};
      let abortRequest: (() => void) | undefined;
      try {
        result = await new Promise((resolve, reject) => {
          abortRequest = () => reject(signal.reason);
          signal.addEventListener('abort',abortRequest,{once:true});
          signal.throwIfAborted();
          const headers = Object.fromEntries(Object.entries(options.headers ?? {}).filter(([name]) => name.toLowerCase() !== 'host'));
          const req = request(url, {method: options.method ?? 'GET',
            servername:isIP(hostname) ? '' : hostname,agent:transport.agent,signal,
            lookup: (_hostname,lookupOptions,done) => {
              if (typeof lookupOptions === 'object' && lookupOptions.all) done(null,[address]);
              else done(null,address.address,address.family);
            },
            headers: {'User-Agent': 'Roc/1.0 academic-reader', Accept: 'application/atom+xml, application/rss+xml, application/json, text/html, */*', ...headers, Host:url.host}}, res => {
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
      } finally {
        if (abortRequest) signal.removeEventListener('abort',abortRequest);
        transport.dispose();
      }
      if (result.location === null) return result.text;
      // Never forward provider credentials/body to a redirect destination.
      if (options.body !== undefined || options.method && options.method !== 'GET' ||
        Object.keys(options.headers ?? {}).some(key => /authorization|api.?key|subscription.?key/iu.test(key)))
        throw new Error('翻译端点发生重定向，请使用最终地址。');
      url = publicReadingUrl(new URL(result.location, url).href);
    }
    throw new Error('来源重定向次数过多。');
  } catch (error) {
    if (signal.aborted) {
      const reason: unknown = signal.reason;
      if (reason instanceof Error && reason.name === 'TimeoutError')
        throw new DOMException('来源请求超时，请检查网络或代理后重试。','TimeoutError');
      throw reason;
    }
    throw error;
  }
};
