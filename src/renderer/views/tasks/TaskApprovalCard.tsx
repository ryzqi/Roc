import { useState } from 'react';
import type { ChatPendingApproval, ChatResumeDecision } from '../../../shared/types';
import {
  buildTaskApprovalEditDecision,
  createTaskFormDraft,
  type TaskFormDraft
} from './task-form-model';

export function TaskApprovalCard({
  approval,
  onApprovalDecision
}: {
  approval: ChatPendingApproval;
  onApprovalDecision?: (approvalId: string, decisions: ChatResumeDecision[]) => void;
}): React.JSX.Element {
  const action = approval.actionRequests[0];
  const args = action?.args;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<TaskFormDraft>(() => createDraftFromApproval(approval));

  if (action === undefined) {
    return (
      <div className="chat-approval-card chat-approval-card--task" data-testid="task-approval-card">
        <header className="chat-approval-head">AI 提议：后台任务审批</header>
      </div>
    );
  }

  return (
    <div className="chat-approval-card chat-approval-card--task" data-testid="task-approval-card">
      <header className="chat-approval-head">AI 提议：{formatTaskApprovalTitle(action.name)}</header>
      {editing ? (
        <div className="task-approval-form">
          {action.name === 'cancel_background_task' ? (
            <label className="task-form-field">
              <span>原因</span>
              <textarea
                data-testid="task-approval-edit-reason"
                rows={3}
                value={draft.reason}
                onChange={(event) => setDraft((current) => ({ ...current, reason: event.target.value }))}
              />
            </label>
          ) : (
            <>
              <label className="task-form-field">
                <span>目标</span>
                <textarea
                  data-testid="task-approval-edit-goal"
                  rows={3}
                  value={draft.goal}
                  onChange={(event) => setDraft((current) => ({ ...current, goal: event.target.value }))}
                />
              </label>
              <label className="task-form-field">
                <span>触发类型</span>
                <select
                  data-testid="task-approval-edit-trigger-type"
                  value={draft.triggerType}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      triggerType: event.target.value as TaskFormDraft['triggerType']
                    }))
                  }
                >
                  <option value="manual">手动</option>
                  <option value="once">一次</option>
                  <option value="cron">定时</option>
                </select>
              </label>
              <label className="task-form-field">
                <span>触发描述</span>
                <input
                  data-testid="task-approval-edit-trigger-description"
                  type="text"
                  value={draft.triggerDescription}
                  onChange={(event) => setDraft((current) => ({ ...current, triggerDescription: event.target.value }))}
                />
              </label>
              {draft.triggerType === 'manual' ? null : (
                <label className="task-form-field">
                  <span>下次运行时间</span>
                  <input
                    data-testid="task-approval-edit-next-run-at"
                    type="datetime-local"
                    value={draft.nextRunAt}
                    onChange={(event) => setDraft((current) => ({ ...current, nextRunAt: event.target.value }))}
                  />
                </label>
              )}
              {draft.triggerType !== 'cron' ? null : (
                <label className="task-form-field">
                  <span>Cron 表达式</span>
                  <input
                    data-testid="task-approval-edit-cron-expression"
                    type="text"
                    value={draft.cronExpression}
                    onChange={(event) => setDraft((current) => ({ ...current, cronExpression: event.target.value }))}
                  />
                </label>
              )}
              <label className="task-form-field">
                <span>工作区路径</span>
                <input
                  data-testid="task-approval-edit-workspace-path"
                  type="text"
                  value={draft.workspacePath}
                  onChange={(event) => setDraft((current) => ({ ...current, workspacePath: event.target.value }))}
                />
              </label>
              <label className="task-form-field">
                <span>允许动作</span>
                <textarea
                  data-testid="task-approval-edit-allowed-actions"
                  rows={3}
                  value={draft.allowedActionsText}
                  onChange={(event) => setDraft((current) => ({ ...current, allowedActionsText: event.target.value }))}
                />
              </label>
              <label className="task-form-field">
                <span>禁止动作</span>
                <textarea
                  data-testid="task-approval-edit-forbidden-actions"
                  rows={3}
                  value={draft.forbiddenActionsText}
                  onChange={(event) => setDraft((current) => ({ ...current, forbiddenActionsText: event.target.value }))}
                />
              </label>
              {action.name !== 'update_background_task' ? null : (
                <label className="task-form-field">
                  <span>修改原因</span>
                  <textarea
                    data-testid="task-approval-edit-reason"
                    rows={3}
                    value={draft.reason}
                    onChange={(event) => setDraft((current) => ({ ...current, reason: event.target.value }))}
                  />
                </label>
              )}
            </>
          )}
        </div>
      ) : (
        <pre className="chat-approval-args">{JSON.stringify(args, null, 2)}</pre>
      )}
      <div className="chat-approval-buttons">
        <button
          type="button"
          className="approval-btn approval-btn--approve"
          onClick={() => onApprovalDecision?.(approval.interruptId, [{ type: 'approve' }])}
        >
          {action.name === 'cancel_background_task' ? '批准取消' : '批准创建'}
        </button>
        <button
          type="button"
          className="approval-btn approval-btn--edit"
          onClick={() => {
            if (!editing) {
              setDraft(createDraftFromApproval(approval));
              setEditing(true);
              return;
            }
            onApprovalDecision?.(approval.interruptId, [buildTaskApprovalEditDecision({ approval, draft })]);
          }}
        >
          {editing ? '提交编辑' : '编辑后批准'}
        </button>
        {editing ? (
          <button
            type="button"
            className="approval-btn approval-btn--edit"
            onClick={() => {
              setDraft(createDraftFromApproval(approval));
              setEditing(false);
            }}
          >
            取消编辑
          </button>
        ) : null}
        <button
          type="button"
          className="approval-btn approval-btn--reject"
          onClick={() => onApprovalDecision?.(approval.interruptId, [{ type: 'reject' }])}
        >
          拒绝
        </button>
      </div>
    </div>
  );
}

export function isTaskApproval(approval: ChatPendingApproval): boolean {
  if (approval.actionRequests.length !== 1) {
    return false;
  }
  const request = approval.actionRequests[0];
  return request?.name === 'propose_background_task' ||
    request?.name === 'update_background_task' ||
    request?.name === 'cancel_background_task';
}

function formatTaskApprovalTitle(name: string): string {
  if (name === 'update_background_task') {
    return '修改任务';
  }
  if (name === 'cancel_background_task') {
    return '取消任务';
  }
  return '创建定时任务';
}

function createDraftFromApproval(approval: ChatPendingApproval): TaskFormDraft {
  const action = approval.actionRequests[0];
  if (action === undefined) {
    return createTaskFormDraft();
  }
  if (action.name === 'cancel_background_task') {
    return createTaskFormDraft({
      reason: readStringField(action.args, 'reason')
    });
  }
  if (action.name === 'update_background_task') {
    const patch = readObjectField(action.args, 'patch');
    return createTaskFormDraft({
      goal: readStringField(patch, 'goal'),
      trigger: readTriggerField(patch),
      workspacePath: readStringField(patch, 'workspacePath'),
      allowedActions: readStringArrayField(patch, 'allowedActions'),
      forbiddenActions: readStringArrayField(patch, 'forbiddenActions'),
      reason: readStringField(action.args, 'reason')
    });
  }
  return createTaskFormDraft(readObjectField(action.args));
}

function readObjectField(value: unknown, key?: string): Record<string, unknown> {
  const target =
    key === undefined || typeof value !== 'object' || value === null ? value : Reflect.get(value, key);
  return typeof target === 'object' && target !== null ? (target as Record<string, unknown>) : {};
}

function readStringField(value: unknown, key: string): string {
  const target = typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
  return typeof target === 'string' ? target : '';
}

function readStringArrayField(value: unknown, key: string): string[] {
  const target = typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
  return Array.isArray(target) ? target.filter((item): item is string => typeof item === 'string') : [];
}

function readTriggerField(value: unknown) {
  const target = typeof value === 'object' && value !== null ? Reflect.get(value, 'trigger') : undefined;
  if (typeof target !== 'object' || target === null) {
    return undefined;
  }
  const type = Reflect.get(target, 'type');
  const description = Reflect.get(target, 'description');
  if (type === 'manual' && typeof description === 'string') {
    return {
      type,
      description
    } as const;
  }
  const nextRunAt = Reflect.get(target, 'nextRunAt');
  if (type === 'once' && typeof description === 'string' && typeof nextRunAt === 'string') {
    return {
      type,
      description,
      nextRunAt
    } as const;
  }
  const cronExpression = Reflect.get(target, 'cronExpression');
  if (type === 'cron' && typeof description === 'string' && typeof nextRunAt === 'string' && typeof cronExpression === 'string') {
    return {
      type,
      description,
      nextRunAt,
      cronExpression
    } as const;
  }
  return undefined;
}
