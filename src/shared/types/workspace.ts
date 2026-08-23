import type { z } from 'zod';

import {
  fileDialogSelectionSchema,
  fileNameSearchRequestSchema,
  fileNameSearchResultSchema,
  filePdfPreviewRequestSchema,
  filePdfPreviewResultSchema,
  filePreviewRequestSchema,
  filePreviewResultSchema,
  fileSearchRequestSchema,
  fileSearchResultSchema,
  fileTreeRequestSchema,
  fileTreeResultSchema,
  fileWriteResultSchema,
  fileWriteTextRequestSchema,
  workspaceChangedEventSchema,
  workspaceSchema,
  workspaceSelectRequestSchema
} from '../schemas/ipc-workspace';

export type Workspace = z.infer<typeof workspaceSchema>;
export type WorkspaceTrustState = Workspace['trustState'];
export type WorkspaceSelectRequest = z.infer<typeof workspaceSelectRequestSchema>;
export type WorkspaceChangedEvent = z.infer<typeof workspaceChangedEventSchema>;
export type FileDialogSelection = z.infer<typeof fileDialogSelectionSchema>;
export type FileTreeRequest = z.infer<typeof fileTreeRequestSchema>;
export type FileTreeResult = z.infer<typeof fileTreeResultSchema>;
export type FileEntry = FileTreeResult['entries'][number];
export type FileEntryShape = Pick<FileEntry, 'name' | 'relativePath' | 'type'>;
export type FileSearchRequest = z.infer<typeof fileSearchRequestSchema>;
export type FileSearchResult = z.infer<typeof fileSearchResultSchema>;
export type FileSearchMatch = FileSearchResult['matches'][number];
export type FileNameSearchRequest = z.infer<typeof fileNameSearchRequestSchema>;
export type FileNameSearchResult = z.infer<typeof fileNameSearchResultSchema>;
export type FileNameSearchMatch = FileNameSearchResult['matches'][number];
export type FilePreviewRequest = z.infer<typeof filePreviewRequestSchema>;
export type FilePreviewResult = z.infer<typeof filePreviewResultSchema>;

export type FilePreviewLike = {
  relativePath: string;
  kind: 'text' | 'image' | 'binary';
  content: string;
  sizeBytes: number;
  mediaType?: string;
  truncated?: boolean;
};

export type FilesWorkbenchPdfPreviewRequest = z.infer<typeof filePdfPreviewRequestSchema>;
export type FilesWorkbenchPdfPreviewResult = z.infer<typeof filePdfPreviewResultSchema>;
export type FilesWorkbenchPdfPreview = FilesWorkbenchPdfPreviewResult;
export type FileWriteTextRequest = z.infer<typeof fileWriteTextRequestSchema>;
export type FileWriteResult = z.infer<typeof fileWriteResultSchema>;
export type RecoveryPoint = FileWriteResult['recoveryPoint'];

export type FileDeleteResult = {
  relativePath: string;
  recoveryPoint: RecoveryPoint;
};
