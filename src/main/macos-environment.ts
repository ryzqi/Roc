import { shellEnv } from 'shell-env';

export async function initializeMacOSPath(): Promise<void> {
  const environment = await shellEnv();
  if (!environment.PATH) {
    throw new Error('macos_login_shell_path_missing');
  }
  process.env.PATH = environment.PATH;
}
