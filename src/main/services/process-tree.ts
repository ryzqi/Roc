import type { ChildProcess } from 'node:child_process';

// 调用方以 detached: true 创建独立进程组，取消时一并清理 Shell 派生的子进程。
export function terminateProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // The group can dissolve while SIGKILL is in flight; macOS reports EPERM in that window
    // instead of ESRCH. Only treat it as cleaned once a follow-up probe proves the group is gone;
    // a group that still exists but cannot be signalled stays a visible failure.
    if (code === 'ESRCH' || (code === 'EPERM' && !processGroupExists(pid))) {
      return;
    }
    throw error;
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    // ESRCH is the only proof that no member remains; EPERM keeps the failure closed.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
