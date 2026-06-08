/**
 * 工具调用视图 - 可交互卡片
 *
 * 特性：
 * - 状态可视化（start/progress/end/error）
 * - 可折叠/展开
 * - 智能 JSON 渲染
 * - 复制功能
 */

import { useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import type { ChatTranscriptActivityBlock } from '../chat-transcript';
import { JsonView } from './json-view';

type ToolCallBlock = Extract<ChatTranscriptActivityBlock, { kind: 'tool_call' }>;

type ToolCallViewProps = {
  block: ToolCallBlock;
};

type ToolStatus = {
  icon: string;
  color: string;
  label: string;
  bgColor: string;
};

const STATUS_CONFIG: Record<ToolCallBlock['status'], ToolStatus> = {
  start: {
    icon: '▶️',
    color: '#3b82f6',
    label: '开始',
    bgColor: '#eff6ff',
  },
  progress: {
    icon: '⏳',
    color: '#f59e0b',
    label: '进行中',
    bgColor: '#fffbeb',
  },
  end: {
    icon: '✅',
    color: '#10b981',
    label: '完成',
    bgColor: '#f0fdf4',
  },
  error: {
    icon: '❌',
    color: '#ef4444',
    label: '错误',
    bgColor: '#fef2f2',
  },
};

export function ToolCallView({ block }: ToolCallViewProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(block.status === 'error');

  const status = STATUS_CONFIG[block.status];
  const hasData = block.input !== null || block.output !== null || block.error !== null;

  return (
    <motion.div
      className={`tool-call-card tool-call-card--${block.status}`}
      style={{ borderColor: status.color }}
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      data-testid="chat-activity-tool"
    >
      <div
        className="tool-call-header"
        onClick={() => hasData && setExpanded(!expanded)}
        style={{ cursor: hasData ? 'pointer' : 'default' }}
      >
        <span className="tool-icon" style={{ color: status.color }}>
          {status.icon}
        </span>
        <span className="tool-name">{block.name}</span>
        <span className="tool-status" style={{ color: status.color }}>
          {status.label}
        </span>
        {hasData && (
          <button className="tool-expand-btn" type="button">
            {expanded ? '▼' : '▶'}
          </button>
        )}
      </div>

      <AnimatePresence>
        {expanded && hasData && (
          <motion.div
            className="tool-call-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            {block.input !== null && block.input !== undefined && (
              <ToolDataSection label="输入" data={block.input} />
            )}
            {block.output !== null && block.output !== undefined && (
              <ToolDataSection label="输出" data={block.output} />
            )}
            {block.error !== null && block.error !== undefined && (
              <ToolDataSection label="错误" data={block.error} variant="error" />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

type ToolDataSectionProps = {
  label: string;
  data: unknown;
  variant?: 'default' | 'error';
};

function ToolDataSection({ label, data, variant = 'default' }: ToolDataSectionProps): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      (error) => {
        console.error('复制失败:', error);
      }
    );
  }, [data]);

  return (
    <div className={`tool-data-section tool-data-section--${variant}`}>
      <div className="tool-data-header">
        <span className="tool-data-label">{label}</span>
        <button className="tool-data-copy" onClick={handleCopy} title="复制" type="button">
          {copied ? '✓' : '📋'}
        </button>
      </div>
      <div className="tool-data-content">
        <JsonView data={data} />
      </div>
    </div>
  );
}
