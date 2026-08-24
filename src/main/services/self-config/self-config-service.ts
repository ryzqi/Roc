import { join } from 'node:path';

import { z } from 'zod';

import { rocHookConfigSchema } from '../../../shared/schemas/ipc-memory-settings';
import {
  rocHookEventNames,
  type RocHookCommandInput,
  type RocHookCommandOutput,
  type RocHookCommandOutputAction,
  type RocHookConfig,
  type RocHookConfiguredHandlerSnapshot,
  type RocHookEventName,
  type RocHookTrustState
} from '../../../shared/types';
import type { ConfigService } from '../config-service';
import { redact, redactUnknown } from '../deep-agent/redaction';
import type { HookCommandRunner } from '../hooks/command-runner';
import type { HookConfigService } from '../hooks/config-service';
import type { HookTrustService } from '../hooks/trust-service';
import { supportedActionsByEvent, validateHookCommandOutputForEvent } from '../hooks/schema';
import type { RocPaths } from '../paths';

export type SelfConfigPathsSummary = {
  rocRoot: string;
  hooksConfig: string;
  settings: string;
  hooksTrust: string;
  skillsDir: string;
  logsDir: string;
};

export type SelfConfigEventContract = {
  event: RocHookEventName;
  allowedActions: RocHookCommandOutputAction[];
  matcherTarget: string;
};

export type SelfConfigDescribeResult = {
  action: 'describe';
  paths: SelfConfigPathsSummary;
  hookConfigJsonSchema: unknown;
  events: SelfConfigEventContract[];
  runtimeContract: string[];
  foreignFormatTraps: string[];
  writePolicy: string[];
};

export type SelfConfigReadResult = {
  action: 'read';
  hooks: {
    configPath: string;
    exists: boolean;
    validationErrors: string[];
    handlers: RocHookConfiguredHandlerSnapshot[];
    config: unknown;
  };
  settings: {
    settingsPath: string;
    settings: unknown;
    permissions: unknown;
    providers: unknown;
    defaultModelId: string | null;
    mcp: {
      approvalMode: string;
      serverIds: string[];
    };
  };
};

export type SelfConfigValidateIssue = {
  path: string;
  code: string;
  message: string;
  hint: string | null;
};

export type SelfConfigValidateResult = {
  action: 'validate';
  valid: boolean;
  normalizedConfig: RocHookConfig | null;
  issues: SelfConfigValidateIssue[];
  notes: string[];
};

export type SelfConfigDryRunConfirmRequest = {
  handlerId: string;
  event: RocHookEventName;
  command: string;
  cwd: string;
  timeoutSeconds: number;
  enabled: boolean;
  trustState: RocHookTrustState;
};

export type SelfConfigDryRunInput = {
  handlerId: string;
  payload?: Record<string, unknown>;
  cwd?: string;
  confirm: (request: SelfConfigDryRunConfirmRequest) => Promise<boolean>;
};

export type SelfConfigDryRunResult = {
  action: 'dry_run';
  handlerId: string;
  event: RocHookEventName;
  command: string;
  cwd: string;
  timeoutSeconds: number;
  enabled: boolean;
  trustState: RocHookTrustState;
  status: 'completed' | 'failed' | 'declined';
  durationMs: number;
  stdout: string;
  stderr: string;
  error: string | null;
  output: RocHookCommandOutput | null;
  actionAcceptedByEvent: boolean | null;
  actionRejectedReason: string | null;
  notes: string[];
};

export type SelfConfigServiceDeps = {
  paths: RocPaths;
  hookConfigService: Pick<HookConfigService, 'getConfigPath' | 'loadConfigSnapshot'>;
  hookTrustService: Pick<HookTrustService, 'getTrustPath'>;
  commandRunner: Pick<HookCommandRunner, 'run'>;
  configService: Pick<ConfigService, 'getSettings' | 'getProviders' | 'getPermissions' | 'getMcpConfig'>;
};

const matcherTargetByEvent: Record<RocHookEventName, string> = {
  SessionStart: 'payload.source（chat | background_task）',
  UserPromptSubmit: '忽略 matcher，始终匹配',
  PreToolUse: 'payload.toolName',
  PostToolUse: 'payload.toolName',
  Stop: '忽略 matcher，始终匹配',
  SessionEnd: 'payload.status（completed | failed | cancelled）'
};

const runtimeContract = [
  'stdin 收到一份 RocHookCommandInput JSON：schemaVersion / runId / threadId / workspacePath / cwd / triggeredAt / event / payload。',
  'stdout 必须为空，或恰好一个 {"action":...} JSON 对象；其它任何输出都会得到 hook_output_json_invalid。',
  '退出码必须为 0。非 0 退出得到 hook_command_exit_<code>，与 stdout 内容无关。',
  'timeoutSeconds 为整数秒，默认 30，上限 600。',
  '超时或运行被取消时，Windows 下 Roc 用 taskkill /PID <pid> /T /F 杀掉整棵进程树；被杀的 bash / python 子进程常自己打印 Terminated。',
  'failureMode:"continue" 表示失败只记录不阻断；failureMode:"block" 表示失败即阻断本次事件，但 SessionEnd 永不阻断。',
  '信任 hash 覆盖 event、matcher、type、command、commandWindows、timeoutSeconds、failureMode。改动其中任一项都会让 trustState 回到 review_required，该 handler 在真实运行中被静默跳过。',
  'cwd 是当前工作区真实路径；没有工作区时是 Roc 根目录。/workspace/、/memory/、/skills/ 这类虚拟路径会直接失败为 hook_cwd_virtual_path。',
  'Windows 下命令通过 spawn(command, { shell: true }) 由 cmd.exe 启动，不是 bash；要用 bash / python 必须在命令里显式写出解释器。',
  'SessionStart 每一轮 run 触发一次，不是每个会话一次；写脚本时不要假设只执行一遍。',
  'commandWindows 存在时，Windows 上执行 commandWindows，其它平台执行 command。'
];

const foreignFormatTraps = [
  'Claude Code / Codex 的 "timeout" 字段在 Roc 里叫 timeoutSeconds；hooks.json 是 strict schema，多一个未知字段会让整份配置解析失败。',
  'Roc 不支持 loop_limit：Stop 事件的续跑上限固定为 3 次。',
  'Roc 只有 6 个事件：SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、Stop、SessionEnd。PreCompact、PermissionRequest、Notification、SubagentStop 都会让配置解析失败。',
  'Claude Code 的 stdout {"hookSpecificOutput":{...}} 在 Roc 里非法，只接受 {"action":...}。',
  'Claude Code 用 exit 2 表示阻断；Roc 要求退出码 0，阻断靠 failureMode:"block" 或 stdout {"action":"block"}。',
  '相对路径脚本（例如 .claude/hooks/x.sh）在 Roc 里以工作区真实路径为 cwd 解析，直接照抄通常找不到文件。'
];

const writePolicy = [
  'roc_self_config 是只读工具：它不会写 hooks.json、settings.json 或 hooks-trust.json。',
  '产出配置后把完整 JSON 交给用户，由用户在设置页保存。',
  '保存后用户还必须在设置页对每条 handler 点信任，否则 trustState 为 review_required，真实运行会静默跳过。'
];

const validateNotes = [
  'stdout 必须为空或单个 {"action":...} JSON；{"hookSpecificOutput":...} 会被判为 hook_output_json_invalid。',
  '退出码必须为 0；阻断用 failureMode:"block" 或 stdout {"action":"block"}，exit 2 只会得到 hook_command_exit_2。',
  ...writePolicy
];

const dryRunNotes = [
  'dry_run 忽略 trustState：未信任的 handler 也会试跑，真实运行时它会被静默跳过。',
  'dry_run 用合成 payload，不代表真实事件里的 toolName / prompt 等取值。'
];

export class SelfConfigService {
  constructor(private readonly deps: SelfConfigServiceDeps) {}

  describe(): SelfConfigDescribeResult {
    return {
      action: 'describe',
      paths: this.describePaths(),
      hookConfigJsonSchema: z.toJSONSchema(rocHookConfigSchema, { io: 'input' }),
      events: rocHookEventNames.map((event) => ({
        event,
        allowedActions: [...supportedActionsByEvent[event]],
        matcherTarget: matcherTargetByEvent[event]
      })),
      runtimeContract: [...runtimeContract],
      foreignFormatTraps: [...foreignFormatTraps],
      writePolicy: [...writePolicy]
    };
  }

  async read(): Promise<SelfConfigReadResult> {
    const snapshot = await this.deps.hookConfigService.loadConfigSnapshot();
    const paths = this.describePaths();
    const providers = this.deps.configService.getProviders();
    const mcp = this.deps.configService.getMcpConfig();
    return {
      action: 'read',
      hooks: {
        configPath: snapshot.configPath,
        exists: snapshot.exists,
        validationErrors: [...snapshot.validationErrors],
        handlers: snapshot.handlers.map((handler) => redactHandlerSnapshot(handler)),
        config: sanitizeUnknown(snapshot.config)
      },
      settings: {
        settingsPath: paths.settings,
        settings: sanitizeUnknown(this.deps.configService.getSettings()),
        permissions: sanitizeUnknown(this.deps.configService.getPermissions()),
        providers: sanitizeUnknown(
          providers.providers.map((provider) => ({
            id: provider.id,
            name: provider.name,
            type: provider.type,
            endpoint: provider.endpoint,
            enabled: provider.enabled,
            credentialRef: provider.credentialRef,
            models: provider.models.map((model) => model.id)
          }))
        ),
        defaultModelId: providers.defaultModelId,
        mcp: {
          approvalMode: mcp.approvalMode,
          serverIds: mcp.servers.map((server) => server.id)
        }
      }
    };
  }

  validate(config: unknown): SelfConfigValidateResult {
    const candidate = typeof config === 'string' ? parseConfigText(config) : config;
    const parsed = rocHookConfigSchema.safeParse(candidate);
    if (parsed.success) {
      return {
        action: 'validate',
        valid: true,
        normalizedConfig: parsed.data,
        issues: [],
        notes: [...validateNotes]
      };
    }
    return {
      action: 'validate',
      valid: false,
      normalizedConfig: null,
      issues: parsed.error.issues.map((issue) => createValidateIssue(issue)),
      notes: [...validateNotes]
    };
  }

  async dryRun(input: SelfConfigDryRunInput): Promise<SelfConfigDryRunResult> {
    const snapshot = await this.deps.hookConfigService.loadConfigSnapshot();
    const handler = snapshot.handlers.find((candidate) => candidate.id === input.handlerId);
    if (handler === undefined) {
      throw new Error(
        `self_config_dry_run_handler_not_found:${input.handlerId}:available=${snapshot.handlers.map((candidate) => candidate.id).join(',')}`
      );
    }
    const command = resolveHandlerCommand(handler);
    const cwd = input.cwd === undefined ? this.deps.paths.root : input.cwd;
    const context = {
      handlerId: handler.id,
      event: handler.event,
      command,
      cwd,
      timeoutSeconds: handler.timeoutSeconds,
      enabled: handler.enabled,
      trustState: handler.trustState
    };
    const confirmed = await input.confirm(context);
    if (!confirmed) {
      return {
        action: 'dry_run',
        ...context,
        status: 'declined',
        durationMs: 0,
        stdout: '',
        stderr: '',
        error: 'self_config_dry_run_declined',
        output: null,
        actionAcceptedByEvent: null,
        actionRejectedReason: null,
        notes: [...dryRunNotes]
      };
    }
    const result = await this.deps.commandRunner.run({
      command,
      cwd,
      timeoutSeconds: handler.timeoutSeconds,
      input: createDryRunCommandInput({
        event: handler.event,
        cwd,
        handlerId: handler.id,
        payload: input.payload
      })
    });
    if (result.status === 'failed') {
      return {
        action: 'dry_run',
        ...context,
        status: 'failed',
        durationMs: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error,
        output: null,
        actionAcceptedByEvent: null,
        actionRejectedReason: null,
        notes: [...dryRunNotes]
      };
    }
    const accepted = checkOutputAcceptedByEvent(handler.event, result.output);
    return {
      action: 'dry_run',
      ...context,
      status: 'completed',
      durationMs: result.durationMs,
      stdout: result.stdout,
      stderr: result.stderr,
      error: null,
      output: result.output,
      actionAcceptedByEvent: accepted.accepted,
      actionRejectedReason: accepted.reason,
      notes: [...dryRunNotes]
    };
  }

  private describePaths(): SelfConfigPathsSummary {
    return {
      rocRoot: this.deps.paths.root,
      hooksConfig: this.deps.hookConfigService.getConfigPath(),
      settings: join(this.deps.paths.configDir, 'settings.json'),
      hooksTrust: this.deps.hookTrustService.getTrustPath(),
      skillsDir: this.deps.paths.skillsDir,
      logsDir: this.deps.paths.logsDir
    };
  }
}

function parseConfigText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`self_config_validate_json_invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function createValidateIssue(issue: z.core.$ZodIssue): SelfConfigValidateIssue {
  const path = formatIssuePath(issue.path);
  const unrecognizedKeys = issue.code === 'unrecognized_keys' ? issue.keys : [];
  return {
    path,
    code: issue.code,
    message: issue.message,
    hint: resolveIssueHint({ path, code: issue.code, keys: unrecognizedKeys })
  };
}

function formatIssuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) {
    return '(root)';
  }
  return path.map((segment) => String(segment)).join('.');
}

function resolveIssueHint(input: { path: string; code: string; keys: readonly string[] }): string | null {
  if (input.code === 'unrecognized_keys') {
    return input.keys.map((key) => resolveUnrecognizedKeyHint(input.path, key)).join(' ');
  }
  if (input.path.endsWith('timeoutSeconds')) {
    return 'timeoutSeconds 必须是 1..600 的整数秒。';
  }
  if (input.path.endsWith('type')) {
    return "Roc 只支持 type:'command'，没有 prompt / notification 之类的 handler 类型。";
  }
  if (input.path === 'schemaVersion') {
    return 'hooks.json 顶层必须是 {"schemaVersion":1,"hooks":{...}}。';
  }
  return null;
}

function resolveUnrecognizedKeyHint(path: string, key: string): string {
  if (key === 'timeout') {
    return 'Roc 用 timeoutSeconds（1..600 整数秒，默认 30）替代 Claude Code / Codex 的 timeout。';
  }
  if (key === 'loop_limit' || key === 'loopLimit') {
    return 'Roc 不支持 loop_limit；Stop 事件的续跑上限固定为 3 次。';
  }
  if (path === 'hooks') {
    return `${key} 不是 Roc 的事件名；合法事件只有 ${rocHookEventNames.join('、')}。`;
  }
  return `${key} 不在 Roc hook schema 中；hooks.json 是 strict schema，多余字段会让整份配置解析失败。`;
}

function redactHandlerSnapshot(handler: RocHookConfiguredHandlerSnapshot): RocHookConfiguredHandlerSnapshot {
  return {
    ...handler,
    command: redact(handler.command),
    commandWindows: handler.commandWindows === null ? null : redact(handler.commandWindows),
    statusMessage: handler.statusMessage === null ? null : redact(handler.statusMessage)
  };
}

function sanitizeUnknown(value: unknown): unknown {
  return redactUnknown(maskCredentialKeys(value));
}

const credentialKeys = new Set(['credential', 'credentialRef', 'apiKey', 'api_key', 'token', 'password', 'secret']);

function maskCredentialKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => maskCredentialKeys(item));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (!credentialKeys.has(key)) {
        return [key, maskCredentialKeys(entry)];
      }
      if (typeof entry === 'string') {
        return [key, '[set]'];
      }
      if (entry === null) {
        return [key, '[unset]'];
      }
      return [key, maskCredentialKeys(entry)];
    })
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolveHandlerCommand(handler: RocHookConfiguredHandlerSnapshot): string {
  if (process.platform === 'win32' && handler.commandWindows !== null) {
    return handler.commandWindows;
  }
  return handler.command;
}

function checkOutputAcceptedByEvent(
  event: RocHookEventName,
  output: RocHookCommandOutput
): { accepted: boolean; reason: string | null } {
  try {
    validateHookCommandOutputForEvent(event, output);
    return { accepted: true, reason: null };
  } catch (error) {
    return { accepted: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function createDryRunCommandInput(input: {
  event: RocHookEventName;
  cwd: string;
  handlerId: string;
  payload: Record<string, unknown> | undefined;
}): RocHookCommandInput {
  const base = {
    schemaVersion: 1 as const,
    runId: `dry-run:${input.handlerId}`,
    threadId: null,
    workspacePath: null,
    cwd: input.cwd,
    triggeredAt: new Date().toISOString()
  };
  if (input.event === 'SessionStart') {
    return {
      ...base,
      event: 'SessionStart',
      payload: mergePayload({ source: 'chat' as const, modelId: 'dry-run', workflowHint: null }, input.payload)
    };
  }
  if (input.event === 'UserPromptSubmit') {
    return {
      ...base,
      event: 'UserPromptSubmit',
      payload: mergePayload({ prompt: 'roc_self_config dry run' }, input.payload)
    };
  }
  if (input.event === 'PreToolUse') {
    return {
      ...base,
      event: 'PreToolUse',
      payload: mergePayload({ toolName: 'run_shell_command', toolCallId: 'dry-run', toolInput: {} }, input.payload)
    };
  }
  if (input.event === 'PostToolUse') {
    return {
      ...base,
      event: 'PostToolUse',
      payload: mergePayload(
        { toolName: 'run_shell_command', toolCallId: 'dry-run', toolInput: {}, toolOutput: {} },
        input.payload
      )
    };
  }
  if (input.event === 'Stop') {
    return {
      ...base,
      event: 'Stop',
      payload: mergePayload({ lastAssistantMessage: null, visibleOutput: true }, input.payload)
    };
  }
  return {
    ...base,
    event: 'SessionEnd',
    payload: mergePayload({ status: 'completed' as const, error: null }, input.payload)
  };
}

// 调用方给出的 payload 覆盖只用于试跑，不参与真实事件分发；此处按事件默认 payload 做浅覆盖。
function mergePayload<TPayload extends Record<string, unknown>>(
  defaults: TPayload,
  override: Record<string, unknown> | undefined
): TPayload {
  if (override === undefined) {
    return defaults;
  }
  return { ...defaults, ...override } as TPayload;
}
