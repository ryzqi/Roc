import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RTKBinaryManager } from '../../../src/rtk-integration';
import { defaultSettings } from '../../../src/main/services/config/defaults';
import { resolveRtkRoute, resolveRtkRouteAsync } from '../../../src/main/services/shell-execution-helpers';
import { ShellExecutionService } from '../../../src/main/services/shell-execution-service';
import { WorkspaceService } from '../../../src/main/services/workspace-service';
import type { RtkExecutionMetadata, RtkService } from '../../../src/main/services/rtk-service';

let root: string;
let metadata: RtkExecutionMetadata;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-routing-'));
  const binaryPath = new RTKBinaryManager().getRTKBinaryPath();
  if (binaryPath === null) throw new Error('Expected bundled macOS RTK binary.');
  metadata = {
    binaryPath,
    runtimeRoot: root,
    configPath: join(root, 'rtk.toml'),
    teeDir: join(root, 'tee'),
    trackingDatabasePath: join(root, 'rtk.db'),
    resourceState: 'ready'
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it.each([
  'git status && git diff',
  'git diff -- "notes file.md"',
  'git diff -- "$FILE"',
  'git diff -- *.ts',
  'git status\npnpm test',
  'rtk git diff -- "notes file.md"'
])('preserves shell interpretation for %s', async (command) => {
  expect(resolveRtkRoute(command)).toEqual({ kind: 'fallback', bypassReason: 'command_not_supported' });
  await expect(resolveRtkRouteAsync(command, metadata)).resolves.toEqual({ kind: 'fallback', bypassReason: 'command_not_supported' });
});

it('executes chained commands through zsh when RTK is available', async () => {
  const result = await createService().executeAsync({
    command: 'git diff --no-index /dev/null /dev/null && printf ROC_CHAIN_OK',
    cwd: root,
    source: 'agent'
  });
  expect(result).toMatchObject({ exitCode: 0, stdout: 'ROC_CHAIN_OK', usedRtk: false });
});

it('resolves quoted explicit RTK commands from the bundled binary with a minimal PATH', async () => {
  vi.stubEnv('PATH', '/usr/bin:/bin');
  const result = await createService().executeAsync({ command: 'rtk "--version"', cwd: root, source: 'agent' });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toMatch(/^rtk \d+\./);
});

function createService(): ShellExecutionService {
  const workspace = new WorkspaceService({
    getSettings: () => defaultSettings,
    saveSettings: vi.fn()
  });
  workspace.selectWorkspace(root);
  const rtk = { getExecutionMetadata: () => metadata } as RtkService;
  return new ShellExecutionService(workspace, rtk, { recordEvent: vi.fn() });
}
