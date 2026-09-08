import type { ChildProcess } from 'node:child_process';

// 调用方以 detached: true 创建独立进程组，取消时一并清理 Shell 派生的子进程。
export function terminateProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
      return;
    }
    throw error;
  }
}
