import type {ResearchTask} from '../../../shared/schemas/research-tasks';

type CleanupReason = 'research_task_cleanup_pending' | 'research_task_cleanup_failed' | null;
type TaskPresentation = {
  label: string;
  group: 'current' | 'pending' | 'completed' | 'failed';
  cleanupReason: CleanupReason;
};

const taskStates: Record<ResearchTask['status'], Omit<TaskPresentation, 'cleanupReason'>> = {
  active: {label: '进行中', group: 'current'},
  paused: {label: '已暂停', group: 'pending'},
  waiting_approval: {label: '等待审批', group: 'pending'},
  interrupted: {label: '运行中断', group: 'pending'},
  completed: {label: '已完成', group: 'completed'},
  cancelled: {label: '已取消', group: 'completed'},
  failed: {label: '失败', group: 'failed'}
};

/** Cleanup receipts qualify the display; persisted task status and commands remain authoritative. */
export function researchTaskPresentation(task: Pick<ResearchTask, 'status' | 'statusReason'>): TaskPresentation {
  if (task.statusReason === 'research_task_cleanup_pending') {
    return {label: '正在取消', group: 'current', cleanupReason: task.statusReason};
  }
  if (task.statusReason === 'research_task_cleanup_failed') {
    return {label: '资源清理未确认', group: 'failed', cleanupReason: task.statusReason};
  }
  return {...taskStates[task.status], cleanupReason: null};
}

export function researchTaskReasonLabel(reason: string | null): string | null {
  if (reason === 'research_task_cleanup_pending') return '正在停止执行并等待资源清理确认。';
  if (reason === 'research_task_cleanup_failed') return '资源清理未确认，请查看任务详情中的停止回执。';
  if (reason === 'research_provider_reply_loop') return '模型服务检测到循环回复并终止生成。请在模型设置中更换模型后继续当前任务。';
  if (reason === 'research_stage_inputs_stale') return '阶段输入已变化，请在任务详情核对当前输入和已有成果。';
  // Machine codes remain available in diagnostics without becoming the user explanation.
  return reason !== null && /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/u.test(reason) ? null : reason;
}
