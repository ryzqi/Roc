import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ipcChannels,
  ipcEventChannelKeys,
  ipcRequestChannelKeys,
  ipcSchemaVersion
} from '../../src/shared/ipc';
import { ipcRegistry } from '../../src/shared/ipc-registry';

describe('IPC schema generation', () => {
  it('keeps generated IPC channels in sync with the schema', () => {
    const output = execFileSync(process.execPath, ['scripts/generate-ipc-schema.mjs', '--check'], {
      encoding: 'utf8'
    });

    expect(output).toContain('IPC generated files are current.');
  });

  it('exports generated request and event channel metadata from the shared IPC contract', () => {
    const schema = ipcRegistry;
    const expectedChannels = Object.fromEntries(
      [...schema.requests, ...schema.events].map((entry) => [entry.key, entry.channel])
    );

    expect(ipcSchemaVersion).toBe(schema.version);
    expect(ipcChannels).toEqual(expectedChannels);
    expect(ipcRequestChannelKeys).toEqual(schema.requests.map((entry) => entry.key));
    expect(ipcEventChannelKeys).toEqual(schema.events.map((entry) => entry.key));
  });

  it('declares explicit LangSmith settings and secret request channels', () => {
    const schema = ipcRegistry;

    expect(schema.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'agentLangSmithSettingsGet', channel: 'roc:agent:langsmith:settings:get' }),
        expect.objectContaining({ key: 'agentLangSmithSettingsSave', channel: 'roc:agent:langsmith:settings:save' }),
        expect.objectContaining({ key: 'agentLangSmithSecretSet', channel: 'roc:agent:langsmith:secret:set' }),
        expect.objectContaining({ key: 'agentLangSmithSecretClear', channel: 'roc:agent:langsmith:secret:clear' })
      ])
    );
  });

  it('keeps preload on generated channels without raw capability or wildcard IPC', () => {
    const schema = ipcRegistry;
    const preloadSource = readFileSync('src/preload/ipc-api-generated.ts', 'utf8');
    const preloadChannelKeys = Array.from(preloadSource.matchAll(/ipcChannels\.([A-Za-z0-9_]+)/gu), (match) => match[1]!);
    const expectedPreloadChannelKeys = [
      ...schema.requests.map((entry) => entry.key),
      ...schema.events.flatMap((entry) => [entry.key, entry.key])
    ];

    expect(preloadChannelKeys.sort()).toEqual(expectedPreloadChannelKeys.sort());
    expect(preloadSource).not.toContain('invokeCapability');
    expect(preloadSource).not.toContain("ipcRenderer.invoke('*'");
  });
});
