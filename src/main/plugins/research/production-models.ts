import {mkdir, realpath} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';
import {release} from 'node:os';
import type {ResearchModelPack} from '../../../shared/schemas/research-production';
import {researchDerivationGenerationVersion, researchParserIdentityPayload} from '../../../shared/schemas/research-production';
import {ovisParserVersion, ovisRuntime} from '../../../shared/schemas/research-ovis';
import {ResearchModelStore, type ResearchModelsStatus} from './model-store';
import {modelPackManifest} from './model-catalog';
import {OvisInstallationManager} from './ovis-installation-manager';
import {defaultProjectPythonVersion, ResearchPythonRuntimeStore} from './python-runtime-store';
import {ovisDownloadAssets} from './ovis-downloads';
import {researchContentHash} from './research-files';

export type OvisProductionConfig = {pythonRoot: string; specification: string};
type Manager = Pick<OvisInstallationManager, 'installed' | 'acquire' | 'install' | 'remove'>;
type Dependencies = {
  manager: (root: string, specification: string) => Manager;
  runtime: (root: string) => Pick<ResearchPythonRuntimeStore, 'prepare'>;
};
const defaults: Dependencies = {manager: (root, spec) => new OvisInstallationManager(root, spec),
  runtime: root => new ResearchPythonRuntimeStore(root)};
const downloadBytes = ovisDownloadAssets().reduce((sum, asset) => sum + asset.size, 0);
const modelId = 'ovisocr3-mlx-8bit';
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : 'research_model_operation_failed';

/** Product tiers select independent model installations. Complete never falls back to compact. */
export class ResearchProductionModels {
  private readonly compact: ResearchModelStore;
  private pack: ResearchModelPack = 'compact';
  private persist: ((pack: ResearchModelPack) => void) | null = null;
  private managerPromise: Promise<Manager> | null = null;
  private controller: AbortController | null = null;
  private job: ResearchModelsStatus['job'] = null;
  private lastError: string | null = null;

  constructor(private readonly root: string | null, private readonly config: OvisProductionConfig | null,
    private readonly dependencies: Dependencies = defaults) {
    this.compact = new ResearchModelStore(root);
  }

  attachConfig(config: {get<T>(key: string): T | null; set<T>(key: string, value: T): void}): void {
    const key = 'researchModelPreferences';
    const saved = config.get<{pack?: unknown}>(key)?.pack;
    this.pack = saved === 'complete' ? 'complete' : 'compact';
    this.persist = pack => config.set(key, {pack});
  }
  get selectedPack(): ResearchModelPack {return this.pack;}
  select(pack: ResearchModelPack): void {
    if (this.controller) throw new Error('research_model_download_locked');
    this.pack = pack; this.persist?.(pack);
  }
  tryRequireCompact(): ReturnType<ResearchModelStore['tryRequireReady']> {return this.compact.tryRequireReady('compact');}
  releaseCompact(): void {this.compact.release('compact');}

  async ovis(): Promise<Manager> {
    if (!this.config || !this.root || !isAbsolute(this.root)) throw new Error('research_ovis_unavailable');
    // The pinned OpenCV wheel requires macOS 15 (Darwin 24).
    if (process.platform !== 'darwin' || process.arch !== 'arm64' || Number(release().split('.')[0]) < 24) {
      throw new Error('research_ovis_platform_unsupported');
    }
    this.managerPromise ??= (async () => {
      await mkdir(this.root!, {recursive: true, mode: 0o700});
      return this.dependencies.manager(join(await realpath(this.root!), 'ovisocr3'), await realpath(this.config!.specification));
    })().catch(error => {this.managerPromise = null; throw error;});
    return this.managerPromise;
  }

  async identity(tier: ResearchModelPack): Promise<string> {
    if (tier === 'compact') return researchContentHash(JSON.stringify(researchParserIdentityPayload(modelPackManifest('compact'))));
    const lease = await (await this.ovis()).acquire(new AbortController().signal);
    try {
      return researchContentHash(JSON.stringify({engine: 'ovisocr3-mlx', model: lease.installation.identity,
        version: ovisParserVersion, runtime: ovisRuntime, generation: researchDerivationGenerationVersion}));
    } finally {lease.release();}
  }

  async status(): Promise<ResearchModelsStatus> {
    const basic = await this.compact.status();
    let ready = false, installedBytes = 0, error: string | null = null;
    if (!this.job) {
      try {
        const manager = await this.ovis();
        if (await manager.installed()) {
          const lease = await manager.acquire(new AbortController().signal);
          try {ready = true; installedBytes = lease.bytes;} finally {lease.release();}
        } else error = 'research_ovis_installation_missing';
      } catch (failure) {error = errorMessage(failure);}
    }
    const complete: ResearchModelsStatus['packs'][number] = {
      pack: 'complete', ready, bytes: downloadBytes, installedBytes,
      state: this.job?.phase ?? (ready ? 'ready' : error === 'research_ovis_installation_missing' ? 'missing' : 'incompatible'),
      error: this.lastError ?? error, models: [modelId]
    };
    const packs = [...basic.packs.filter(pack => pack.pack === 'compact'), complete];
    const compactIds = new Set(packs[0].models);
    const selected = packs.find(pack => pack.pack === this.selectedPack)!;
    return {selectedPack: this.selectedPack, ready: selected.ready, downloading: this.controller !== null || basic.downloading,
      error: selected.pack === 'complete' ? complete.error : basic.error, job: this.job ?? basic.job, packs,
      models: [...basic.models.filter(model => compactIds.has(model.id)),
        {id: modelId, name: 'OvisOCR3 8-bit (MLX)', kind: 'mlx', ready, bytes: installedBytes, error: complete.error}]};
  }

  async download(pack: ResearchModelPack): Promise<ResearchModelsStatus> {
    if (this.controller) throw new Error('research_model_download_locked');
    this.pack = pack; this.persist?.(pack);
    const controller = new AbortController(); this.controller = controller; this.lastError = null;
    try {
      if (pack === 'compact') await this.compact.download('compact', controller.signal);
      else {
        this.job = {pack, phase: 'verifying', bytesDone: 0, bytesTotal: 0, startedAt: new Date().toISOString()};
        const manager = await this.ovis();
        if (await manager.installed()) {
          const lease = await manager.acquire(controller.signal); lease.release();
        } else {
          const runtime = await this.dependencies.runtime(this.config!.pythonRoot).prepare(defaultProjectPythonVersion,
            'research-ovis-models', controller.signal, phase => {
              this.job = {...this.job!, phase, bytesDone: 0, bytesTotal: 0};
            });
          await manager.install({runtime, projectId: 'research-ovis-models', signal: controller.signal,
            onProgress: progress => {
              this.job = {...this.job!, phase: progress.phase, bytesDone: 'bytesDone' in progress ? progress.bytesDone : 0,
                bytesTotal: 'bytesTotal' in progress ? progress.bytesTotal : 0};
            }});
        }
      }
    } catch (error) {
      this.lastError = controller.signal.aborted ? 'research_download_cancelled' : errorMessage(error);
      throw error;
    } finally {this.job = null; this.controller = null;}
    return this.status();
  }

  async cancel(): Promise<ResearchModelsStatus> {
    this.controller?.abort(new Error('research_download_cancelled'));
    return this.status();
  }
  async importCompact(directory: string): Promise<ResearchModelsStatus> {
    if (this.controller) throw new Error('research_model_download_locked');
    await this.compact.importDirectory(directory, 'compact');
    return this.status();
  }
  async remove(pack: ResearchModelPack): Promise<ResearchModelsStatus> {
    if (this.controller) throw new Error('research_model_download_locked');
    if (pack === 'complete') {await (await this.ovis()).remove(); this.lastError = null;}
    else await this.compact.remove('compact');
    return this.status();
  }
}
