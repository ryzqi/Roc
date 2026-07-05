import type { IpcResult } from '../../shared/types';

export type IpcHandler<T> = () => Promise<IpcResult<T>> | IpcResult<T>;
// Keep channel-specific payload types while storing handlers behind one IPC registry shape.
export type IpcMainHandler = {
  handle(...args: unknown[]): Promise<IpcResult<unknown>> | IpcResult<unknown>;
}['handle'];
export type TimedHandle = (channel: string, handler: IpcMainHandler) => void;
