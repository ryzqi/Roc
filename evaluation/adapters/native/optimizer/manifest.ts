import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { contentHash } from './surface';

/** P5-05: a resumable experiment manifest. Each completed stage leaves a receipt hash. */
export const manifestStages = ['dataset', 'propose', 'validate', 'probe-base', 'probe-candidate', 'compose', 'adopt'] as const;
export type ManifestStage = (typeof manifestStages)[number];

export type StageReceipt = { completedAt: string; receiptHash: string };
export type ExperimentManifest = {
  schemaVersion: 1;
  experimentId: string;
  datasetHash: string;
  baseSurfaceHash: string;
  stages: Partial<Record<ManifestStage, StageReceipt>>;
};

export type StageRunResult<T> = { skipped: boolean; receipt: T };

export class ExperimentManifestStore {
  constructor(private readonly path: string) {}

  read(): ExperimentManifest | null {
    if (!existsSync(this.path)) return null;
    let parsed: ExperimentManifest;
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8')) as ExperimentManifest;
    } catch (error) {
      throw new Error(`optimizer_manifest_corrupt:${String(error)}`);
    }
    if (parsed.schemaVersion !== 1) throw new Error(`optimizer_manifest_version:${String(parsed.schemaVersion)}`);
    for (const stage of Object.keys(parsed.stages) as ManifestStage[]) {
      if (!manifestStages.includes(stage)) throw new Error(`optimizer_manifest_stage:${stage}`);
    }
    return parsed;
  }

  create(input: { experimentId: string; datasetHash: string; baseSurfaceHash: string }): ExperimentManifest {
    const manifest: ExperimentManifest = { schemaVersion: 1, ...input, stages: {} };
    this.write(manifest);
    return manifest;
  }

  /** Persist atomically: a crash leaves the previous manifest intact, never a half-written file. */
  write(manifest: ExperimentManifest): void {
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(manifest, null, 2));
    renameSync(temporary, this.path);
  }

  /**
   * Runs a stage exactly once per manifest. A completed stage is skipped without invoking the
   * callback, which is what makes resumption free of repeated side effects and repeated charges.
   */
  async runStage<T>(stage: ManifestStage, receipt: () => Promise<T> | T): Promise<StageRunResult<T | StageReceipt>> {
    const manifest = this.read();
    if (manifest === null) throw new Error('optimizer_manifest_missing');
    const existing = manifest.stages[stage];
    if (existing !== undefined) return { skipped: true, receipt: existing };
    const result = await receipt();
    const stored: StageReceipt = { completedAt: new Date().toISOString(), receiptHash: contentHash(result) };
    manifest.stages[stage] = stored;
    this.write(manifest);
    return { skipped: false, receipt: result };
  }

  /** Remaining stages in fixed order; used by resume to report what it will still do. */
  pending(manifest: ExperimentManifest): ManifestStage[] {
    return manifestStages.filter(stage => manifest.stages[stage] === undefined);
  }
}
