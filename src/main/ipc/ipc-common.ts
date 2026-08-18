import { parseIpcRequestArgs, parseIpcResult } from '../../shared/ipc-registry';
import type { IpcResult } from '../../shared/types';
import { toRocError } from '../services/errors';

export type IpcHandler<T> = () => Promise<IpcResult<T>> | IpcResult<T>;
// Keep channel-specific payload types while storing handlers behind one IPC registry shape.
export type IpcMainHandler = {
  handle(...args: unknown[]): Promise<IpcResult<unknown>> | IpcResult<unknown>;
}['handle'];
export type TimedHandle = (channel: string, handler: IpcMainHandler) => void;

export async function executeIpcRequest(
  channel: string,
  event: unknown,
  args: unknown[],
  handler: IpcMainHandler
): Promise<IpcResult<unknown>> {
  try {
    const parsedArgs = parseIpcRequestArgs(channel, args);
    const result = await handler(event, ...parsedArgs);
    return parseIpcResult(channel, result);
  } catch (error) {
    return {
      ok: false,
      error: toRocError(error, {
        service: 'ipc',
        component: 'executeIpcRequest',
        metadata: { channel }
      })
    };
  }
}
