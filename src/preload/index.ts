import { contextBridge } from 'electron';

import { rocApi } from './ipc-api-generated';

contextBridge.exposeInMainWorld('roc', rocApi);
