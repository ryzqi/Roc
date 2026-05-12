export type WorkspaceTrustState = 'trusted' | 'limited' | 'blocked';

export type Workspace = {
  id: string;
  path: string;
  displayName: string;
  lastOpenedAt: string;
  trustState: WorkspaceTrustState;
  defaultShell?: string;
};

export type WorkspaceSelectRequest = {
  path: string;
};

export type FileDialogSelection = {
  filePaths: string[];
};

export type FileEntry = {
  name: string;
  relativePath: string;
  type: 'file' | 'directory';
  size: number;
  updatedAt: string;
};

export type FileEntryShape = Pick<FileEntry, 'name' | 'relativePath' | 'type'>;

export type FileTreeRequest = {
  relativePath: string;
  limit?: number;
};

export type FileTreeResult = {
  workspacePath: string;
  relativePath: string;
  entries: FileEntry[];
  truncated: boolean;
};

export type FileSearchRequest = {
  query: string;
  maxResults?: number;
};

export type FileSearchMatch = {
  relativePath: string;
  line: number;
  column: number;
  preview: string;
};

export type FileSearchResult = {
  query: string;
  matches: FileSearchMatch[];
  truncated: boolean;
};

export type FilePreviewRequest = {
  relativePath: string;
  maxBytes?: number;
};

export type FilePreviewResult = {
  relativePath: string;
  kind: 'text' | 'image' | 'binary';
  content: string;
  truncated: boolean;
  sizeBytes: number;
  mediaType?: string;
};

export type FilePreviewLike = {
  relativePath: string;
  kind: 'text' | 'image' | 'binary';
  content: string;
  sizeBytes: number;
  mediaType?: string;
  truncated?: boolean;
};

export type FileWriteTextRequest = {
  relativePath: string;
  content: string;
  source: string;
  threadId?: string;
  runId?: string;
};

export type RecoveryPoint = {
  id: string;
  relativePath: string;
  snapshotPath: string;
  contentSha256: string;
  source: string;
  createdAt: string;
  restored: boolean;
};

export type FileWriteResult = {
  relativePath: string;
  recoveryPoint: RecoveryPoint;
  bytesWritten: number;
};
