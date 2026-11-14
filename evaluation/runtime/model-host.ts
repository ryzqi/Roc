import { app, safeStorage } from 'electron';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { completeConfigured, createConfiguredModel } from './configured-model';

// This process never starts Roc, a renderer, its kernel, or a production database.
// Console and provider errors may contain credentials: expose only fixed protocol errors.
for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) console[method] = () => {};
const root = resolve(process.argv[2]!);
// macOS safeStorage selects its keychain namespace from the application name.
// A standalone entry otherwise inherits "Electron" instead of the package name.
app.setName(process.argv[3]!);
for (const name of ['userData', 'sessionData', 'logs', 'crashDumps']) {
  const path = join(root, name); mkdirSync(path, { recursive: true, mode: 0o700 });
  app.setPath(name as 'userData', path);
}
app.disableHardwareAcceleration();
const lines = createInterface({ input: process.stdin });
const iterator = lines[Symbol.asyncIterator]();
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
const controller = new AbortController();
process.on('SIGTERM', () => { controller.abort(); app.exit(0); });
async function main() {
try {
  send({ type: 'stage', stage: 'startup', applicationName: app.getName() });
  await app.whenReady(); app.dock?.hide(); send({ type: 'stage', stage: 'ready' });
  let model: Awaited<ReturnType<typeof createConfiguredModel>> | undefined;
  for await (const line of iterator) {
    const request = JSON.parse(line) as { type: string; requestId: string; rocRoot: string; selection?: { providerId: string; modelId: string }; body: Parameters<typeof completeConfigured>[1] };
    if (typeof request.requestId !== 'string' || !request.requestId || request.requestId.length > 256) throw new Error('protocol');
    if (request.type === 'init' && !model) {
      send({ type: 'stage', stage: 'configuration' });
      model = await createConfiguredModel(request.rocRoot, {
        isEncryptionAvailable: () => { send({ type: 'stage', stage: 'credential_availability' }); return safeStorage.isAsyncEncryptionAvailable(); },
        encryptString: async () => { throw new Error('readonly'); },
        decryptString: async bytes => { send({ type: 'stage', stage: 'credential_decryption' }); const value = await safeStorage.decryptStringAsync(bytes); return { plaintext: value.result, shouldReEncrypt: false }; }
      }, request.selection);
      send({ type: 'ready', requestId: request.requestId, identity: { ...model.identity, applicationName: app.getName() } });
    } else if (request.type === 'complete' && model) {
      send({ type: 'stage', stage: 'inference' });
      send({ type: 'response', requestId: request.requestId, body: await completeConfigured(model, request.body, controller.signal) });
    }
    else throw new Error('protocol');
  }
  app.exit(0);
} catch (error) {
  const code = (error as { code?: string }).code;
  const allowed = ['roc_configured_model_unavailable', 'provider_credential_missing', 'provider_credential_unavailable', 'secret_storage_unavailable',
    'provider_disabled', 'provider_model_missing', 'provider_endpoint_invalid', 'provider_credential_ref_invalid'];
  send({ type: 'error', code: code && allowed.includes(code) ? code : 'roc_model_host_failed' }); app.exit(2);
}

}
void main();
