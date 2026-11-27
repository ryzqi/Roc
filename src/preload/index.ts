import { contextBridge, webUtils } from 'electron';

import { rocApi } from './ipc-api-generated';
import { createPdfDropApi } from './pdf-drop';

contextBridge.exposeInMainWorld('roc', rocApi);
contextBridge.exposeInMainWorld('rocPdfDrop', createPdfDropApi({
  getPathForFile: file => webUtils.getPathForFile(file),
  importDocument: rocApi.research.importDocument
}));
