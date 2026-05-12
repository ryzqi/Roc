import {
  Archive,
  Code2,
  File,
  FileArchive,
  FileAudio2,
  FileCog,
  FileImage,
  FileJson2,
  FileSpreadsheet,
  FileText,
  FileType2,
  FileVideo2,
  Folder,
  FolderOpen
} from 'lucide-react';
import type { FileEntryShape, FilePreviewLike } from '../../shared/types';

export type TreeNode = {
  entry: FileEntryShape;
  depth: number;
};

export function parentRelativePath(relativePath: string): string | null {
  const parts = relativePath.split('/').filter((part) => part.length > 0);
  if (parts.length <= 1) {
    return null;
  }
  return parts.slice(0, -1).join('/');
}

export function fileLabel(relativePath: string): string {
  const parts = relativePath.split('/').filter((part) => part.length > 0);
  return parts.at(-1) ?? relativePath;
}

export function fileExtension(relativePath: string): string {
  const label = fileLabel(relativePath);
  const dotIndex = label.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === label.length - 1) {
    return '';
  }
  return label.slice(dotIndex + 1).toLowerCase();
}

export function compareFileEntries(left: FileEntryShape, right: FileEntryShape): number {
  if (left.type !== right.type) {
    return left.type === 'directory' ? -1 : 1;
  }
  return left.name.localeCompare(right.name, 'zh-Hans-CN');
}

export function flattenTreeEntries<E extends FileEntryShape>(
  entries: E[],
  expandedDirectories: Set<string>,
  childEntries: Record<string, E[]>
): TreeNode[] {
  const rootEntries = [...entries].sort(compareFileEntries);
  const nodes: TreeNode[] = [];

  function visit(list: E[], depth: number): void {
    for (const entry of list) {
      nodes.push({ entry, depth });
      if (entry.type !== 'directory' || !expandedDirectories.has(entry.relativePath)) {
        continue;
      }
      const children = childEntries[entry.relativePath];
      if (children === undefined) {
        continue;
      }
      visit([...children].sort(compareFileEntries), depth + 1);
    }
  }

  visit(rootEntries, 0);
  return nodes;
}

export function fileTypeLabel(preview: FilePreviewLike | null): string {
  if (preview === null) {
    return '未加载';
  }
  if (preview.kind === 'image') {
    return preview.mediaType ?? '图片';
  }
  if (preview.kind === 'binary') {
    return '二进制文件';
  }
  const extension = fileExtension(preview.relativePath);
  return extension.length === 0 ? '文本文件' : `${extension.toUpperCase()} 文件`;
}

export function fileTreeIcon(entry: FileEntryShape, active: boolean, expanded: boolean): React.JSX.Element {
  const className = active ? 'tree-item-file-icon tree-item-file-icon--active' : 'tree-item-file-icon';
  if (entry.type === 'directory') {
    const DirectoryIcon = expanded ? FolderOpen : Folder;
    return <DirectoryIcon className={className} size={16} strokeWidth={1.8} />;
  }
  const extension = fileExtension(entry.relativePath);
  const lowerName = entry.name.toLowerCase();
  if (['md', 'txt', 'log'].includes(extension)) {
    return <FileText className={className} size={16} strokeWidth={1.8} />;
  }
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(extension)) {
    return <Code2 className={className} size={16} strokeWidth={1.8} />;
  }
  if (extension === 'json') {
    return <FileJson2 className={className} size={16} strokeWidth={1.8} />;
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(extension)) {
    return <FileImage className={className} size={16} strokeWidth={1.8} />;
  }
  if (['css', 'scss', 'sass', 'less'].includes(extension)) {
    return <FileType2 className={className} size={16} strokeWidth={1.8} />;
  }
  if (['toml', 'yaml', 'yml', 'ini', 'env', 'conf'].includes(extension) || lowerName.includes('config')) {
    return <FileCog className={className} size={16} strokeWidth={1.8} />;
  }
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(extension)) {
    return <FileArchive className={className} size={16} strokeWidth={1.8} />;
  }
  if (['mp3', 'wav', 'flac', 'aac', 'ogg'].includes(extension)) {
    return <FileAudio2 className={className} size={16} strokeWidth={1.8} />;
  }
  if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(extension)) {
    return <FileVideo2 className={className} size={16} strokeWidth={1.8} />;
  }
  if (['csv', 'tsv', 'xlsx', 'xls', 'doc', 'docx', 'pdf'].includes(extension)) {
    return <FileSpreadsheet className={className} size={16} strokeWidth={1.8} />;
  }
  if (['exe', 'dll', 'bin', 'dat', 'db'].includes(extension)) {
    return <Archive className={className} size={16} strokeWidth={1.8} />;
  }
  return <File className={className} size={16} strokeWidth={1.8} />;
}

export function isImagePreview(preview: FilePreviewLike | null): preview is FilePreviewLike & { kind: 'image'; mediaType: string } {
  return preview !== null && preview.kind === 'image' && typeof preview.mediaType === 'string';
}

export function previewTextBody(preview: FilePreviewLike | null): string {
  if (preview === null) {
    return '当前没有加载可预览内容。';
  }
  if (preview.kind === 'binary') {
    return `二进制文件，大小 ${preview.sizeBytes} bytes。`;
  }
  if (preview.kind === 'image') {
    return `图片文件，大小 ${preview.sizeBytes} bytes。`;
  }
  return preview.content;
}
