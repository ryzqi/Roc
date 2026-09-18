import { shellEnv } from 'shell-env';
import { initializeMacOSPath } from '../../src/main/macos-environment';

vi.mock('shell-env', () => ({ shellEnv: vi.fn() }));

afterEach(() => vi.unstubAllEnvs());

it('restores the login shell PATH without copying other shell environment values', async () => {
  vi.stubEnv('PATH', '/usr/bin:/bin');
  vi.stubEnv('ROC_LOGIN_SECRET', 'original');
  vi.mocked(shellEnv).mockResolvedValue({ PATH: '/opt/homebrew/bin:/usr/bin:/bin', ROC_LOGIN_SECRET: 'shell-only' });
  await initializeMacOSPath();
  expect(process.env.PATH).toBe('/opt/homebrew/bin:/usr/bin:/bin');
  expect(process.env.ROC_LOGIN_SECRET).toBe('original');
});

it('fails explicitly when a login shell does not return PATH', async () => {
  vi.mocked(shellEnv).mockResolvedValue({});
  await expect(initializeMacOSPath()).rejects.toThrow('macos_login_shell_path_missing');
});

it('skips login-shell PATH restore during packaged smoke', async () => {
  vi.stubEnv('ROC_SMOKE', '1');
  vi.stubEnv('PATH', '/usr/bin:/bin');
  await initializeMacOSPath();
  expect(shellEnv).not.toHaveBeenCalled();
  expect(process.env.PATH).toBe('/usr/bin:/bin');
});
