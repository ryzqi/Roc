import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { FilesystemBackend, StoreBackend } from 'deepagents';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { applyMemoryDatabaseSchema } from '../../src/main/infrastructure/database-schemas';
import { AgentMemoryStatsContract } from '../../src/main/plugins/agent/agent-memory-stats-contract';
import { MemoryStoreRepository } from '../../src/main/plugins/memory/memory-store-repository';
import { AutoMemoryWriter } from '../../src/main/services/memory/auto-memory-writer';
import { AutoMemoryAuditRepository } from '../../src/main/services/memory/auto-memory-audit-repository';
import { RocSqliteStore } from '../../src/main/services/memory/sqlite-store';
import { RocStoreMemoryBackend } from '../../src/main/services/deep-agent/store-memory-backend';
import { memoryApplicability } from '../../src/main/services/deep-agent/harness-revision';
import { CapacityService } from '../../src/main/services/memory/capacity';
import { SecurityScanService } from '../../src/main/services/memory/security-scan';
import { defaultSettings } from '../../src/main/services/config/defaults';
import { readSkillRevision } from '../../src/main/services/skill-revision';
import { SelectedSkillsFilesystemBackend } from '../../src/main/services/deep-agent/skill-backend';

export async function verifyMemorySkills(name: string, directory: string, agentDb: Database.Database): Promise<unknown> {
  if (name === 'skills-pinning') {
    const root = join(directory, 'skills');
    const skill = join(root, 'pilot');
    mkdirSync(skill, { recursive: true });
    const body = '---\nname: pilot\ndescription: Fixture skill\nlicense: MIT\n---\nRead reference.md only when needed.\n';
    writeFileSync(join(skill, 'SKILL.md'), body);
    writeFileSync(join(skill, 'reference.md'), 'Original source 3.5\n');
    writeFileSync(join(skill, 'LICENSE'), 'Synthetic MIT fixture license');
    const revision = readSkillRevision(skill);
    assert.deepEqual(readSkillRevision(skill), revision);
    assert.equal(revision.license, 'MIT');
    assert.ok(revision.licenseHash);
    const frozen = { canonicalIdentity: 'skill:pilot', name: 'pilot', sourcePath: skill, description: 'Fixture skill',
      contentHash: revision.contentHash, license: revision.license, licenseHash: revision.licenseHash, sourceRevision: null };
    const backend = new SelectedSkillsFilesystemBackend(new FilesystemBackend({ rootDir: root, virtualMode: true }), root, [frozen]);
    assert.equal((await backend.readRaw('/pilot/SKILL.md')).data?.content, body);
    assert.ok((await backend.read('/other/SKILL.md')).error);
    assert.ok((await backend.read('/pilot/../other/SKILL.md')).error);
    writeFileSync(join(skill, 'reference.md'), 'Changed source 99\n');
    assert.equal((await backend.read('/pilot/reference.md')).error, 'skill_revision_changed');
    assert.equal((await backend.grep('Changed')).error, 'skill_revision_changed');
    await assert.rejects(backend.downloadFiles(['/pilot/reference.md']), /revision_changed/);
    assert.throws(() => new SelectedSkillsFilesystemBackend(new FilesystemBackend({ rootDir: root, virtualMode: true }), root, [frozen]), /revision_changed/);
    writeFileSync(join(skill, 'reference.md'), 'Original source 3.5\n');
    writeFileSync(join(skill, 'LICENSE'), 'Changed license');
    assert.notEqual(readSkillRevision(skill).licenseHash, revision.licenseHash);
    assert.throws(() => new SelectedSkillsFilesystemBackend(new FilesystemBackend({ rootDir: root, virtualMode: true }), root, [frozen]), /revision_changed/);
    writeFileSync(join(directory, 'outside.txt'), 'Fixture outside skill root');
    symlinkSync(join(directory, 'outside.txt'), join(skill, 'symlink.md'));
    assert.throws(() => readSkillRevision(skill), /symlink/);
    unlinkSync(join(skill, 'symlink.md'));
    writeFileSync(join(directory, 'revision.json'), JSON.stringify(revision, null, 2));
    return { frozenHash: revision.contentHash, licenseHash: revision.licenseHash, changedBody: 'rejected', changedLicense: 'rejected', symlink: 'rejected' };
  }
  const db = new Database(join(directory, 'memory.sqlite'));
  applyMemoryDatabaseSchema(db);
  const store = new RocSqliteStore(db);
  const repository = new MemoryStoreRepository({ store, agentFacts: new AgentMemoryStatsContract(agentDb), getWorkspace: () => null });
  const audit = new AutoMemoryAuditRepository(db);
  const writer = new AutoMemoryWriter({ repository, auditRepository: audit, logger: { warn: () => {} } as never });
  const readTool = (description: string) => tool(() => 'evidence', { name: 'read_evidence', description, schema: z.object({}).strict() });
  const identity = { model: { providerId: 'fixture', modelId: 'research-model' }, toolContracts: [] };
  const version = memoryApplicability(identity, [readTool('Read evidence v1')]);
  const changed = memoryApplicability(identity, [readTool('Read evidence v2')]);
  const otherModel = memoryApplicability({ ...identity, model: { ...identity.model, modelId: 'different-model' } }, [readTool('Read evidence v1')]);
  assert.notEqual(version, changed);
  assert.notEqual(version, otherModel);
  const backend = (applicability: string) => new RocStoreMemoryBackend(new StoreBackend({ store, namespace: ['roc', 'memory', 'global'] }),
    new Set(['/MEMORY.md']), new SecurityScanService(defaultSettings.memory.securityScan), new CapacityService(defaultSettings.memory.charLimits),
    new Map([['/MEMORY.md', 'memory']]), applicability);
  try {
    const request = { applicability: version, status: 'active' as const, counterexamples: [], executionKind: 'production' as const,
      type: 'decision' as const, confidence: 'high' as const, key: 'pilot-source-policy', summary: 'Keep source evidence linked.',
      evidence: ['verifier:pilot-evidence'], sourceRunId: 'run', workspacePath: null, revalidate: null };
    assert.equal((await writer.recordCandidate(request)).status, 'accepted');
    assert.equal((await writer.recordCandidate(request)).status, 'duplicate');
    assert.ok(String((await backend(version).read('/MEMORY.md')).content).includes(request.summary));
    assert.ok(!String((await backend(changed).read('/MEMORY.md')).content).includes(request.summary));
    assert.ok(!String((await backend(otherModel).read('/MEMORY.md')).content).includes(request.summary));
    assert.equal((await repository.searchEntries({ query: 'source evidence', applicability: changed })).hits.length, 0);
    const archived = (await repository.readFile({ scope: 'global', kind: 'memory' }))!;
    assert.equal((await repository.writeTopicFile({ scope: 'global', slug: 'archive-pilot', content: archived })).ok, true);
    assert.equal((await writer.recordCandidate({ ...request, status: 'revoked', ttlDays: 1, counterexamples: ['Fixture showed unsupported source'] })).status, 'accepted');
    await writer.runMaintenance({ sourceRunId: 'maintenance' }, '2099-01-01T00:00:00.000Z');
    assert.equal((await repository.searchEntries({ query: 'source evidence', applicability: version })).hits.length, 0);
    assert.ok(!String((await backend(version).read('/topics/archive-pilot.md')).content).includes(request.summary));
    assert.ok(!new TextDecoder().decode((await backend(version).downloadFiles(['/topics/archive-pilot.md']))[0].content!).includes(request.summary));
    assert.ok(!String((await backend(version).read('/MEMORY.md', 4, 100)).content).includes(request.summary));
    assert.equal((await backend(version).grep('source evidence', '/')).matches?.length, 0);
    const downloaded = await backend(version).downloadFiles(['/MEMORY.md']);
    assert.ok(!new TextDecoder().decode(downloaded[0].content!).includes(request.summary));
    const before = await repository.readFile({ scope: 'global', kind: 'memory' });
    const count = audit.countWritesForRun('run');
    assert.equal((await writer.recordCandidate({ ...request, executionKind: 'probe' })).reason, 'probe_memory_write_forbidden');
    assert.equal(await repository.readFile({ scope: 'global', kind: 'memory' }), before);
    assert.equal(audit.countWritesForRun('run'), count);
    assert.equal((await writer.recordCandidate({ ...request, status: 'needs_revalidation', revalidate: 'Recheck source version' })).status, 'accepted');
    assert.equal((await repository.searchEntries({ query: 'source evidence', applicability: version })).hits.length, 0);
    assert.equal((await writer.recordCandidate({ ...request, evidence: ['verifier:rechecked-current-source'] })).status, 'accepted');
    assert.ok((await repository.searchEntries({ query: 'source evidence', applicability: version })).hits.length > 0);
    writeFileSync(join(directory, 'memory.md'), (await repository.readFile({ scope: 'global', kind: 'memory' }))!);
    return { version, changed, otherModel, revoked: true, probeWrite: 'rejected before audit', revalidated: true };
  } finally { db.close(); }
}
