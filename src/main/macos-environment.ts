import { execFile } from 'node:child_process';
import { shellEnv } from 'shell-env';

import { applyNodeEnvProxy } from './proxy-runtime';

const LOGIN_SHELL_PROXY_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy'
] as const;

const LOOPBACK_NO_PROXY = '127.0.0.1,localhost,::1';

export async function initializeMacOSPath(): Promise<void> {
  if (process.env.ROC_SMOKE === '1') {
    return;
  }
  const environment = await Promise.race([
    shellEnv(),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('macos_login_shell_path_timeout')), 2_000);
    })
  ]);
  if (!environment.PATH) {
    throw new Error('macos_login_shell_path_missing');
  }
  process.env.PATH = environment.PATH;
  copyProxyKeys(environment);
  if (!hasProxyEnv(process.env)) {
    copyProxyKeys(parseMacOSSystemProxy(await readSystemProxyText()));
  }
  applyNodeEnvProxy();
}

function copyProxyKeys(source: NodeJS.ProcessEnv): void {
  for (const key of LOGIN_SHELL_PROXY_KEYS) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      process.env[key] = value;
    }
  }
}

function hasProxyEnv(environment: NodeJS.ProcessEnv): boolean {
  return LOGIN_SHELL_PROXY_KEYS.some((key) => {
    const value = environment[key];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

function readSystemProxyText(): Promise<string> {
  return new Promise((resolve) => {
    execFile('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 1000 }, (error, stdout) => {
      if (error !== null) {
        resolve('');
        return;
      }
      resolve(typeof stdout === 'string' ? stdout : '');
    });
  });
}

export function parseMacOSSystemProxy(text: string): NodeJS.ProcessEnv {
  const values = new Map<string, string>();
  for (const raw of text.split(/\r?\n/u)) {
    const match = /^\s*([A-Za-z][A-Za-z0-9]*)\s*:\s*(.+?)\s*$/u.exec(raw);
    if (match === null) {
      continue;
    }
    const value = match[2];
    if (value.startsWith('<')) {
      continue;
    }
    values.set(match[1], value);
  }
  const http = proxyUrl(values, 'HTTPEnable', 'HTTPProxy', 'HTTPPort', 'http');
  const https = proxyUrl(values, 'HTTPSEnable', 'HTTPSProxy', 'HTTPSPort', 'http') ?? http;
  const socks = proxyUrl(values, 'SOCKSEnable', 'SOCKSProxy', 'SOCKSPort', 'socks5');
  const environment: NodeJS.ProcessEnv = {};
  if (http !== null) {
    environment.HTTP_PROXY = http;
    environment.http_proxy = http;
  }
  if (https !== null) {
    environment.HTTPS_PROXY = https;
    environment.https_proxy = https;
  }
  if (socks !== null) {
    environment.ALL_PROXY = socks;
    environment.all_proxy = socks;
  }
  if (http !== null || https !== null || socks !== null) {
    environment.NO_PROXY = LOOPBACK_NO_PROXY;
    environment.no_proxy = LOOPBACK_NO_PROXY;
  }
  return environment;
}

function proxyUrl(
  values: Map<string, string>,
  enableKey: string,
  hostKey: string,
  portKey: string,
  protocol: string
): string | null {
  if (values.get(enableKey) !== '1') {
    return null;
  }
  const host = values.get(hostKey);
  const port = values.get(portKey);
  if (host === undefined || port === undefined || !/^[A-Za-z0-9.-]+$/u.test(host) || !/^\d+$/u.test(port)) {
    return null;
  }
  return `${protocol}://${host}:${port}`;
}
