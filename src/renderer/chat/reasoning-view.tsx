/**
 * 交互式推理内容视图
 *
 * 特性：
 * - 结构化展示推理步骤
 * - 可折叠/展开
 * - 步骤高亮选择
 * - 复制功能
 * - 流式动画
 */

import { useState, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  parseReasoningContent,
  getStepTypeLabel,
  getStepTypeColor,
  getStepTypeIcon,
  type ReasoningStep,
} from './reasoning-parser';
import { MarkdownView } from './markdown-view';

type ReasoningViewProps = {
  content: string;
  isStreaming: boolean;
};

export function ReasoningView({ content, isStreaming }: ReasoningViewProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(isStreaming);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);

  const steps = useMemo(() => parseReasoningContent(content), [content]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content).catch((error) => {
      console.error('复制推理内容失败:', error);
    });
  }, [content]);

  const handleStepClick = useCallback((stepId: string) => {
    setSelectedStepId((current) => (current === stepId ? null : stepId));
  }, []);

  return (
    <details
      className="chat-bubble-reasoning"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="reasoning-summary">
        <span className="reasoning-label">推理 · {steps.length} 步</span>
        <div className="reasoning-actions">
          <button
            className="reasoning-action-btn"
            onClick={(e) => {
              e.preventDefault();
              handleCopy();
            }}
            title="复制推理内容"
            type="button"
          >
            📋
          </button>
        </div>
      </summary>

      <div className="reasoning-timeline">
        <AnimatePresence mode="popLayout">
          {steps.map((step, index) => (
            <ReasoningStepCard
              key={step.id}
              step={step}
              index={index}
              isSelected={selectedStepId === step.id}
              onClick={() => handleStepClick(step.id)}
            />
          ))}
        </AnimatePresence>

        {isStreaming && (
          <motion.div
            className="reasoning-pulse"
            animate={{ opacity: [0.3, 1, 0.3] }}
            transition={{ repeat: Infinity, duration: 1.5, ease: 'easeInOut' }}
          >
            <span className="reasoning-pulse-icon">💭</span>
            <span className="reasoning-pulse-text">思考中...</span>
          </motion.div>
        )}
      </div>
    </details>
  );
}

type ReasoningStepCardProps = {
  step: ReasoningStep;
  index: number;
  isSelected: boolean;
  onClick: () => void;
};

function ReasoningStepCard({ step, index, isSelected, onClick }: ReasoningStepCardProps): React.JSX.Element {
  const color = getStepTypeColor(step.type);
  const icon = getStepTypeIcon(step.type);
  const label = getStepTypeLabel(step.type);

  return (
    <motion.div
      className={`reasoning-step ${isSelected ? 'reasoning-step--selected' : ''}`}
      data-type={step.type}
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      transition={{ delay: index * 0.03, duration: 0.2 }}
      onClick={onClick}
    >
      <div className="step-marker" style={{ background: color }}>
        <span className="step-marker-icon">{icon}</span>
      </div>

      <div className="step-content">
        <div className="step-header">
          <span className="step-type-label" style={{ color }}>
            {label}
          </span>
          <span className="step-line-number">#{step.lineNumber}</span>
        </div>

        <div className="step-body">
          <MarkdownView text={step.content} />
        </div>
      </div>
    </motion.div>
  );
}
