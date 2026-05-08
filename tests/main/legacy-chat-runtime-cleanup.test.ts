import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppServices, type AppServices } from '../../src/main/services/app-service';

let root: string;
let services: AppServices;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-legacy-chat-cleanup-'));
  services = createAppServices(root);
  services.appService.initialize();
});

afterEach(() => {
  services.databaseService.close();
  rmSync(root, { recursive: true, force: true });
});

describe('legacy chat runtime cleanup', () => {
  it('does not expose the removed chat submit runtime through app services', () => {
    expect('chatService' in services).toBe(false);
    expect('chatService' in services.appService.services).toBe(false);
    expect('executeChat' in services.providerRuntimeService).toBe(false);
  });
});
