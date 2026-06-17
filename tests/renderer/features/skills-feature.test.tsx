// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillsFeature } from '../../../src/renderer/features/skills';
import type { RocClient } from '../../../src/renderer/shared/roc-client';
import type { RocPreloadApi } from '../../../src/shared/ipc';
import { createLoadedState } from '../view-test-helpers';

describe('SkillsFeature', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('refreshes plugin skills when the feature mounts', async () => {
    const skill = {
      id: 'smoke-skill',
      name: 'Smoke Skill',
      enabled: true,
      path: 'F:\\Code\\Roc\\.tmp\\smoke-skill',
      description: 'Smoke skill fixture.',
      status: 'ready' as const,
      lastError: null
    };
    const list = vi.fn(async () => ({ ok: true as const, data: [skill] }));
    const updateLoadedState = vi.fn();

    await act(async () => {
      root.render(
        <SkillsFeature
          client={{ api: { skills: { list } } as unknown as RocPreloadApi } satisfies RocClient}
          state={createLoadedState({ skills: [], selectedSkills: [] })}
          updateLoadedState={updateLoadedState}
        />
      );
    });

    expect(list).toHaveBeenCalledTimes(1);
    expect(updateLoadedState).toHaveBeenCalledWith({
      skills: [skill],
      selectedSkills: ['smoke-skill']
    });
  });
});
