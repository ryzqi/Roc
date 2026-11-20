import type { ShellExecutionResult } from '../../shared/types';
import type { RtkExecutionMetadata } from './rtk-service';
import { redact } from './deep-agent/redaction';

const maxPersistedAgentOutputChars = 4096;

export function buildRtkEnvironment(metadata: RtkExecutionMetadata): Record<string, string> {
  return {
    XDG_CONFIG_HOME: metadata.runtimeRoot,
    XDG_DATA_HOME: metadata.runtimeRoot,
    RTK_DB_PATH: metadata.trackingDatabasePath,
    RTK_TEE_DIR: metadata.teeDir
  };
}

export function toText(value: Buffer | string | undefined): string {
  if (value === undefined) {
    return '';
  }
  return Buffer.isBuffer(value) ? value.toString('utf8') : value;
}

export function combineOutput(stdout: string, stderr: string): string {
  if (stdout.length === 0) {
    return stderr;
  }
  if (stderr.length === 0) {
    return stdout;
  }
  return `${stdout}\n[stderr]\n${stderr}`;
}

export function buildAgentExecutePayload(input: {
  command: string;
  normalizedCommand?: string;
  cwd: string;
  exitCode: number;
  durationMs?: number;
  usedRtk: boolean;
  bypassReason?: ShellExecutionResult['bypassReason'];
  output: string;
}): Record<string, unknown> {
  return {
    command: input.command,
    normalizedCommand: input.normalizedCommand,
    cwd: input.cwd,
    exitCode: input.exitCode,
    durationMs: input.durationMs,
    usedRtk: input.usedRtk,
    bypassReason: input.bypassReason,
    ...preparePersistedAgentOutput(input.output)
  };
}

function preparePersistedAgentOutput(output: string): { output: string; outputTruncated: boolean } {
  const redacted = redact(output);
  if (redacted.length <= maxPersistedAgentOutputChars) {
    return {
      output: redacted,
      outputTruncated: false
    };
  }
  return {
    output: redacted.slice(0, maxPersistedAgentOutputChars),
    outputTruncated: true
  };
}
