export type AsyncState<TData> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { data: TData; status: 'loaded' }
  | { message: string; status: 'failed' };

export function idleAsyncState<TData>(): AsyncState<TData> {
  return { status: 'idle' };
}

export function loadingAsyncState<TData>(): AsyncState<TData> {
  return { status: 'loading' };
}

export function loadedAsyncState<TData>(data: TData): AsyncState<TData> {
  return { data, status: 'loaded' };
}

export function failedAsyncState<TData>(message: string): AsyncState<TData> {
  return { message, status: 'failed' };
}
