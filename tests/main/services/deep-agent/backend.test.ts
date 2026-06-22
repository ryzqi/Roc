import { InMemoryStore } from '@langchain/langgraph';
import { describe, expect, it } from 'vitest';
import { createBackend, createRocFilesystemPermissions } from '../../../../src/main/services/deep-agent/backend';
import { CapacityService } from '../../../../src/main/services/memory/capacity';
import { defaultSettings } from '../../../../src/main/services/config/defaults';
import { SecurityScanService } from '../../../../src/main/services/memory/security-scan';
import { RocPaths } from '../../../../src/main/services/paths';

const workspacePath = 'F:\\Code\\Roc';

function createTestBackend() {
  return createBackend({
    workspaceService: {
      getCurrentWorkspace: () => ({ path: workspacePath, label: 'Roc' })
    } as unknown as Parameters<typeof createBackend>[0]['workspaceService'],
    paths: new RocPaths('F:\\Code\\Roc\\.test-data'),
    store: new InMemoryStore(),
    securityScan: new SecurityScanService(defaultSettings.memory.securityScan),
    capacity: new CapacityService(defaultSettings.memory.charLimits),
    selectedSkillIds: []
  });
}

describe('DeepAgents Roc backend', () => {
  it('does not expose execute on the filesystem backend passed to DeepAgents', () => {
    const { backend } = createTestBackend();

    expect('execute' in backend).toBe(false);
    expect(Reflect.get(backend, 'execute')).toBeUndefined();
  });

  it('keeps Roc virtual route prefixes for file tools', () => {
    const { backend } = createTestBackend();

    expect(backend.routePrefixes).toEqual(
      expect.arrayContaining(['/workspace/', '/skills/', '/memory/global/', '/memory/workspaces/current/'])
    );
    expect(backend.routePrefixes).not.toContain('/memory/');
    expect(backend.routePrefixes).not.toContain('/agents/');
  });

  it('keeps unknown file routes as hard errors', async () => {
    const { backend } = createTestBackend();

    await expect(backend.write('/home/user/workarea/create_docx.py', 'print(1)')).resolves.toEqual({
      error: 'Roc 文件工具只允许访问 /workspace/、/skills/、/memory/ 路径。'
    });
  });

  it('uses an explicit final deny rule because DeepAgents permissions default to allow', () => {
    expect(createRocFilesystemPermissions()).toEqual([
      { operations: ['read'], paths: ['/workspace/**', '/memory/**', '/skills/**'], mode: 'allow' },
      { operations: ['write'], paths: ['/workspace/**', '/memory/**'], mode: 'allow' },
      { operations: ['write'], paths: ['/skills/**'], mode: 'deny' },
      { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' }
    ]);
  });
});
