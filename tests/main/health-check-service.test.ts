import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppServicesTestContext } from './app-service-fixtures';
import { cleanupAppServicesTest, initializeAppServicesTest } from './app-service-fixtures';

let context: AppServicesTestContext;

beforeEach(() => {
  context = initializeAppServicesTest();
});

afterEach(async () => {
  await cleanupAppServicesTest(context);
});

describe('HealthCheckService', () => {
  it('returns six health checks within one second for initialized services', async () => {
    const startedAtMs = Date.now();

    const result = await context.services.healthCheckService.check();

    expect(Date.now() - startedAtMs).toBeLessThan(1000);
    expect(result.status).toBe('healthy');
    expect(result.checks.map((check) => check.name).sort()).toEqual([
      'database',
      'disk_space',
      'memory_service',
      'memory_usage',
      'provider_connectivity',
      'task_scheduler'
    ]);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'database', status: 'pass' }),
        expect.objectContaining({ name: 'task_scheduler', status: 'pass' }),
        expect.objectContaining({ name: 'memory_service', status: 'pass' }),
        expect.objectContaining({ name: 'provider_connectivity', status: 'pass' })
      ])
    );
    for (const check of result.checks) {
      expect(check.lastChecked).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });
});
