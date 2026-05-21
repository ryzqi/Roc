import { setGlobalProxyFromEnv } from 'node:http';

if (process.env.NODE_USE_ENV_PROXY === undefined) {
  process.env.NODE_USE_ENV_PROXY = '1';
}

setGlobalProxyFromEnv();
