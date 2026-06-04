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
});
