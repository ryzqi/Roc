import {AsyncLocalStorage} from 'node:async_hooks';

const owners = new AsyncLocalStorage<number>();

/** Ownership comes from the validated IPC sender, never from wire arguments. */
export function withTerminalOwner<T>(owner: number, action: () => T): T {
  if (!Number.isInteger(owner) || owner <= 0) throw new Error('terminal_sender_required');
  return owners.run(owner, action);
}

/** Direct main-process callers own the reserved owner 0. */
export function terminalOwner(): number { return owners.getStore() ?? 0; }
