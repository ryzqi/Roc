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

  it('loads operations data only for doctor and diagnostics views', () => {
    for (const activeView of ['doctor', 'diagnostics'] as const) {
      const intent = getStartupLoadIntent({
        activeView,
        activeWorkbenchTool: 'files',
        workbenchVisible: false
      });

      expectTargets(intent, ['operations']);
    }
  });

  it('keeps tasks, quick, and tray views on the base startup surface', () => {
    for (const activeView of ['tasks', 'quick', 'tray'] as const) {
      const intent = getStartupLoadIntent({
        activeView,
        activeWorkbenchTool: 'files',
        workbenchVisible: false
      });

      expectTargets(intent, []);
    }
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
});
