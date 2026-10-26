export const ignoredFileNameSearchDirectories = [
  'node_modules',
  '.git',
  'dist',
  'out',
  'release',
  'coverage',
  '.cache',
  '.tmp',
  '.runtime',
  '.artifacts'
] as const;

const ignoredDirectoryNames = new Set<string>(ignoredFileNameSearchDirectories);

export function isIgnoredFileNameSearchDirectory(directoryName: string): boolean {
  return ignoredDirectoryNames.has(directoryName);
}

/** Watcher paths do not identify whether their final component is a file or directory. */
export function hasIgnoredFileNameSearchParentDirectory(relativePath: string): boolean {
  const segments = relativePath.split('/');
  return segments.slice(0, -1).some(isIgnoredFileNameSearchDirectory);
}
