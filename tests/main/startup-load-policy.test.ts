import { describe, expect, it } from 'vitest';
import {
  type StartupLoadIntent,
  type StartupLoadTarget,
  getStartupLoadIntent
} from '../../src/renderer/startup-load-policy';

function expectTargets(intent: StartupLoadIntent, expected: StartupLoadTarget[]): void {
  expect(intent.targets).toEqual(new Set(expected));
}

describe('startup load policy', () => {
  it('keeps chat first paint free of workspace, memory, and operations data', () => {
    const intent = getStartupLoadIntent({
      activeView: 'chat',
      activeWorkbenchTool: 'files',
      workbenchVisible: false
    });

    expectTargets(intent, []);
  });

  it('keeps settings detail out of the base chat startup surface', () => {
    const intent = getStartupLoadIntent({
      activeView: 'chat',
      activeWorkbenchTool: 'files',
      workbenchVisible: false
    });

    expect(Array.from(intent.targets)).not.toContain('settings');
    expect(Array.from(intent.targets)).not.toContain('operations');
    expect(Array.from(intent.targets)).not.toContain('memory');
  });

  it('loads workspace data for workspace-native views', () => {
    for (const activeView of ['workspace', 'git', 'preview'] as const) {
      const intent = getStartupLoadIntent({
        activeView,
        activeWorkbenchTool: 'files',
        workbenchVisible: true
      });

      expectTargets(intent, ['workspace']);
    }
  });

  it('loads workspace data when chat opens files or git workbench', () => {
    const filesIntent = getStartupLoadIntent({
      activeView: 'chat',
      activeWorkbenchTool: 'files',
      workbenchVisible: true
    });
    const gitIntent = getStartupLoadIntent({
      activeView: 'chat',
      activeWorkbenchTool: 'git',
      workbenchVisible: true
    });

    expectTargets(filesIntent, ['workspace']);
    expectTargets(gitIntent, ['workspace']);
  });

  it('does not load workspace data for terminal workbench by policy contract', () => {
    const intent = getStartupLoadIntent({
      activeView: 'chat',
      activeWorkbenchTool: 'terminal',
      workbenchVisible: true
    });

    expectTargets(intent, []);
  });

  it('loads memory only for memory view', () => {
    const memoryIntent = getStartupLoadIntent({
      activeView: 'memory',
      activeWorkbenchTool: 'files',
      workbenchVisible: false
    });
    const settingsIntent = getStartupLoadIntent({
      activeView: 'settings',
      activeWorkbenchTool: 'files',
      workbenchVisible: false
    });

    expectTargets(memoryIntent, ['memory']);
    expectTargets(settingsIntent, []);
  });

  it('loads operations data only for diagnostics view', () => {
    for (const activeView of ['diagnostics'] as const) {
      const intent = getStartupLoadIntent({
        activeView,
        activeWorkbenchTool: 'files',
        workbenchVisible: false
      });

      expectTargets(intent, ['operations']);
    }
  });

  it('keeps quick view on the base startup surface', () => {
    for (const activeView of ['quick'] as const) {
      const intent = getStartupLoadIntent({
        activeView,
        activeWorkbenchTool: 'files',
        workbenchVisible: false
      });

      expectTargets(intent, []);
    }
  });

  it('loads task surface only when the current view presents task or tray data', () => {
    const tasksIntent = getStartupLoadIntent({
      activeView: 'tasks',
      activeWorkbenchTool: 'files',
      workbenchVisible: false
    });
    const trayIntent = getStartupLoadIntent({
      activeView: 'tray',
      activeWorkbenchTool: 'files',
      workbenchVisible: false
    });
    const chatIntent = getStartupLoadIntent({
      activeView: 'chat',
      activeWorkbenchTool: 'files',
      workbenchVisible: false
    });

    expectTargets(tasksIntent, ['taskSurface']);
    expectTargets(trayIntent, ['taskSurface']);
    expect(chatIntent.targets.has('taskSurface')).toBe(false);
  });

  it('can request multiple data groups when a view needs them together', () => {
    const intent = getStartupLoadIntent({
      activeView: 'chat',
      activeWorkbenchTool: 'git',
      workbenchVisible: true,
      includeOperations: true
    });

    expectTargets(intent, ['workspace', 'operations']);
  });

  it('keeps the loader contract asymmetric across resource kinds', () => {
    const workspaceIntent = getStartupLoadIntent({
      activeView: 'workspace',
      activeWorkbenchTool: 'files',
      workbenchVisible: true
    });
    const memoryIntent = getStartupLoadIntent({
      activeView: 'memory',
      activeWorkbenchTool: 'files',
      workbenchVisible: false
    });
    const operationsIntent = getStartupLoadIntent({
      activeView: 'diagnostics',
      activeWorkbenchTool: 'files',
      workbenchVisible: false
    });

    expectTargets(workspaceIntent, ['workspace']);
    expectTargets(memoryIntent, ['memory']);
    expectTargets(operationsIntent, ['operations']);
    expect(workspaceIntent.targets.has('memory')).toBe(false);
    expect(memoryIntent.targets.has('workspace')).toBe(false);
    expect(operationsIntent.targets.has('workspace')).toBe(false);
  });
});
