import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppServices, type AppServices } from '../../../src/main/services/app-service';
import type { LangChainChatModelHandle } from '../../../src/main/services/langchain-model-factory';

let root: string;
let services: AppServices;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-consolidator-e2e-'));
  services = createAppServices(root);
  services.appService.initialize();
  services.consolidatorService.setTestModelHooksForTestsOnly({
    resolveDefaultModelHandle: async () => ({
      model: { invoke: vi.fn() },
      modelId: 'test-model',
      provider: { id: 'test-provider', type: 'openai_compatible' },
      runtime: { providerType: 'openai_compatible', baseUrl: 'http://localhost', streaming: false, modelKwargs: {} }
    } as unknown as LangChainChatModelHandle),
    callLLM: async () => '# compressed\n- key fact retained'
  });
});

afterEach(async () => {
  await services.appService.shutdown();
  rmSync(root, { recursive: true, force: true });
});

describe('consolidator end-to-end', () => {
  it('overflow on existing file triggers consolidator compression', async () => {
    services.memoryService.writeFile({ scope: 'global', kind: 'memory', content: 'initial small content' });
    const big = 'y'.repeat(2300);
    const result = services.memoryService.writeFile({ scope: 'global', kind: 'memory', content: big });
    expect(result.ok).toBe(false);

    await new Promise((r) => setTimeout(r, 500));
    const memoryPath = join(root, 'memory', 'global', 'MEMORY.md');
    const finalContent = readFileSync(memoryPath, 'utf8');
    expect(finalContent).toContain('compressed');
    const backupDir = join(root, 'memory', '.consolidator-backup');
    expect(readdirSync(backupDir).length).toBeGreaterThan(0);
  });
});
