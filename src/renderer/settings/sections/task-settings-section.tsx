import { useState } from 'react';
import type React from 'react';
import type { AppSettings } from '../../../shared/types';
import { FieldRow } from '../atoms';

type NumberFieldName =
  | 'runningSeconds'
  | 'toolCallCount'
  | 'subagentCount'
  | 'maxRegisteredTasks';

type NumberFieldRule = {
  field: NumberFieldName;
  hint: string;
  label: string;
  min: number;
  testId: string;
  value: number;
};

export function TaskSettingsSection({
  draft,
  onChange
}: {
  draft: AppSettings;
  onChange: (next: AppSettings) => void;
}): React.JSX.Element {
  const [errors, setErrors] = useState<Partial<Record<NumberFieldName, string>>>({});

  const thresholdRules: NumberFieldRule[] = [
    {
      field: 'runningSeconds',
      hint: '任务运行达到该秒数后，会被视为长任务候选。',
      label: '运行秒数',
      min: 0,
      testId: 'settings-task-running-seconds',
      value: draft.tasks.longRunningThresholds.runningSeconds
    },
    {
      field: 'toolCallCount',
      hint: '工具调用达到该次数后，会提高长任务识别权重。',
      label: '工具调用数',
      min: 0,
      testId: 'settings-task-tool-call-count',
      value: draft.tasks.longRunningThresholds.toolCallCount
    },
    {
      field: 'subagentCount',
      hint: '子代理数量达到该值后，会被视为复杂任务候选。',
      label: '子代理数',
      min: 0,
      testId: 'settings-task-subagent-count',
      value: draft.tasks.longRunningThresholds.subagentCount
    }
  ];

  const schedulerRule: NumberFieldRule = {
    field: 'maxRegisteredTasks',
    hint: '限制后台调度器可登记的任务总数。',
    label: '最大注册任务数',
    min: 1,
    testId: 'settings-task-max-registered-tasks',
    value: draft.tasks.scheduler.maxRegisteredTasks
  };

  function parseInteger(raw: string, min: number): number | string {
    const normalized = raw.trim();
    if (normalized.length === 0) {
      return min === 0 ? '必须是大于或等于 0 的整数' : '必须是大于 0 的整数';
    }
    const value = Number(normalized);
    if (!Number.isInteger(value) || value < min) {
      return min === 0 ? '必须是大于或等于 0 的整数' : '必须是大于 0 的整数';
    }
    return value;
  }

  function clearFieldError(field: NumberFieldName): void {
    setErrors((current) => {
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  function setNumberField(rule: NumberFieldRule, raw: string): void {
    const parsed = parseInteger(raw, rule.min);
    if (typeof parsed === 'string') {
      setErrors((current) => ({ ...current, [rule.field]: parsed }));
      return;
    }
    clearFieldError(rule.field);
    if (rule.field === 'maxRegisteredTasks') {
      onChange({
        ...draft,
        tasks: {
          ...draft.tasks,
          scheduler: {
            ...draft.tasks.scheduler,
            maxRegisteredTasks: parsed
          }
        }
      });
      return;
    }
    onChange({
      ...draft,
      tasks: {
        ...draft.tasks,
        longRunningThresholds: {
          ...draft.tasks.longRunningThresholds,
          [rule.field]: parsed
        }
      }
    });
  }

  return (
    <section className="single-panel settings-section-panel" data-testid="settings-panel-tasks">
      <div className="section-head">
        <h2 className="section-title">任务与调度</h2>
      </div>
      <div className="settings-section-group">
        <h3 className="settings-group-title">长任务识别</h3>
        <div className="form-grid">
          {thresholdRules.map((rule) => (
            <FieldRow hint={rule.hint} key={rule.field} label={rule.label}>
              <input
                data-testid={rule.testId}
                inputMode="numeric"
                min={rule.min}
                onChange={(event) => setNumberField(rule, event.currentTarget.value)}
                type="number"
                value={rule.value}
              />
              {errors[rule.field] === undefined ? null : (
                <small className="field-error">{errors[rule.field]}</small>
              )}
            </FieldRow>
          ))}
        </div>
      </div>
      <div className="settings-section-group">
        <h3 className="settings-group-title">后台调度</h3>
        <div className="form-grid">
          <label className="field checkbox-field settings-toggle-row">
            <span>启动时补跑</span>
            <input
              checked={draft.tasks.scheduler.catchUpOnStartup}
              data-testid="settings-task-catch-up-on-startup"
              onChange={(event) =>
                onChange({
                  ...draft,
                  tasks: {
                    ...draft.tasks,
                    scheduler: {
                      ...draft.tasks.scheduler,
                      catchUpOnStartup: event.currentTarget.checked
                    }
                  }
                })
              }
              type="checkbox"
            />
            <small className="field-hint">应用启动时补跑错过触发时间的后台任务。</small>
          </label>
          <FieldRow hint={schedulerRule.hint} label={schedulerRule.label}>
            <input
              data-testid={schedulerRule.testId}
              inputMode="numeric"
              min={schedulerRule.min}
              onChange={(event) => setNumberField(schedulerRule, event.currentTarget.value)}
              type="number"
              value={schedulerRule.value}
            />
            {errors.maxRegisteredTasks === undefined ? null : (
              <small className="field-error">{errors.maxRegisteredTasks}</small>
            )}
          </FieldRow>
        </div>
      </div>
    </section>
  );
}
