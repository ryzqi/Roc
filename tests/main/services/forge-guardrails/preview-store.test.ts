import { describe, expect, it } from 'vitest';
import { PreviewStore } from '../../../../src/main/services/forge-guardrails/preview-store';
import type { BackgroundTaskPreview } from '../../../../src/shared/types';

describe('forge preview store', () => {
  it('stores previews until they are taken once', () => {
    const store = new PreviewStore();
    const preview = backgroundTaskPreview();

    store.put('preview_1', preview);

    expect(store.size()).toBe(1);
    expect(store.take('preview_1')).toBe(preview);
    expect(store.size()).toBe(0);
    expect(store.take('preview_1')).toBeNull();
  });

  it('generates unique preview ids with the expected prefix', () => {
    const store = new PreviewStore();

    const first = store.generatePreviewId();
    const second = store.generatePreviewId();

    expect(first).toMatch(/^preview_/u);
    expect(second).toMatch(/^preview_/u);
    expect(first).not.toBe(second);
  });

  it('clears all previews', () => {
    const store = new PreviewStore();
    store.put('preview_1', backgroundTaskPreview());
    store.put('preview_2', backgroundTaskPreview());

    store.clear();

    expect(store.size()).toBe(0);
  });
});

function backgroundTaskPreview(): BackgroundTaskPreview {
  return {
    goal: '检查测试',
    trigger: {
      type: 'manual',
      description: '手动'
    },
    workspacePath: 'F:\\Code\\Roc',
    allowedActions: [],
    forbiddenActions: [],
    failurePolicy: 'pause_and_report',
    notificationPolicy: 'failures_and_confirmations',
    enabledCapabilities: null,
    scheduled: false,
    nextRunAt: null,
    cronExpression: null,
    riskLevel: 'low',
    requiresConfirmation: false
  };
}
