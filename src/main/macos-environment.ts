import { shellEnv } from 'shell-env';

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
}
