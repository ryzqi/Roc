import type { IpcResult } from '../../shared/types';

export type IpcHandler<T> = () => Promise<IpcResult<T>> | IpcResult<T>;
export type IpcMainHandler = (...args: any[]) => Promise<IpcResult<unknown>> | IpcResult<unknown>;
export type TimedHandle = (channel: string, handler: IpcMainHandler) => void;
