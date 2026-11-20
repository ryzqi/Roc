import {AsyncLocalStorage} from 'node:async_hooks';

/** Native protocol metadata stays outside the public, strict capability input. */
export type DocumentSourceRequest = {
  method: string;
  range: string | null;
  session: string | null;
  release: boolean;
  signal: AbortSignal;
};

const requests = new AsyncLocalStorage<DocumentSourceRequest>();

export function withDocumentSourceRequest<T>(request: Request, run: () => T): T {
  const url = new URL(request.url);
  return requests.run({
    method: request.method, range: request.headers.get('range'),
    session: url.searchParams.get('session'), release: url.searchParams.get('release') === '1',
    signal: request.signal
  }, run);
}

export function documentSourceRequest(): DocumentSourceRequest | undefined {
  return requests.getStore();
}
