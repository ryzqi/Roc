import { execFile } from 'node:child_process';
import { shellEnv } from 'shell-env';

import { applyNodeEnvProxy } from '../../src/main/proxy-runtime';
import { initializeMacOSPath, parseMacOSSystemProxy } from '../../src/main/macos-environment';

vi.mock('shell-env', () => ({ shellEnv: vi.fn() }));
vi.mock('../../src/main/proxy-runtime', () => ({ applyNodeEnvProxy: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

const scutilOutput = `<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 7897
  SOCKSProxy : 127.0.0.1
}`;


const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy'
] as const;

function clearProxyEnv(): void {
  for (const key of PROXY_ENV_KEYS) {
    delete process.env[key];
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  clearProxyEnv();
  vi.mocked(applyNodeEnvProxy).mockClear();
  vi.mocked(execFile).mockReset();
});

it('restores the login shell PATH without copying other shell environment values', async () => {
  clearProxyEnv();
  vi.stubEnv('PATH', '/usr/bin:/bin');
  vi.stubEnv('ROC_LOGIN_SECRET', 'original');
  vi.mocked(shellEnv).mockResolvedValue({ PATH: '/opt/homebrew/bin:/usr/bin:/bin', ROC_LOGIN_SECRET: 'shell-only' });
  mockScutil(scutilOutput);
  await initializeMacOSPath();
  expect(process.env.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin');
  expect(process.env.ROC_LOGIN_SECRET).toBe('original');
});

it('copies login-shell proxy variables and reapplies the Node env proxy dispatcher', async () => {
  clearProxyEnv();
  vi.stubEnv('PATH', '/usr/bin:/bin');
  vi.mocked(shellEnv).mockResolvedValue({
    PATH: '/opt/homebrew/bin:/usr/bin:/bin',
    HTTP_PROXY: 'http://127.0.0.1:7897',
    HTTPS_PROXY: 'http://127.0.0.1:7897',
    ALL_PROXY: 'socks5://127.0.0.1:7897',
    NO_PROXY: '127.0.0.1,localhost,::1',
    http_proxy: 'http://127.0.0.1:7897',
    https_proxy: 'http://127.0.0.1:7897',
    all_proxy: 'socks5://127.0.0.1:7897',
    no_proxy: '127.0.0.1,localhost,::1',
    ROC_LOGIN_SECRET: 'shell-only'
  });
  await initializeMacOSPath();
  expect(process.env.HTTP_PROXY).toBe('http://127.0.0.1:7897');
  expect(process.env.HTTPS_PROXY).toBe('http://127.0.0.1:7897');
  expect(process.env.ALL_PROXY).toBe('socks5://127.0.0.1:7897');
  expect(process.env.NO_PROXY).toBe('127.0.0.1,localhost,::1');
  expect(process.env.http_proxy).toBe('http://127.0.0.1:7897');
  expect(process.env.https_proxy).toBe('http://127.0.0.1:7897');
  expect(process.env.all_proxy).toBe('socks5://127.0.0.1:7897');
  expect(process.env.no_proxy).toBe('127.0.0.1,localhost,::1');
  expect(process.env.ROC_LOGIN_SECRET).toBeUndefined();
  expect(applyNodeEnvProxy).toHaveBeenCalledTimes(1);
  expect(execFile).not.toHaveBeenCalled();
});

it('falls back to the macOS system HTTP proxy when the login shell has no proxy variables', async () => {
  clearProxyEnv();
  vi.stubEnv('PATH', '/usr/bin:/bin');
  vi.mocked(shellEnv).mockResolvedValue({ PATH: '/opt/homebrew/bin:/usr/bin:/bin' });
  mockScutil(scutilOutput);
  await initializeMacOSPath();
  expect(process.env.HTTP_PROXY).toBe('http://127.0.0.1:7897');
  expect(process.env.HTTPS_PROXY).toBe('http://127.0.0.1:7897');
  expect(process.env.ALL_PROXY).toBe('socks5://127.0.0.1:7897');
  expect(process.env.NO_PROXY).toBe('127.0.0.1,localhost,::1');
  expect(process.env.http_proxy).toBe('http://127.0.0.1:7897');
  expect(process.env.https_proxy).toBe('http://127.0.0.1:7897');
  expect(process.env.all_proxy).toBe('socks5://127.0.0.1:7897');
  expect(process.env.no_proxy).toBe('127.0.0.1,localhost,::1');
  expect(applyNodeEnvProxy).toHaveBeenCalledTimes(1);
});

it('keeps process env unchanged when neither login shell nor system proxy is configured', async () => {
  clearProxyEnv();
  vi.stubEnv('PATH', '/usr/bin:/bin');
  vi.mocked(shellEnv).mockResolvedValue({ PATH: '/opt/homebrew/bin:/usr/bin:/bin' });
  mockScutil('<dictionary> { HTTPEnable : 0 HTTPSEnable : 0 SOCKSEnable : 0 }');
  await initializeMacOSPath();
  expect(process.env.HTTP_PROXY).toBeUndefined();
  expect(process.env.HTTPS_PROXY).toBeUndefined();
  expect(applyNodeEnvProxy).toHaveBeenCalledTimes(1);
});

it('parses enabled macOS system proxy values into Node env keys', () => {
  expect(parseMacOSSystemProxy(scutilOutput)).toEqual({
    HTTP_PROXY: 'http://127.0.0.1:7897',
    HTTPS_PROXY: 'http://127.0.0.1:7897',
    ALL_PROXY: 'socks5://127.0.0.1:7897',
    NO_PROXY: '127.0.0.1,localhost,::1',
    http_proxy: 'http://127.0.0.1:7897',
    https_proxy: 'http://127.0.0.1:7897',
    all_proxy: 'socks5://127.0.0.1:7897',
    no_proxy: '127.0.0.1,localhost,::1'
  });
});

it('fails explicitly when a login shell does not return PATH', async () => {
  vi.mocked(shellEnv).mockResolvedValue({});
  await expect(initializeMacOSPath()).rejects.toThrow('macos_login_shell_path_missing');
  expect(applyNodeEnvProxy).not.toHaveBeenCalled();
  expect(execFile).not.toHaveBeenCalled();
});

it('skips login-shell PATH restore during packaged smoke', async () => {
  vi.stubEnv('ROC_SMOKE', '1');
  vi.stubEnv('PATH', '/usr/bin:/bin');
  await initializeMacOSPath();
  expect(shellEnv).not.toHaveBeenCalled();
  expect(process.env.PATH).toBe('/usr/bin:/bin');
  expect(applyNodeEnvProxy).not.toHaveBeenCalled();
  expect(execFile).not.toHaveBeenCalled();
});

function mockScutil(stdout: string): void {
  vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => {
    if (callback == null) {
      throw new Error('execFile_callback_missing');
    }
    callback(null, stdout, '');
    return {} as never;
  });
}
