import { importTypeScriptModule } from '../lib/bundle-ts.mjs';

const { qualityPilotAudit } = await importTypeScriptModule(
  'scripts/harness-eval/quality-evaluation/runner.ts', { platform: 'node' }
);
console.log(JSON.stringify({
  ...qualityPilotAudit(), executionMode: 'offline-audit', modelCalls: 0, externalCalls: 0
}, null, 2));
