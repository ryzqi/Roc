import { createHash } from 'node:crypto';
import type { RocHookCommandHandler, RocHookEventName } from '../../../shared/types';

type HashInput = {
  event: RocHookEventName;
  matcher: string | null;
  handler: RocHookCommandHandler;
};

export function computeHookHandlerHash(input: HashInput): string {
  const canonical = {
    event: input.event,
    matcher: input.matcher,
    type: input.handler.type,
    command: input.handler.command,
    commandWindows: input.handler.commandWindows === undefined ? null : input.handler.commandWindows,
    timeoutSeconds: input.handler.timeoutSeconds,
    failureMode: input.handler.failureMode
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function createHookHandlerId(input: { event: RocHookEventName; groupIndex: number; hookIndex: number }): string {
  return `${input.event}:${input.groupIndex}:${input.hookIndex}`;
}

export function createHookRunId(input: { parentRunId: string; handlerId: string }): string {
  return `${input.parentRunId}:hook:${input.handlerId}`;
}
