const linuxLocalPathPattern = /(?:^|[\s"'`=({\[;&|,])\/(?:home\/user|tmp)(?=\/|$)/i;
const VIRTUAL_WORKSPACE_ROUTE = '/workspace';
const VIRTUAL_WORKSPACE_DELIMITERS = new Set([' ', '\t', '\r', '\n', '"', '\'', '`', '=', '(', '{', '[', ';', '&', '|', ',']);

const VIRTUAL_WORKSPACE_SHELL_ERROR = '/workspace/ 是 DeepAgents 文件工具路由，不是 Windows shell 路径。';
const LINUX_LOCAL_SHELL_ERROR = 'Roc 在 Windows 本地执行命令；请使用当前工作区 cwd 下的相对路径或 Windows 路径。';

export function containsVirtualWorkspacePath(value: string): boolean {
  const lowerValue = value.toLowerCase();
  let index = lowerValue.indexOf(VIRTUAL_WORKSPACE_ROUTE);
  while (index !== -1) {
    if (hasVirtualWorkspaceRouteBoundary(value, index)) {
      return true;
    }
    index = lowerValue.indexOf(VIRTUAL_WORKSPACE_ROUTE, index + VIRTUAL_WORKSPACE_ROUTE.length);
  }
  return false;
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

function hasVirtualWorkspaceRouteBoundary(value: string, index: number): boolean {
  const next = value[index + VIRTUAL_WORKSPACE_ROUTE.length];
  if (next !== undefined && next !== '/') {
    return false;
  }
  if (index === 0) {
    return true;
  }
  const previous = value[index - 1];
  if (previous === ':') {
    return !isWindowsDrivePrefix(value, index);
  }
  return previous !== undefined && VIRTUAL_WORKSPACE_DELIMITERS.has(previous);
}

function isWindowsDrivePrefix(value: string, workspaceRouteIndex: number): boolean {
  const driveLetterIndex = workspaceRouteIndex - 2;
  if (driveLetterIndex < 0) {
    return false;
  }
  const driveLetter = value[driveLetterIndex];
  if (driveLetter === undefined || !/^[A-Za-z]$/.test(driveLetter)) {
    return false;
  }
  if (driveLetterIndex === 0) {
    return true;
  }
  const beforeDriveLetter = value[driveLetterIndex - 1];
  return beforeDriveLetter !== undefined && VIRTUAL_WORKSPACE_DELIMITERS.has(beforeDriveLetter);
}
