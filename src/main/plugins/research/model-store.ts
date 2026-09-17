import { isAbsolute } from 'node:path';
import modelsLock from '../../../../resources/research-runtime/models.lock.json';
import { inspectInstalledModels, installModels } from '../../../../scripts/research/fetch-models';
import { ResearchProcessError } from './process-runner';

export type ResearchModelsStatus = {
  ready: boolean;
  downloading: boolean;
  error: string | null;
  models: Array<{ directory: string; repoId: string; ready: boolean }>;
};

export class ResearchModelStore {
  private download: Promise<ResearchModelsStatus> | null = null;

  constructor(private readonly rootPath: string | null) {}

  async status(): Promise<ResearchModelsStatus> {
    if (this.download !== null) {
      return { ...(await this.peek()), downloading: true };
    }
    return await this.peek();
  }

  async requireReady(): Promise<string> {
    const current = await this.peek(true);
    if (!current.ready || this.rootPath === null || !isAbsolute(this.rootPath)) {
      throw new ResearchProcessError(current.error ?? 'research_models_unavailable');
    }
    return this.rootPath;
  }

  async downloadAll(): Promise<ResearchModelsStatus> {
    if (this.rootPath === null || !isAbsolute(this.rootPath)) {
      throw new ResearchProcessError('research_models_unavailable');
    }
    if (this.download === null) {
      this.download = this.runDownload().finally(() => {
        this.download = null;
      });
    }
    return await this.download;
  }

  private async peek(verifyHashes = false): Promise<ResearchModelsStatus> {
    const inspected = await inspectInstalledModels(this.rootPath, modelsLock, { verifyHashes });
    return {
      ready: inspected.ready,
      downloading: false,
      error: inspected.error,
      models: inspected.models
    };
  }

  private async runDownload(): Promise<ResearchModelsStatus> {
    if (this.rootPath === null) throw new ResearchProcessError('research_models_unavailable');
    await installModels(modelsLock, this.rootPath);
    return await this.peek();
  }
}
