import type {
  FileNameSearchResult,
  FilePreviewResult,
  FileSearchResult,
  FileTreeResult,
  FilesWorkbenchPdfPreviewResult,
  FileWriteResult,
  Workspace
} from '../../shared/types';
import type { IpcLikeResult } from '../app/loaded-state';
import type { RocClient } from '../shared/roc-client';
import { checkRelativePath, pathRejectionMessage } from './paths';

/**
 * Workspace + file data layer (P3/T3.1–T3.4).
 *
 * Every path sent through here is workspace-**relative** and is validated first.
 * The backend resolves it against the bound workspace and owns the real boundary;
 * validating locally exists so an escaping path fails immediately with a specific
 * message instead of becoming a vague backend error (R10). A rejection is
 * returned in the same `IpcLikeResult` shape the callers already handle, so there
 * is no second error path to forget.
 */

export function getCurrentWorkspace(client: RocClient): Promise<IpcLikeResult<Workspace | null>> {
  return client.api.workspace.getCurrent();
}

export function selectWorkspace(client: RocClient, path: string): Promise<IpcLikeResult<Workspace>> {
  return client.api.workspace.select({ path });
}

/** Native directory panel; `null` means the user cancelled. */
export function selectWorkspaceFromDialog(client: RocClient): Promise<IpcLikeResult<Workspace | null>> {
  return client.api.workspace.selectFromDialog();
}

function reject<R>(relativePath: string): IpcLikeResult<R> | null {
  const check = checkRelativePath(relativePath);
  if (check.ok) {
    return null;
  }
  return { ok: false, error: { message: pathRejectionMessage(check.reason) } };
}

/** Lists **one directory level**; `relativePath` is `''` for the workspace root. */
export function listTree(
  client: RocClient,
  relativePath: string,
  limit?: number
): Promise<IpcLikeResult<FileTreeResult>> {
  const rejected = reject<FileTreeResult>(relativePath);
  if (rejected !== null) {
    return Promise.resolve(rejected);
  }
  return client.api.files.listTree({ relativePath, limit });
}

export function previewFile(
  client: RocClient,
  relativePath: string,
  maxBytes?: number
): Promise<IpcLikeResult<FilePreviewResult>> {
  const rejected = reject<FilePreviewResult>(relativePath);
  if (rejected !== null) {
    return Promise.resolve(rejected);
  }
  return client.api.files.preview({ relativePath, maxBytes });
}

/**
 * PDF preview. Returns the backend's **custom-protocol URL**, which must be used
 * directly (`src={resourceUrl}` / `<iframe src>`). Blob URLs are forbidden here
 * because the file lives on disk and the renderer has no filesystem access (R9).
 */
export function previewPdf(
  client: RocClient,
  relativePath: string
): Promise<IpcLikeResult<FilesWorkbenchPdfPreviewResult>> {
  const rejected = reject<FilesWorkbenchPdfPreviewResult>(relativePath);
  if (rejected !== null) {
    return Promise.resolve(rejected);
  }
  return client.api.files.previewPdf({ relativePath });
}

/**
 * Writes text back to a workspace file.
 *
 * `source` is required by `fileWriteTextRequestSchema` and lands in the recovery
 * point the backend records, so it must name the surface that made the change.
 */
export function writeTextFile(
  client: RocClient,
  input: { relativePath: string; content: string; source: string; threadId?: string; runId?: string }
): Promise<IpcLikeResult<FileWriteResult>> {
  const rejected = reject<FileWriteResult>(input.relativePath);
  if (rejected !== null) {
    return Promise.resolve(rejected);
  }
  return client.api.files.writeText(input);
}

/** Content search (`files.search`): matches carry line/column/preview. */
export function searchFileContents(
  client: RocClient,
  query: string,
  maxResults?: number
): Promise<IpcLikeResult<FileSearchResult>> {
  return client.api.files.search({ query, maxResults });
}

/**
 * File-name search (`files.searchByName`) — a *different* backend query from
 * content search, and the one the sidebar's file field uses.
 */
export function searchFileNames(
  client: RocClient,
  query: string,
  maxResults?: number
): Promise<IpcLikeResult<FileNameSearchResult>> {
  return client.api.files.searchByName({ query, maxResults });
}
