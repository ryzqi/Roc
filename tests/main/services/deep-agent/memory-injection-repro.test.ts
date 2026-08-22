import { InMemoryStore } from '@langchain/langgraph';
import { describe, expect, it } from 'vitest';
import { createBackend } from '../../../../src/main/services/deep-agent/backend';
import { CapacityService } from '../../../../src/main/services/memory/capacity';
import { defaultSettings } from '../../../../src/main/services/config/defaults';
import { SecurityScanService } from '../../../../src/main/services/memory/security-scan';
import { RocPaths } from '../../../../src/main/services/paths';

// 回归：deepagents 的 createMemoryMiddleware 通过 downloadFiles 加载记忆源。
// 一旦 Roc 的 memory 后端拒绝 downloadFiles，注入内容会恒为 "(No memory loaded)"。
function createTestBackend() {
  return createBackend({
    workspaceService: {
      getCurrentWorkspace: () => ({ path: 'F:\\Code\\Roc', label: 'Roc' })
    } as unknown as Parameters<typeof createBackend>[0]['workspaceService'],
    paths: new RocPaths('F:\\Code\\Roc\\.test-data'),
    store: new InMemoryStore(),
    securityScan: new SecurityScanService(defaultSettings.memory.securityScan),
    capacity: new CapacityService(defaultSettings.memory.charLimits)
  });
}

type WritableBackend = { write: (path: string, content: string) => Promise<{ error?: string }> };
type ReadableBackend = { read: (path: string) => Promise<{ content?: string; error?: string }> };
type DownloadResponse = { path: string; content: Uint8Array | null; error?: string | null };
type DownloadableBackend = { downloadFiles: (paths: string[]) => Promise<DownloadResponse[]> };

// CompositeBackend 的 downloadFiles 在类型上是可选的，这里显式断言，避免每个断言都做非空判断。
function downloadFiles(backend: unknown, paths: string[]): Promise<DownloadResponse[]> {
  return (backend as DownloadableBackend).downloadFiles(paths);
}

describe('memory injection path', () => {
  it('read_file 路径可以读到 USER.md', async () => {
    const { backend } = createTestBackend();
    await (backend as unknown as WritableBackend).write('/memory/global/USER.md', '# USER\n- 偏好语言: Python\n');
    const result = await (backend as unknown as ReadableBackend).read('/memory/global/USER.md');
    expect(result.error).toBeUndefined();
    expect(result.content).toContain('Python');
  });

  it('memory middleware 使用的 downloadFiles 能读到 USER.md', async () => {
    const { backend, memorySources } = createTestBackend();
    await (backend as unknown as WritableBackend).write('/memory/global/USER.md', '# USER\n- 偏好语言: Python\n');
    expect(memorySources).toContain('/memory/global/USER.md');
    const responses = await downloadFiles(backend, ['/memory/global/USER.md']);
    expect(responses[0].error ?? null).toBeNull();
    expect(responses[0].content).not.toBeNull();
    expect(new TextDecoder().decode(responses[0].content as Uint8Array)).toContain('Python');
  });

  it('每个 memorySources 路径都可以被 downloadFiles 加载', async () => {
    const { backend, memorySources } = createTestBackend();
    for (const source of memorySources) {
      await (backend as unknown as WritableBackend).write(source, `# ${source}\n`);
    }
    const responses = await downloadFiles(backend, [...memorySources]);
    expect(responses).toHaveLength(memorySources.length);
    for (const response of responses) {
      expect(response.error ?? null).toBeNull();
      expect(response.content).not.toBeNull();
    }
  });

  it('未写入的记忆源返回 file_not_found，不会让整批加载抛错', async () => {
    const { backend } = createTestBackend();
    const responses = await downloadFiles(backend, ['/memory/global/MEMORY.md']);
    expect(responses[0].error).toBe('file_not_found');
    expect(responses[0].content).toBeNull();
  });

  it('非白名单的记忆路径返回 file_not_found 而不是 permission_denied', async () => {
    const { backend } = createTestBackend();
    const responses = await downloadFiles(backend, ['/memory/global/SECRETS.md']);
    expect(responses[0].error).toBe('file_not_found');
  });

  it('downloadFiles 返回顺序与入参一致', async () => {
    const { backend } = createTestBackend();
    await (backend as unknown as WritableBackend).write('/memory/global/USER.md', '# USER\n');
    const responses = await downloadFiles(backend, [
      '/memory/global/SECRETS.md',
      '/memory/global/USER.md',
      '/memory/global/AGENTS.md'
    ]);
    expect(responses.map((response) => response.path)).toEqual([
      '/memory/global/SECRETS.md',
      '/memory/global/USER.md',
      '/memory/global/AGENTS.md'
    ]);
  });
});
