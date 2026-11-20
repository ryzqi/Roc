import type { RocPluginContext } from '../../kernel/types';

/** Invalidation only. Consumers reconstruct status and spend from persistent records. */
export function notifyResearchTaskChanged(
  context: Pick<RocPluginContext, 'eventBus' | 'logger' | 'pluginId'>, taskId: string, projectId: string
): void {
  void context.eventBus.publish({
    type: 'research.task.updated', source: context.pluginId,
    payload: { taskId, projectId }, createdAt: new Date().toISOString()
  }).catch(() => context.logger.warn('research_task_notification_failed', { taskId, projectId }));
}
