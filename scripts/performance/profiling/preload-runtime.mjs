import {contextBridge, ipcRenderer} from 'electron';
import {createIpcProfileCollector} from './collectors.mjs';

const collector = createIpcProfileCollector((...args) => ipcRenderer.invoke(...args));
contextBridge.exposeInMainWorld('__rocIpcProfile', {
  begin: name => collector.begin(name), end: () => collector.end(), snapshot: () => collector.snapshot()
});
export const profileInvoke = (...args) => collector.invoke(...args);
