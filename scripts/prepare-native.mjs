import { assertOnnxRuntimeNodeForPackaging, prepareWorkspaceNodePty } from './lib/native-packaging.mjs';

prepareWorkspaceNodePty();
if (process.platform === 'darwin' && process.arch === 'arm64') {
  assertOnnxRuntimeNodeForPackaging();
}
