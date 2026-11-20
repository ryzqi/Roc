import { setGlobalProxyFromEnv } from 'node:http';

export function applyNodeEnvProxy(): void {
  if (process.env.NODE_USE_ENV_PROXY === undefined) {
    process.env.NODE_USE_ENV_PROXY = '1';
  }
  setGlobalProxyFromEnv();
}

applyNodeEnvProxy();
