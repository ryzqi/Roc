import type {RocPreloadApi} from '../shared/ipc';
import type {RocPdfDropApi} from '../shared/pdf-drop';
import type {IpcResult} from '../shared/types/common';
import type {ResearchDocument} from '../shared/types/research';

type Dependencies = {
  getPathForFile: (file: File) => string;
  importDocument: RocPreloadApi['research']['importDocument'];
};

function invalidInput(code: string, message: string): IpcResult<ResearchDocument> {
  return {ok: false, error: {code, message, category: 'validation', retryable: false}};
}

/** Resolve only a native PDF File, then use the existing main-process import boundary. */
export function createPdfDropApi({getPathForFile, importDocument}: Dependencies): RocPdfDropApi {
  return {
    async importPdf(file, options) {
      let sourcePath: string;
      try {
        sourcePath = getPathForFile(file);
      } catch {
        return invalidInput('pdf_drop_source_invalid', '请拖入本机的 PDF 文件。');
      }
      if (typeof sourcePath !== 'string' || !sourcePath.toLowerCase().endsWith('.pdf')) {
        return invalidInput('pdf_drop_source_invalid', '请拖入本机的 PDF 文件。');
      }
      if (typeof options !== 'object' || options === null) {
        return invalidInput('pdf_drop_options_invalid', 'PDF 导入信息无效，请重试。');
      }
      try {
        // Explicit fields prevent a renderer object from replacing the native
        // source path, target or destination with extra request properties.
        return await importDocument({
          target: 'new-item',
          sourcePath,
          title: options.title,
          citationKey: options.citationKey,
          projectId: options.projectId,
          ...(options.metadataMode === undefined ? {} : {metadataMode: options.metadataMode})
        });
      } catch {
        // A rejected IPC transport can include native details in its exception.
        return {ok: false, error: {code: 'pdf_drop_import_failed', message: 'PDF 导入失败，请重试。',
          category: 'internal', retryable: true}};
      }
    }
  };
}
