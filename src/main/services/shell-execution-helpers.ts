import type { ShellExecutionResult } from '../../shared/types';
import { CommandRewriter, parseRtkArgs } from '../../rtk-integration';
import type { RtkExecutionMetadata } from './rtk-service';
import { redact } from './deep-agent/redaction';
import { normalizeShellCommand } from './deep-agent/shell-policy';

const maxPersistedAgentOutputChars = 4096;
const directCommandPattern = /^[A-Za-z0-9_./:@%+=,-]+(?:[ \t]+[A-Za-z0-9_./:@%+=,-]+)*$/;

export type RtkRoutingDecision =
  | {
      kind: 'rtk';
      args: string[];
    }
  | {
      kind: 'fallback';
      bypassReason: ShellExecutionResult['bypassReason'];
    };

export function resolveRtkRoute(command: string): RtkRoutingDecision {
  if (!directCommandPattern.test(command.trim())) {
    return { kind: 'fallback', bypassReason: 'command_not_supported' };
  }
  const explicitRtkArgs = parseRtkArgs(command.trim());
  if (explicitRtkArgs !== null) {
    return { kind: 'rtk', args: explicitRtkArgs };
  }

  const normalized = normalizeShellCommand(command);
  if (normalized === 'ls' || normalized.startsWith('ls ')) {
    return {
      kind: 'rtk',
      args: command.trim().split(/\s+/)
    };
  }
  if (normalized === 'git status' || normalized.startsWith('git status ')) {
    return {
      kind: 'rtk',
      args: command.trim().split(/\s+/)
    };
  }
  if (normalized === 'git diff' || normalized.startsWith('git diff ')) {
    return {
      kind: 'rtk',
      args: command.trim().split(/\s+/)
    };
  }
  return {
    kind: 'fallback',
    bypassReason: 'command_not_supported'
  };
}

export async function resolveRtkRouteAsync(
  command: string,
  metadata: RtkExecutionMetadata,
  signal?: AbortSignal,
  environment?: NodeJS.ProcessEnv
): Promise<RtkRoutingDecision> {
  if (!directCommandPattern.test(command.trim())) {
    return { kind: 'fallback', bypassReason: 'command_not_supported' };
  }
  const explicitRtkArgs = parseRtkArgs(command.trim());
  if (explicitRtkArgs !== null) {
    return { kind: 'rtk', args: explicitRtkArgs };
  }

  const rewritten = await new CommandRewriter(metadata.binaryPath, { environment }).rewrite(command, signal);
  if (rewritten.rtkArgs === null) {
    return resolveRtkRoute(command);
  }
  return {
    kind: 'rtk',
    args: rewritten.rtkArgs
  };
}

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
