import type { ResearchModelsStatus } from '../../shared/types';
import type { IpcLikeResult } from '../app/loaded-state';
import type { RocClient } from './roc-client';

export function getModelsStatus(client: RocClient): Promise<IpcLikeResult<ResearchModelsStatus>> {
  return client.api.research.getModelsStatus();
}

export function downloadModels(
  client: RocClient,
  input: { pack: ResearchModelsStatus['selectedPack'] }
): Promise<IpcLikeResult<ResearchModelsStatus>> {
  return client.api.research.downloadModels(input);
}

export function selectModels(
  client: RocClient,
  input: { pack: ResearchModelsStatus['selectedPack'] }
): Promise<IpcLikeResult<ResearchModelsStatus>> {
  return client.api.research.selectModels(input);
}

export function importModels(client: RocClient, directory: string, pack: ResearchModelsStatus['selectedPack']): Promise<IpcLikeResult<ResearchModelsStatus>> {
  return client.api.research.importModels({ directory, pack });
}

export function removeModels(
  client: RocClient,
  pack: ResearchModelsStatus['selectedPack']
): Promise<IpcLikeResult<ResearchModelsStatus>> {
  return client.api.research.removeModels({ pack });
}

/** 取消下载：已下载的文件保留供续传。 */
export function cancelModels(client: RocClient): Promise<IpcLikeResult<ResearchModelsStatus>> {
  return client.api.research.cancelModelsDownload();
}

