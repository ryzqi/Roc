const virtualWorkspaceRoutePattern = /(?:^|[\s"'`=({\[;&|,])\/workspace(?=\/|$)/i;
const linuxLocalPathPattern = /(?:^|[\s"'`=({\[;&|,])\/(?:home\/user|tmp)(?=\/|$)/i;

export const VIRTUAL_WORKSPACE_SHELL_ERROR = '/workspace/ 是 DeepAgents 文件工具路由，不是 Windows shell 路径。';
export const LINUX_LOCAL_SHELL_ERROR = 'Roc 在 Windows 本地执行命令；请使用当前工作区 cwd 下的相对路径或 Windows 路径。';

export function containsVirtualWorkspacePath(value: string): boolean {
  return virtualWorkspaceRoutePattern.test(value);
}

export function containsLinuxLocalPath(value: string): boolean {
  return linuxLocalPathPattern.test(value);
}

export function validateRocWindowsShellPath(value: string): void {
  if (containsVirtualWorkspacePath(value)) {
    throw new Error(VIRTUAL_WORKSPACE_SHELL_ERROR);
  }
  if (containsLinuxLocalPath(value)) {
    throw new Error(LINUX_LOCAL_SHELL_ERROR);
  }
}
