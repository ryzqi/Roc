import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import type { RocEventBus, RocEventEnvelope, RocPluginContext } from '../../../../src/main/kernel/types';
import { createTaskPlugin } from '../../../../src/main/plugins/task';
import type { BackgroundTaskPreviewRequest } from '../../../../src/shared/types';

const taskCapabilities = [
  'task.snapshot.get',
  'task.background.preview',
  'task.background.create',
  'task.background.update',
  'task.background.runNow',
  'task.background.pause',
  'task.background.resume',
  'task.background.cancel',
  'task.background.delete',
  'task.scheduler.status'
];

let db: Database.Database;

const previewRequest: BackgroundTaskPreviewRequest = {
  goal: 'Review plugin state',
  trigger: {
    type: 'manual',
    description: 'Manual'
  },
  workspacePath: 'F:\\Code\\Roc',
  allowedActions: [],
  forbiddenActions: [],
  failurePolicy: 'pause_and_report',
  notificationPolicy: 'failures_and_confirmations'
};

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
});

afterEach(() => {
  db.close();
});

describe('task plugin', () => {
  it('declares the Phase 2 critical task plugin contract', () => {
    const plugin = createTaskPlugin();

    expect(plugin.manifest.id).toBe('@roc/plugin-task');
    expect(plugin.manifest.dependencies).toEqual(['@roc/plugin-agent']);
    expect(plugin.manifest.loadPhase).toBe('critical');
    expect(plugin.manifest.capabilities.map((capability) => capability.name)).toEqual(taskCapabilities);
  });

  it('binds handlers and publishes task.updated after mutations', async () => {
    const eventBus = createTestEventBus();
    const plugin = createTaskPlugin();
    const capabilities = new CapabilityRegistry();
    for (const descriptor of plugin.manifest.capabilities) {
      capabilities.declare(plugin.manifest.id, descriptor);
    }
    await plugin.initialize(createContext({ capabilities, eventBus }));

    const preview = await capabilities.invoke<BackgroundTaskPreviewRequest, unknown>('task.background.preview', previewRequest);
    const task = await capabilities.invoke<unknown, { id: string }>('task.background.create', preview);
    await capabilities.invoke('task.background.pause', { id: task.id });
    await capabilities.invoke('task.background.resume', { id: task.id });
    await capabilities.invoke('task.background.cancel', { id: task.id });
    await capabilities.invoke('task.background.delete', { id: task.id });

    expect(eventBus.published.map((event) => event.type)).toEqual([
      'task.updated',
      'task.updated',
      'task.updated',
      'task.updated',
      'task.updated'
    ]);
    await expect(capabilities.invoke('task.scheduler.status', {})).resolves.toMatchObject({
      running: true,
      registeredTaskCount: 0
    });
  });
});

function createContext(input: { capabilities: CapabilityRegistry; eventBus: RocEventBus }): RocPluginContext {
  return {
    pluginId: '@roc/plugin-task',
    eventBus: input.eventBus,
    capabilities: input.capabilities,
    database: { getConnection: () => db },
    config: { get: () => null, set: () => {} },
    secrets: { get: () => null, set: () => {}, clear: () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  };
}

function createTestEventBus(): RocEventBus & { published: RocEventEnvelope[] } {
  return {
    published: [],
    publish: async function publish(event) {
      this.published.push(event);
    },
    subscribe: () => () => {}
  };
}
