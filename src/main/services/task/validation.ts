import type { BackgroundTaskPreview } from '../../../shared/types';
import { RocDomainError } from '../errors';

export function requireText(value: string, code: string, message: string, userAction: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new RocDomainError({
      code,
      message,
      category: 'validation',
      retryable: false,
      userAction
    });
  }
  return trimmed;
}

export function invalidTransition(message: string): RocDomainError {
  return new RocDomainError({
    code: 'background_task_invalid_transition',
    message,
    category: 'conflict',
    retryable: false,
    userAction: '请查看任务状态，必要时创建新的后台任务。'
  });
}

export function inferBackgroundRisk(
  allowedActions: string[],
  forbiddenActions: string[]
): BackgroundTaskPreview['riskLevel'] {
  const commands = [...allowedActions, ...forbiddenActions].map((item) => item.toLowerCase());
  if (commands.some((command) => command.includes('git push') || command.includes('rm ') || command.includes('remove-item'))) {
    return 'medium';
  }
  if (commands.length === 0) {
    return 'low';
  }
  return 'medium';
}
