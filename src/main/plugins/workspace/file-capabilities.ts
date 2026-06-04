import type {
  FileDeleteResult,
  FilePreviewRequest,
  FilePreviewResult,
  FileSearchRequest,
  FileSearchResult,
  FileTreeRequest,
  FileTreeResult,
  FilesWorkbenchPdfPreviewRequest,
  FilesWorkbenchPdfPreviewResult,
  FileWriteResult,
  FileWriteTextRequest
} from '../../../shared/types';
import type { CapabilityDescriptor, RocPluginContext } from '../../kernel/types';
import type { FileService } from '../../services/file-service';

const pluginId = '@roc/plugin-workspace';

export function registerFileCapabilities(
  context: RocPluginContext,
  descriptors: readonly CapabilityDescriptor[],
  fileService: FileService
): void {
  context.capabilities.register(pluginId, descriptors[0], async (input) =>
    fileService.listTree(input as FileTreeRequest)
  );
  context.capabilities.register(pluginId, descriptors[1], async (input) =>
    fileService.search(input as FileSearchRequest)
  );
  context.capabilities.register(pluginId, descriptors[2], async (input) =>
    fileService.readPreview(input as FilePreviewRequest)
  );
  context.capabilities.register(pluginId, descriptors[3], async (input) =>
    fileService.readPdfWorkbenchPreview(input as FilesWorkbenchPdfPreviewRequest)
  );
  context.capabilities.register(pluginId, descriptors[4], async (input) =>
    fileService.writeTextFile(input as FileWriteTextRequest)
  );
  context.capabilities.register(pluginId, descriptors[5], async (input) =>
    fileService.deleteFile((input as { relativePath: string }).relativePath)
  );
}

export type WorkspaceFileCapabilityTypes = {
  listTree: {
    input: FileTreeRequest;
    output: FileTreeResult;
  };
  search: {
    input: FileSearchRequest;
    output: FileSearchResult;
  };
  preview: {
    input: FilePreviewRequest;
    output: FilePreviewResult;
  };
  previewPdf: {
    input: FilesWorkbenchPdfPreviewRequest;
    output: FilesWorkbenchPdfPreviewResult;
  };
  writeText: {
    input: FileWriteTextRequest;
    output: FileWriteResult;
  };
  delete: {
    input: { relativePath: string };
    output: FileDeleteResult;
  };
};
