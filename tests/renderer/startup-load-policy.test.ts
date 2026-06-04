import { describe, expect, it } from 'vitest';
import { getStartupLoadIntent } from '../../src/renderer/startup-load-policy';

describe('startup load policy', () => {
  it('loads workspace data for workspace views and workspace workbench tools', () => {
    expect(
      getStartupLoadIntent({ activeView: 'workspace', activeWorkbenchTool: 'files', workbenchVisible: false }).targets
    ).toEqual(new Set(['workspace']));
    expect(
      getStartupLoadIntent({ activeView: 'chat', activeWorkbenchTool: 'files', workbenchVisible: true }).targets
    ).toEqual(new Set(['workspace']));
  });

  it('loads feature data only for the selected feature surface', () => {
    expect(getStartupLoadIntent({ activeView: 'tasks', activeWorkbenchTool: 'files', workbenchVisible: false }).targets).toEqual(
      new Set(['taskSurface'])
    );
    expect(getStartupLoadIntent({ activeView: 'memory', activeWorkbenchTool: 'files', workbenchVisible: false }).targets).toEqual(
      new Set(['memory'])
    );
    expect(
      getStartupLoadIntent({ activeView: 'diagnostics', activeWorkbenchTool: 'files', workbenchVisible: false }).targets
    ).toEqual(new Set(['operations']));
  });
});
