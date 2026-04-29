import type { ChatSubmitRequest, ChatSubmitResult } from '../../shared/types';
import type { AgentService } from './agent-service';
import type { ConfigService } from './config-service';
import { RocDomainError } from './errors';
import type { ProviderRuntimeService } from './provider-runtime-service';
import type { TaskService } from './task-service';

export class ChatService {
  constructor(
    private readonly configService: ConfigService,
    private readonly taskService: TaskService,
    private readonly agentService: AgentService,
    private readonly providerRuntimeService: ProviderRuntimeService
  ) {}

  async submit(request: ChatSubmitRequest): Promise<ChatSubmitResult> {
    const input = request.input.trim();
    if (input.length === 0) {
      throw new RocDomainError({
        code: 'chat_input_empty',
        message: '聊天输入不能为空。',
        category: 'validation',
        retryable: true,
        userAction: '请输入要发送给 Roc 的内容。'
      });
    }

    const defaultModelState = this.configService.getDefaultModelState();
    if (defaultModelState.status !== 'ready' || defaultModelState.modelId === null || defaultModelState.providerId === null) {
      throw this.configService.createDefaultModelError(defaultModelState);
    }

    if (request.mode === 'chat') {
      const result = await this.providerRuntimeService.executeChat({
        input,
        enabledCapabilities: request.enabledCapabilities
      });
      return {
        status: 'answered',
        assistantMessage: result.assistantMessage,
        providerId: result.providerId,
        modelId: result.modelId,
        createdAt: result.createdAt,
        durationMs: result.durationMs,
        summary: result.summary
      };
    }

    const capabilityPreview = this.agentService.getCapabilityPreview(request.enabledCapabilities);
    const run = this.taskService.createTaskRun({
      userInput: input,
      modelId: defaultModelState.modelId,
      enabledCapabilities: request.enabledCapabilities
    });
    this.taskService.recordAgentCapabilityManifest({
      threadId: run.threadId,
      runId: run.id,
      preview: capabilityPreview
    });
    try {
      const result = await this.providerRuntimeService.executeChat({
        input,
        enabledCapabilities: request.enabledCapabilities
      });
      this.taskService.completeRunWithProviderResult({
        runId: run.id,
        result
      });

      return {
        status: 'task_answered',
        assistantMessage: result.assistantMessage,
        providerId: result.providerId,
        modelId: result.modelId,
        threadId: run.threadId,
        runId: run.id,
        createdAt: result.createdAt,
        durationMs: result.durationMs,
        summary: result.summary
      };
    } catch (error) {
      if (error instanceof RocDomainError) {
        this.taskService.failRunWithProviderError({
          runId: run.id,
          providerId: defaultModelState.providerId,
          modelId: defaultModelState.modelId,
          code: error.code,
          message: error.message,
          retryable: error.retryable
        });
      }
      throw error;
    }
  }
}
