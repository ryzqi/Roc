import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ipcChannels,
  ipcEventChannelKeys,
  ipcRequestChannelKeys,
  ipcSchemaVersion
} from '../../src/shared/ipc';

type IpcSchemaEntry = {
  key: string;
  channel: string;
};

type IpcSchema = {
  version: number;
  requests: IpcSchemaEntry[];
  events: IpcSchemaEntry[];
};

function readIpcSchema(): IpcSchema {
  return JSON.parse(readFileSync('src/shared/ipc-schema.json', 'utf8')) as IpcSchema;
}

describe('IPC schema generation', () => {
  it('keeps generated IPC channels in sync with the schema', () => {
    const output = execFileSync(process.execPath, ['scripts/generate-ipc-schema.mjs', '--check'], {
      encoding: 'utf8'
    });

    expect(output).toContain('IPC generated files are current.');
  });

  it('exports generated request and event channel metadata from the shared IPC contract', () => {
    const schema = readIpcSchema();
    const expectedChannels = Object.fromEntries(
      [...schema.requests, ...schema.events].map((entry) => [entry.key, entry.channel])
    );

    expect(ipcSchemaVersion).toBe(schema.version);
    expect(ipcChannels).toEqual(expectedChannels);
    expect(ipcRequestChannelKeys).toEqual(schema.requests.map((entry) => entry.key));
    expect(ipcEventChannelKeys).toEqual(schema.events.map((entry) => entry.key));
  });

  it('declares explicit LangSmith settings and secret request channels', () => {
    const schema = readIpcSchema();

    expect(schema.requests).toEqual(
      expect.arrayContaining([
        { key: 'agentLangSmithSettingsGet', channel: 'roc:agent:langsmith:settings:get' },
        { key: 'agentLangSmithSettingsSave', channel: 'roc:agent:langsmith:settings:save' },
        { key: 'agentLangSmithSecretSet', channel: 'roc:agent:langsmith:secret:set' },
        { key: 'agentLangSmithSecretClear', channel: 'roc:agent:langsmith:secret:clear' }
      ])
    );
  });

  it('keeps preload on generated channels without raw capability or wildcard IPC', () => {
    const schema = readIpcSchema();
    const preloadSource = readFileSync('src/preload/index.ts', 'utf8');
    const schemaKeys = new Set([...schema.requests, ...schema.events].map((entry) => entry.key));
    const preloadChannelKeys = Array.from(preloadSource.matchAll(/ipcChannels\.([A-Za-z0-9_]+)/gu), (match) => match[1]!);

    expect(preloadChannelKeys.length).toBeGreaterThan(0);
    expect(new Set(preloadChannelKeys)).toEqual(new Set(preloadChannelKeys.filter((key) => schemaKeys.has(key))));
    expect(preloadSource).not.toContain('invokeCapability');
    expect(preloadSource).not.toContain("ipcRenderer.invoke('*'");
    expect(JSON.stringify(schema)).not.toContain('invokeCapability');
    expect(JSON.stringify(schema)).not.toContain('"*"');
  });
});
