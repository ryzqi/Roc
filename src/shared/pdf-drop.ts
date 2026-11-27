import type {RocPreloadApi} from './ipc';
import type {ResearchDocumentImportRequest} from './types/research';

export type PdfDropImportOptions = Omit<
  Extract<ResearchDocumentImportRequest, {target: 'new-item'}>,
  'sourcePath' | 'target'
>;

/** A native File capability; source paths never become renderer API results. */
export interface RocPdfDropApi {
  importPdf(file: File, options: PdfDropImportOptions): ReturnType<RocPreloadApi['research']['importDocument']>;
}
