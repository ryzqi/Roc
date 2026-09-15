import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyResearchDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { createResearchProductionJob } from '../../../../src/main/plugins/research/research-production-job';
import { ResearchRepository } from '../../../../src/main/plugins/research/repository';

let db: Database.Database;
let repository: ResearchRepository;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyResearchDatabaseSchema(db, () => '2026-09-10T00:00:00.000Z');
  repository = new ResearchRepository(db);
});

afterEach(() => db.close());

describe('research production job', () => {
  it('recovers experiments and exports through one interface', () => {
    const experiments = { recover: vi.fn(), shutdown: vi.fn(async () => undefined) };
    const figures = { verifyStage: vi.fn(async () => undefined), shutdown: vi.fn(async () => undefined) };
    const exports = { recover: vi.fn(), verifyStage: vi.fn(async () => undefined), shutdown: vi.fn(async () => undefined) };
    const job = createResearchProductionJob({ repository, experiments, figures, exports });
    job.recover();
    expect(experiments.recover).toHaveBeenCalledTimes(1);
    expect(exports.recover).toHaveBeenCalledTimes(1);
  });

  it('routes verifyStage to the current production stage', async () => {
    const project = repository.createProject({ title: 'Job', description: 'Production verify.', workspacePath: null });
    const figures = { verifyStage: vi.fn(async () => undefined), shutdown: vi.fn(async () => undefined) };
    const exports = { recover: vi.fn(), verifyStage: vi.fn(async () => undefined), shutdown: vi.fn(async () => undefined) };
    const job = createResearchProductionJob({
      repository,
      experiments: { recover: vi.fn(), shutdown: vi.fn(async () => undefined) },
      figures,
      exports
    });
    await expect(job.verifyStage(project.id)).rejects.toThrow('research_production_verify_unavailable');
    repository.transitionWorkflow({ projectId: project.id, expectedStage: 'discovery', action: 'move', targetStage: 'figure' });
    await job.verifyStage(project.id);
    expect(figures.verifyStage).toHaveBeenCalledWith(project.id);
    expect(exports.verifyStage).not.toHaveBeenCalled();
  });
});
