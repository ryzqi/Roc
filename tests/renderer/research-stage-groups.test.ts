import { describe, expect, it } from 'vitest';

import {
  isCurrentStageGroup,
  stageGroupForStage,
  stageGroupWriteAllowed
} from '../../src/renderer/views/research/research-stage-groups';

describe('research stage groups', () => {
  it('maps workflow stages onto grouped workspaces', () => {
    expect(stageGroupForStage('discovery')).toBe('discover');
    expect(stageGroupForStage('reading')).toBe('discover');
    expect(stageGroupForStage('ideation')).toBe('plan');
    expect(stageGroupForStage('experiment')).toBe('experiment');
    expect(stageGroupForStage('writing')).toBe('write');
    expect(stageGroupForStage('export')).toBe('publish');
    expect(isCurrentStageGroup('write', 'writing')).toBe(true);
    expect(isCurrentStageGroup('discover', 'writing')).toBe(false);
  });

  it('allows writes only on the current unlocked group', () => {
    expect(stageGroupWriteAllowed('write', 'writing', 'waiting_approval')).toBe(true);
    expect(stageGroupWriteAllowed('discover', 'writing', 'waiting_approval')).toBe(false);
    expect(stageGroupWriteAllowed('write', 'writing', 'locked')).toBe(false);
    expect(stageGroupWriteAllowed('settings', 'writing', 'locked')).toBe(true);
  });
});
