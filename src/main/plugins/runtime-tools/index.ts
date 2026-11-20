import { z } from 'zod';

import { runCapabilityManifestSchema } from '../../../shared/schemas/agent';
import {
  rtkStatusSchema,
  shellConfirmationRequestSchema,
  shellConfirmationResultSchema,
  shellExecutionResultSchema
} from '../../../shared/schemas/ipc-workspace';
import type {
  ShellConfirmationRequest,
  ShellConfirmationResult,
  ShellExecutionResult
} from '../../../shared/types';
import type { RTKBinaryManager } from '../../../rtk-integration';
import type { CapabilityDescriptor, RocPlugin } from '../../kernel/types';
import type { WorkspaceService } from '../../services/workspace-service';
import { ExecutionGrantBroker, assertConsumedExecutionGrant, type ExecutionGrantBinding } from '../../services/deep-agent/execution-grant-broker';
import { MacOsIsolatedEnvironment, type ExecutionEnvironment, type IsolationProfile } from '../../services/execution-environment';
import { WebReadService, type WebReadExecutionRequest, type WebReadResult } from '../../services/web-read-service';
import { RocPaths } from '../../services/paths';
import { RtkService } from '../../services/rtk-service';
import { webReadExecutionRequestSchema } from '../../services/web-read-request-schema';
import {
  createShellExecutionService,
  type ShellCommandExecutor
} from './shell-adapter';

const pluginId = '@roc/plugin-runtime-tools';
const capabilityVersion = '1.0.0';

const emptyInputSchema = z.object({});
const shellExecutionRequestSchema = z.object({
  command: z.string().trim().min(1).max(16384),
  cwd: z.string().trim().min(1).optional()
}).strict();
const executionGrantBindingSchema = z.object({
  runId: z.string().min(1),
  threadId: z.string().min(1),
  toolCallId: z.string().min(1),
  toolName: z.enum(['run_shell_command', 'run_isolated_read_command', 'run_trusted_host_command']),
  profile: z.enum(['isolated_read', 'isolated_write', 'trusted_host']),
  workspacePath: z.string().min(1),
  command: z.string().trim().min(1).max(16384),
  cwd: z.string().trim().min(1).optional(),
  manifest: runCapabilityManifestSchema,
  allowedCommands: z.array(z.string().trim().min(1)).optional(),
  approvalReference: z.string().uuid().optional()
}).strict() satisfies z.ZodType<ExecutionGrantBinding>;
const executeAgentRequestSchema = z.object({
  grantId: z.string().uuid(),
  binding: executionGrantBindingSchema,
  signal: z.custom<AbortSignal>().optional()
}).strict();
const approveTrustedHostRequestSchema = z.object({
  binding: executionGrantBindingSchema,
  confirmation: shellConfirmationRequestSchema
}).strict();
const approveTrustedHostResultSchema = z.object({
  confirmed: z.boolean(),
  approvalReference: z.string().uuid().optional()
}).strict();
const webReadResultSchema = z.object({
  content: z.string().min(1),
  source: z.string().url(),
  proxy: z.literal('https://r.jina.ai/'),
  fetchedAt: z.string().min(1),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  untrusted: z.literal(true)
}) satisfies z.ZodType<WebReadResult>;

const runtimeToolsCapabilityDescriptors = [
  descriptor('rtk.status', emptyInputSchema, rtkStatusSchema),
  descriptor('shell.execute', shellExecutionRequestSchema, shellExecutionResultSchema),
  descriptor('shell.confirm', shellConfirmationRequestSchema, shellConfirmationResultSchema),
  descriptor('shell.approveTrustedHost', approveTrustedHostRequestSchema, approveTrustedHostResultSchema),
  descriptor('shell.executeAgent', executeAgentRequestSchema, shellExecutionResultSchema),
  descriptor('web.read', webReadExecutionRequestSchema, webReadResultSchema)
] as const satisfies readonly CapabilityDescriptor[];

export type RuntimeToolsPluginOptions = {
  rootDir?: string;
  workspacePath?: string;
  /**
   * The shell's working-directory binding. When the shell hands over the instance it owns,
   * `shell.execute` without an explicit `cwd` resolves the bound directory; a private instance
   * would never see `workspace.select` and would always answer `workspace_not_selected`.
   */
  workspaceService?: WorkspaceService;
  binaryManager?: RTKBinaryManager;
  commandExecutor?: ShellCommandExecutor;
  confirmShellRequest?: (request: ShellConfirmationRequest) => Promise<ShellConfirmationResult>;
  executionGrantBroker?: ExecutionGrantBroker;
  executionEnvironmentFactory?: (input: {
    workspacePath: string;
    profile: IsolationProfile;
    workspaceIdentity: { dev: string; ino: string };
  }) => ExecutionEnvironment;
  fetchImpl?: ConstructorParameters<typeof WebReadService>[0];
};

export function createRuntimeToolsPlugin(options: RuntimeToolsPluginOptions = {}): RocPlugin {
  return {
    manifest: {
      id: pluginId,
      version: '1.0.0',
      displayName: 'Runtime Tools',
      description: 'Roc runtime tools plugin.',
      required: true,
      order: 70,
      dependencies: [],
      capabilities: runtimeToolsCapabilityDescriptors
    },
    initialize: async (context) => {
      const paths = new RocPaths(options.rootDir);
      paths.ensureTree();
      const rtkService = new RtkService(paths, options.binaryManager);
      const shellService = createShellExecutionService({
        workspacePath: options.workspacePath,
        workspaceService: options.workspaceService,
        rtkService,
        commandExecutor: options.commandExecutor
      });
      const webReadService = new WebReadService(options.fetchImpl);
      context.capabilities.register(pluginId, runtimeToolsCapabilityDescriptors[0], async () => rtkService.getStatus());
      context.capabilities.register(pluginId, runtimeToolsCapabilityDescriptors[1], async (input) =>
        shellService.executeAsync({ ...(input as { command: string; cwd?: string }), source: 'terminal' })
      );
      context.capabilities.register(pluginId, runtimeToolsCapabilityDescriptors[2], async (input) =>
        confirmShell(input as ShellConfirmationRequest, options.confirmShellRequest)
      );
      context.capabilities.register(pluginId, runtimeToolsCapabilityDescriptors[3], async (input) => {
        if (options.executionGrantBroker === undefined) throw new Error('execution_grant_broker_unavailable');
        if (process.env.ROC_SMOKE === '1') throw new Error('trusted_host_approval_unavailable_in_smoke');
        const request = input as z.infer<typeof approveTrustedHostRequestSchema>;
        const result = await confirmShell(request.confirmation, options.confirmShellRequest);
        if (!result.confirmed) return { confirmed: false };
        return {
          confirmed: true,
          approvalReference: options.executionGrantBroker.recordTrustedHostApproval(request.binding)
        };
      });
      context.capabilities.register(pluginId, runtimeToolsCapabilityDescriptors[4], async (input) => {
        const request = input as z.infer<typeof executeAgentRequestSchema>;
        if (options.executionGrantBroker === undefined) throw new Error('execution_grant_broker_unavailable');
        if (request.signal?.aborted) throw new Error('shell_execution_aborted');
        const grant = options.executionGrantBroker.consume(request.grantId, request.binding);
        if (grant.profile === 'trusted_host') {
          return shellService.executeGrantedAgentAsync({ command: request.binding.command, signal: request.signal, grant });
        }
        const startedAt = Date.now();
        let environment: ExecutionEnvironment | undefined;
        let recorded = false;
        const recordFailure = (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          recorded = true;
          shellService.recordGrantedAgentExecution(grant, {
            command: request.binding.command,
            normalizedCommand: request.binding.command,
            cwd: grant.cwd,
            stdout: '',
            stderr: message,
            exitCode: 1,
            durationMs: Date.now() - startedAt,
            usedRtk: false,
            truncated: false
          }, message.split(':', 1)[0]);
        };
        const dispose = () => {
          if (environment === undefined) return;
          try {
            environment.dispose();
          } catch (error) {
            try {
              context.logger.warn('isolated_execution_environment_dispose_failed', {
                runId: request.binding.runId,
                grantId: request.grantId,
                error: error instanceof Error ? error.message : String(error)
              });
            } catch {
              process.emitWarning('isolated_execution_environment_dispose_log_failed');
            }
          }
        };
        try {
          assertConsumedExecutionGrant(grant, {
            command: request.binding.command,
            cwd: grant.cwd,
            profile: grant.profile,
            workspacePath: grant.workspacePath
          });
          environment = options.executionEnvironmentFactory === undefined
            ? new MacOsIsolatedEnvironment(grant.workspacePath, grant.profile, { dev: grant.workspaceDev, ino: grant.workspaceIno })
            : options.executionEnvironmentFactory({
                workspacePath: grant.workspacePath,
                profile: grant.profile,
                workspaceIdentity: { dev: grant.workspaceDev, ino: grant.workspaceIno }
              });
          if (environment.profile !== grant.profile) throw new Error('isolated_execution_profile_mismatch');
          const result = await environment.execute({
            file: '/bin/zsh',
            args: ['-f', '-c', request.binding.command],
            cwd: grant.cwd,
            signal: request.signal,
            timeoutMs: grant.maxDurationMs,
            maxOutputBytes: grant.maxOutputBytes
          });
          const shellResult: ShellExecutionResult = {
            command: request.binding.command,
            normalizedCommand: request.binding.command,
            cwd: grant.cwd,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            durationMs: Date.now() - startedAt,
            usedRtk: false,
            truncated: false
          };
          recorded = true;
          shellService.recordGrantedAgentExecution(grant, shellResult);
          return shellResult;
        } catch (error) {
          if (!recorded) recordFailure(error);
          throw error;
        } finally {
          dispose();
        }
      });
      context.capabilities.register(pluginId, runtimeToolsCapabilityDescriptors[5], async (input) =>
        webReadService.read(input as WebReadExecutionRequest)
      );
    },
    shutdown: async () => {},
    healthCheck: async () => ({ status: 'healthy' })
  };
}

async function confirmShell(
  request: ShellConfirmationRequest,
  confirmShellRequest: RuntimeToolsPluginOptions['confirmShellRequest']
): Promise<ShellConfirmationResult> {
  if (confirmShellRequest !== undefined) {
    return confirmShellRequest(request);
  }
  return {
    confirmed: false,
    response: 1
  };
}

function descriptor<TInput, TOutput>(
  name: string,
  inputSchema: z.ZodType<TInput>,
  outputSchema: z.ZodType<TOutput>
): CapabilityDescriptor<TInput, TOutput> {
  return {
    name,
    version: capabilityVersion,
    inputSchema,
    outputSchema
  };
}
