import type { BackgroundTaskPreview } from '../../../shared/types';

export { requireText } from '../validation';

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
