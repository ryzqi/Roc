import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  ChatMessage,
  AgentToolCall,
  WorkspaceTab,
  ModelSettings,
  MessageBlock
} from '../types/research';
import { MathView } from './MathView';
import {
  Send,
  Paperclip,
  Globe,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Terminal,
  FileText,
  Share2,
  BarChart3,
  BookOpen,
  ArrowRight,
  BrainCircuit,
  Bot,
  Sparkles,
  Copy,
  Check,
  RotateCcw,
  Plus,
  Maximize2,
  Minimize2,
  X,
  Sliders
} from 'lucide-react';

interface AgentChatProps {
  messages: ChatMessage[];
  onSendMessage: (text: string) => void;
  isProcessing: boolean;
  onOpenWorkspaceTab: (tab: WorkspaceTab) => void;
  settings: ModelSettings;
  onSwitchModel?: (modelId: string, provider?: ModelSettings['provider']) => void;
  onClose?: () => void;
  currentWidth?: number;
  onSetWidth?: (width: number) => void;
  onResetWidth?: () => void;
  onOpenSettings?: (tab?: string) => void;
}

// Model options reflecting Claude Desktop and Codex App ecosystem
const AVAILABLE_MODELS: { id: string; name: string; badge: string; provider: ModelSettings['provider'] }[] = [
  { id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet', badge: 'Hybrid Thinking', provider: 'claude' },
  { id: 'deepseek-r1', name: 'DeepSeek-R1', badge: '671B CoT', provider: 'deepseek' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', badge: 'Multimodal 2M', provider: 'gemini' },
  { id: 'gpt-4o', name: 'GPT-4o', badge: 'Omni Reasoning', provider: 'gpt4o' }
];

// Helper to copy text to clipboard
const copyToClipboard = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

// Rich Markdown & KaTeX text renderer
const FormattedMessageText: React.FC<{
  content: string;
  isStreaming?: boolean;
}> = ({ content, isStreaming }) => {
  const [copiedCodeIdx, setCopiedCodeIdx] = useState<number | null>(null);

  const handleCopyCode = async (code: string, idx: number) => {
    const success = await copyToClipboard(code);
    if (success) {
      setCopiedCodeIdx(idx);
      setTimeout(() => setCopiedCodeIdx(null), 1800);
    }
  };

  // Parse fenced code blocks
  const segments = React.useMemo(() => {
    const parts: { type: 'code' | 'text'; content: string; language?: string }[] = [];
    const codeBlockRegex = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = codeBlockRegex.exec(content)) !== null) {
      if (match.index > lastIndex) {
        parts.push({
          type: 'text',
          content: content.slice(lastIndex, match.index)
        });
      }
      parts.push({
        type: 'code',
        language: match[1] || 'text',
        content: match[2].trimEnd()
      });
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < content.length) {
      parts.push({
        type: 'text',
        content: content.slice(lastIndex)
      });
    }

    return parts;
  }, [content]);

  return (
    <div className="space-y-2.5 text-[13px] leading-relaxed text-zinc-200 select-text font-sans break-words">
      {segments.map((seg, sIdx) => {
        if (seg.type === 'code') {
          const isCopied = copiedCodeIdx === sIdx;
          return (
            <div
              key={sIdx}
              className="my-3 rounded-xl border border-zinc-800/80 bg-zinc-950 overflow-hidden text-xs shadow-xs"
            >
              <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-900/70 border-b border-zinc-800/60 text-zinc-400 select-none">
                <span className="font-mono text-[11px] text-zinc-400">{seg.language || 'code'}</span>
                <button
                  type="button"
                  onClick={() => handleCopyCode(seg.content, sIdx)}
                  className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
                >
                  {isCopied ? (
                    <>
                      <Check size={12} className="text-emerald-400" />
                      <span className="text-emerald-400">已复制</span>
                    </>
                  ) : (
                    <>
                      <Copy size={12} />
                      <span>复制</span>
                    </>
                  )}
                </button>
              </div>
              <pre className="p-3 overflow-x-auto font-mono text-[12px] leading-normal text-zinc-200">
                <code>{seg.content}</code>
              </pre>
            </div>
          );
        }

        // Render prose paragraphs and LaTeX formulas
        const paragraphs = seg.content.split('\n\n');
        return (
          <div key={sIdx} className="space-y-2.5">
            {paragraphs.map((p, pIdx) => {
              const trimmed = p.trim();
              if (!trimmed) return null;

              // Display math ($$...$$ or raw LaTeX equation blocks)
              if (
                trimmed.startsWith('$$') && trimmed.endsWith('$$')
              ) {
                const mathContent = trimmed.slice(2, -2).trim();
                return (
                  <div
                    key={pIdx}
                    className="my-3 p-3 bg-zinc-950/90 rounded-xl border border-zinc-800/80 text-zinc-100 flex justify-center overflow-x-auto"
                  >
                    <MathView math={mathContent} displayMode={true} />
                  </div>
                );
              }

              if (
                (trimmed.includes('\\mathcal') || trimmed.includes('\\mathbb') || trimmed.includes('\\sum') || trimmed.includes('\\frac')) &&
                !trimmed.includes(' ')
              ) {
                return (
                  <div
                    key={pIdx}
                    className="my-3 p-3 bg-zinc-950/90 rounded-xl border border-zinc-800/80 text-zinc-100 flex justify-center overflow-x-auto"
                  >
                    <MathView math={trimmed} displayMode={true} />
                  </div>
                );
              }

              // Headings
              if (trimmed.startsWith('### ')) {
                return (
                  <h4 key={pIdx} className="text-[14px] font-semibold text-zinc-100 mt-3 mb-1">
                    {trimmed.replace(/^### /, '')}
                  </h4>
                );
              }

              if (trimmed.startsWith('## ')) {
                return (
                  <h3 key={pIdx} className="text-[15px] font-semibold text-zinc-100 mt-3.5 mb-1.5">
                    {trimmed.replace(/^## /, '')}
                  </h3>
                );
              }

              // Lists (numbered or bullet)
              const lines = trimmed.split('\n');
              const isList = lines.every((line) => /^\s*(\d+\.|\*|-)\s+/.test(line));

              if (isList) {
                return (
                  <div key={pIdx} className="space-y-1.5 my-1.5 pl-1">
                    {lines.map((line, lIdx) => {
                      const listMatch = line.match(/^\s*(\d+\.|\*|-)\s+(.*)$/);
                      if (!listMatch) return <p key={lIdx}>{line}</p>;
                      const prefix = listMatch[1];
                      const itemText = listMatch[2];

                      return (
                        <div key={lIdx} className="flex items-start gap-2">
                          <span className="font-mono text-zinc-400 select-none text-[12px] shrink-0 mt-0.5">
                            {prefix}
                          </span>
                          <div className="flex-1 leading-relaxed">
                            {renderInlineFormatting(itemText)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              }

              // Standard paragraph with inline formatting
              return (
                <p key={pIdx} className="leading-relaxed">
                  {renderInlineFormatting(trimmed)}
                </p>
              );
            })}
          </div>
        );
      })}

      {isStreaming && (
        <span className="inline-block w-1.5 h-4 bg-zinc-300 animate-pulse ml-0.5 align-middle rounded-xs" />
      )}
    </div>
  );
};

// Inline helper for bold, inline code, and inline math
function renderInlineFormatting(text: string): React.ReactNode {
  // Check for inline math `$math$`
  const parts = text.split(/(\$[^\$]+\$|`[^`]+`|\*\*[^\*]+\*\*)/g);

  return parts.map((part, idx) => {
    if (part.startsWith('$') && part.endsWith('$') && part.length > 2) {
      const math = part.slice(1, -1);
      return <MathView key={idx} math={math} inline={true} className="mx-0.5 text-zinc-100" />;
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      const code = part.slice(1, -1);
      return (
        <code
          key={idx}
          className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-200 font-mono text-[11px] border border-zinc-700/60 mx-0.5"
        >
          {code}
        </code>
      );
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      const boldText = part.slice(2, -2);
      return (
        <strong key={idx} className="font-semibold text-zinc-100">
          {boldText}
        </strong>
      );
    }
    return part;
  });
}

export const AgentChat: React.FC<AgentChatProps> = ({
  messages,
  onSendMessage,
  isProcessing,
  onOpenWorkspaceTab,
  settings,
  onSwitchModel,
  onClose,
  currentWidth,
  onSetWidth,
  onResetWidth,
  onOpenSettings
}) => {
  const [inputText, setInputText] = useState('');
  const [webSearchEnabled, setWebSearchEnabled] = useState(true);
  const [thinkingEnabled, setThinkingEnabled] = useState(settings.enableThinking);
  const [expandedToolIds, setExpandedToolIds] = useState<Record<string, boolean>>({});
  const [expandedThoughtIds, setExpandedThoughtIds] = useState<Record<string, boolean>>({});
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll on new messages or streaming ticks
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isProcessing]);

  // Close model menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setIsModelMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggleToolExpand = (id: string) => {
    setExpandedToolIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleThoughtExpand = (id: string) => {
    setExpandedThoughtIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!inputText.trim() || isProcessing) return;
    onSendMessage(inputText.trim());
    setInputText('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleCopyMessage = async (msgId: string, text: string) => {
    const success = await copyToClipboard(text);
    if (success) {
      setCopiedMsgId(msgId);
      setTimeout(() => setCopiedMsgId(null), 1800);
    }
  };

  const getToolIcon = (toolName: string) => {
    const lower = toolName.toLowerCase();
    if (lower === 'edit' || lower.includes('edit') || lower.includes('write')) return <FileText size={13} className="text-amber-400" />;
    if (lower === 'read' || lower.includes('read') || lower.includes('paper') || lower.includes('doc')) return <BookOpen size={13} className="text-sky-400" />;
    if (lower === 'search' || lower.includes('search') || lower.includes('grep')) return <Sparkles size={13} className="text-violet-400" />;
    if (lower === 'compile' || lower.includes('compile') || lower.includes('latex')) return <FileText size={13} className="text-emerald-400" />;
    if (lower === 'bash' || lower.includes('bash') || lower.includes('exec') || lower.includes('terminal')) return <Terminal size={13} className="text-zinc-300" />;
    if (lower === 'git' || lower.includes('git')) return <Terminal size={13} className="text-orange-400" />;
    if (lower === 'graph' || lower.includes('graph')) return <Share2 size={13} className="text-cyan-400" />;
    if (lower === 'plot' || lower.includes('plot')) return <BarChart3 size={13} className="text-emerald-400" />;
    return <Bot size={13} className="text-purple-400" />;
  };

  const getTabLabel = (tab: WorkspaceTab) => {
    switch (tab) {
      case 'latex':
        return 'LaTeX 论文';
      case 'paper':
        return '文献阅读器';
      case 'graph':
        return '知识图谱';
      case 'plot':
        return '图表画板';
      case 'terminal':
        return '运行终端';
      case 'literature':
        return '文献中心';
      case 'file':
        return '文件树';
      default:
        return '工作区';
    }
  };

  // Convert message into chronological blocks: Thought -> Tools -> Text
  const getMessageBlocks = (msg: ChatMessage): MessageBlock[] => {
    if (msg.blocks && msg.blocks.length > 0) {
      return msg.blocks;
    }

    const blocks: MessageBlock[] = [];

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      msg.toolCalls.forEach((tc, idx) => {
        blocks.push({
          id: tc.id || `tc-${msg.id}-${idx}`,
          type: 'tool_call',
          toolCall: tc
        });
      });
    }

    if (msg.text && msg.text.trim()) {
      blocks.push({
        id: `txt-${msg.id}`,
        type: 'text',
        content: msg.text
      });
    }

    return blocks;
  };

  const getToolSummaryPreview = (tc: AgentToolCall) => {
    if (tc.input) {
      if (tc.input.path) return `path: "${tc.input.path}"`;
      if (tc.input.file) return `file: "${tc.input.file}"`;
      if (tc.input.command) return `command: "${tc.input.command}"`;
      if (tc.input.query) return `query: "${tc.input.query}"`;
      if (tc.input.target) return `target: "${tc.input.target}"`;
      if (tc.input.script) return `script: "${tc.input.script}"`;
      if (tc.input.concept) return `concept: "${tc.input.concept}"`;
      if (tc.input.message) return `message: "${tc.input.message}"`;
    }
    return null;
  };

  // Dynamically compute available models from custom providers configured by the user
  const userModels = (settings.customProviders || [])
    .filter((p) => p.enabled !== false && p.type !== 'embedding')
    .flatMap((p) =>
      (p.models || []).map((m) => ({
        id: m,
        name: m,
        badge: p.name,
        provider: p.name
      }))
    );

  const availableModelsList = userModels.length > 0
    ? userModels
    : (settings.modelId
        ? [{ id: settings.modelId, name: settings.modelId, badge: settings.provider || '自定义', provider: settings.provider }]
        : []);

  const activeModel = availableModelsList.find((m) => m.id === settings.modelId)
    || availableModelsList[0]
    || { id: '', name: '未配置模型服务商', badge: '点击配置', provider: '' };

  return (
    <section className="flex-1 bg-zinc-950 flex flex-col h-full overflow-hidden relative select-none text-zinc-200">
      {/* Top Header Bar (Claude Desktop / Codex App Header Contract) */}
      <div className="px-3.5 py-2.5 border-b border-zinc-800/80 bg-zinc-950/90 flex items-center justify-between text-xs shrink-0 z-10 backdrop-blur-sm">
        {/* Model Switcher Pill */}
        <div className="relative" ref={modelMenuRef}>
          <button
            type="button"
            onClick={() => setIsModelMenuOpen((v) => !v)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-200 hover:text-white transition-all cursor-pointer shadow-xs"
          >
            <Bot size={13} className="text-purple-400" />
            <span className="font-medium text-xs tracking-tight">{activeModel.name}</span>
            <ChevronDown size={12} className="text-zinc-500" />
          </button>

          {/* Model Switcher Dropdown */}
          <AnimatePresence>
            {isModelMenuOpen && (
              <motion.div
                initial={{ opacity: 0, y: 4, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 4, scale: 0.98 }}
                transition={{ duration: 0.12 }}
                className="absolute left-0 top-full mt-1.5 w-64 rounded-xl bg-zinc-900 border border-zinc-800 p-1.5 shadow-xl z-50 text-xs space-y-0.5"
              >
                <div className="px-2 py-1 text-[11px] font-medium text-zinc-400">选择推理模型</div>
                {availableModelsList.length === 0 ? (
                  <div className="px-2 py-3 text-center space-y-1.5">
                    <p className="text-[11px] text-zinc-400">暂未添加模型服务商</p>
                    <button
                      type="button"
                      onClick={() => {
                        setIsModelMenuOpen(false);
                        onOpenSettings?.('providers');
                      }}
                      className="px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 text-purple-300 rounded text-[11px] font-medium transition-colors cursor-pointer"
                    >
                      前往配置服务商
                    </button>
                  </div>
                ) : (
                  availableModelsList.map((model) => (
                    <button
                      key={`${model.provider}-${model.id}`}
                      type="button"
                      onClick={() => {
                        onSwitchModel?.(model.id, model.provider);
                        setIsModelMenuOpen(false);
                      }}
                      className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-left transition-colors cursor-pointer ${
                        model.id === activeModel.id
                          ? 'bg-zinc-800 text-white font-medium'
                          : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60'
                      }`}
                    >
                      <div className="flex flex-col min-w-0 pr-2">
                        <span className="text-xs truncate">{model.name}</span>
                        <span className="text-[10px] text-zinc-500 truncate">{model.badge}</span>
                      </div>
                      {model.id === activeModel.id && (
                        <Check size={13} className="text-purple-400 shrink-0" />
                      )}
                    </button>
                  ))
                )}
                <div className="pt-1 mt-1 border-t border-zinc-800">
                  <button
                    type="button"
                    onClick={() => {
                      setIsModelMenuOpen(false);
                      onOpenSettings?.('providers');
                    }}
                    className="w-full flex items-center gap-1.5 px-2 py-1 text-[11px] text-zinc-400 hover:text-zinc-200 rounded hover:bg-zinc-800/60 transition-colors cursor-pointer"
                  >
                    <Sliders size={11} />
                    <span>设置模型与服务 (⌘,)</span>
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Right Header Action Icons */}
        <div className="flex items-center gap-1.5 text-zinc-400">
          <span className="text-[11px] text-zinc-500 font-mono px-1.5">
            {messages.length} 条消息
          </span>

          {onResetWidth && (
            <button
              type="button"
              onClick={onResetWidth}
              title="重置面板宽度"
              className="p-1 rounded-md hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
            >
              <Minimize2 size={13} />
            </button>
          )}

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              title="关闭对话栏"
              className="p-1 rounded-md hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      {/* Message List Stream (Claude Desktop & Codex Conversation Stream) */}
      <div className="flex-1 overflow-y-auto px-4 py-5 space-y-6 bg-zinc-950/40">
        {messages.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 space-y-4 my-auto">
            <div className="w-12 h-12 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-purple-400 shadow-sm">
              <Sparkles size={22} />
            </div>
            <div className="space-y-1">
              <h3 className="text-sm font-semibold text-zinc-200">Codex Research Studio</h3>
              <p className="text-xs text-zinc-500 max-w-xs leading-relaxed">
                支持深度推导演进、实时工具联动与 LaTeX / 知识图谱无缝协同。
              </p>
            </div>
            <div className="grid grid-cols-1 gap-2 w-full max-w-sm pt-2">
              {[
                '协助推导数学模型并整理为 LaTeX 格式',
                '检索相关领域的最新学术预印本与综述',
                '分析实验代码的可复现性与参数设置'
              ].map((prompt, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => onSendMessage(prompt)}
                  className="px-3 py-2 text-left rounded-xl bg-zinc-900/80 border border-zinc-800/80 hover:border-zinc-700 text-xs text-zinc-300 hover:text-white transition-all cursor-pointer shadow-xs"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, msgIndex) => {
          const isLatest = msgIndex === messages.length - 1;
          const isUser = msg.sender === 'user';

          if (isUser) {
            return (
              <div key={msg.id} className="flex flex-col items-end w-full group">
                <div className="max-w-[85%] rounded-2xl rounded-br-sm px-4 py-3 text-[13px] bg-zinc-800/90 text-zinc-100 border border-zinc-700/60 shadow-sm leading-relaxed select-text break-words">
                  <div className="whitespace-pre-wrap font-sans break-words">{msg.text}</div>
                </div>
                <span className="text-[10px] text-zinc-600 mt-1 px-1 font-mono">{msg.timestamp}</span>
              </div>
            );
          }

          // Assistant message: Sequential stream flow (Thought -> Tool Calls -> Final Answer)
          const blocks = getMessageBlocks(msg);
          const isCopied = copiedMsgId === msg.id;

          return (
            <div key={msg.id} className="flex flex-col items-start w-full group">
              <div className="w-full space-y-3.5">
                {/* Assistant Message Header */}
                <div className="flex items-center justify-between text-[11px] pb-1 text-zinc-400 select-none">
                  <div className="flex items-center gap-1.5">
                    <Bot size={13} className="text-purple-400" />
                  </div>

                  <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      type="button"
                      onClick={() => handleCopyMessage(msg.id, msg.text)}
                      title="复制回答"
                      className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900 transition-colors cursor-pointer"
                    >
                      {isCopied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                    </button>
                    <span className="text-[10px] text-zinc-600 font-mono">{msg.timestamp}</span>
                  </div>
                </div>

                {/* Blocks rendered in exact chronological order */}
                <div className="space-y-3">
                  {blocks.map((block, bIdx) => {
                    // 1. Thinking Process Block (Claude Desktop exact pattern)
                    if (block.type === 'thought') {
                      const isStreaming = block.isStreaming;
                      // Auto-expanded while streaming, toggleable when finished
                      const isExpanded = expandedThoughtIds[block.id] !== undefined
                        ? expandedThoughtIds[block.id]
                        : isStreaming;

                      const durationSec = block.durationSeconds || 0;
                      const durationDisplay = durationSec > 0 ? `${durationSec.toFixed(1)}s` : '';

                      return (
                        <div
                          key={block.id || `thought-${bIdx}`}
                          className="rounded-xl border border-zinc-800/80 bg-zinc-900/30 overflow-hidden transition-all text-xs"
                        >
                          {/* Claude Desktop Style Thought Summary Bar */}
                          <button
                            type="button"
                            onClick={() => toggleThoughtExpand(block.id)}
                            className="w-full px-3 py-2 flex items-center justify-between text-zinc-400 hover:text-zinc-200 cursor-pointer select-none transition-colors"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              {isStreaming ? (
                                <Loader2 size={13} className="text-purple-400 animate-spin shrink-0" />
                              ) : (
                                <BrainCircuit size={13} className="text-purple-400 shrink-0" />
                              )}
                              <span className="font-medium text-xs text-zinc-300 truncate">
                                {isStreaming
                                  ? `Thinking... (${durationDisplay || '0.1s'})`
                                  : `Thought for ${durationDisplay || '2.4s'}`}
                              </span>
                            </div>

                            <div className="flex items-center gap-1.5 text-zinc-500 shrink-0">
                              {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                            </div>
                          </button>

                          {/* Collapsible Thought Content */}
                          <AnimatePresence initial={false}>
                            {isExpanded && (
                              <motion.div
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: 'auto' }}
                                exit={{ opacity: 0, height: 0 }}
                                transition={{ duration: 0.16, ease: 'easeOut' }}
                                className="overflow-hidden"
                              >
                                <div className="px-3.5 py-2.5 border-t border-zinc-800/60 bg-zinc-950/60 text-[12px] text-zinc-400 font-sans leading-relaxed whitespace-pre-wrap select-text">
                                  {block.content}
                                  {isStreaming && (
                                    <span className="inline-block w-1.5 h-3.5 bg-purple-400 animate-pulse ml-0.5 align-middle rounded-xs" />
                                  )}
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      );
                    }

                    // 2. Tool Execution Block (Codex / Claude Desktop style)
                    if (block.type === 'tool_call') {
                      const tc = block.toolCall;
                      const isExpanded = !!expandedToolIds[tc.id];
                      const summary = getToolSummaryPreview(tc);

                      return (
                        <div
                          key={tc.id || `tool-${bIdx}`}
                          className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 overflow-hidden transition-all text-xs"
                        >
                          {/* Tool Status Row */}
                          <div
                            onClick={() => toggleToolExpand(tc.id)}
                            className="px-3 py-2 flex items-center justify-between cursor-pointer hover:bg-zinc-900/80 select-none transition-colors"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              {getToolIcon(tc.name)}
                              <span className="font-mono text-xs text-zinc-200 tracking-tight">
                                {tc.status === 'running' ? `Running ${tc.name}...` : `Ran ${tc.name}`}
                              </span>
                              {summary && !isExpanded && (
                                <span className="text-zinc-500 font-mono text-[11px] truncate max-w-[200px]">
                                  ({summary})
                                </span>
                              )}
                            </div>

                            <div className="flex items-center gap-2 shrink-0">
                              {tc.status === 'completed' && (
                                <span className="flex items-center gap-1 text-emerald-400 text-[11px] font-mono">
                                  <CheckCircle2 size={13} />
                                  <span>{tc.durationMs || 320}ms</span>
                                </span>
                              )}
                              {tc.status === 'running' && (
                                <span className="flex items-center gap-1 text-sky-400 text-[11px] font-mono">
                                  <Loader2 size={12} className="animate-spin" />
                                  <span>running</span>
                                </span>
                              )}
                              {tc.status === 'failed' && (
                                <span className="flex items-center gap-1 text-rose-400 text-[11px]">
                                  <AlertCircle size={13} />
                                  <span>失败</span>
                                </span>
                              )}
                              <button type="button" className="text-zinc-500 hover:text-zinc-300">
                                {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                              </button>
                            </div>
                          </div>

                          {/* Collapsible Inspection Details */}
                          <AnimatePresence>
                            {isExpanded && (
                              <motion.div
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: 'auto' }}
                                exit={{ opacity: 0, height: 0 }}
                                transition={{ duration: 0.15, ease: 'easeOut' }}
                                className="overflow-hidden"
                              >
                                <div className="p-3 bg-zinc-950 border-t border-zinc-800/80 font-mono text-[11px] space-y-2.5">
                                  <div className="flex items-center justify-between text-zinc-400 font-sans text-xs pb-1 border-b border-zinc-900">
                                    <span className="font-mono text-zinc-300">Tool: {tc.name}</span>
                                    <span className="text-[10px] text-zinc-500 font-mono">{tc.durationMs ? `${tc.durationMs}ms` : 'completed'}</span>
                                  </div>
                                  <div>
                                    <span className="text-zinc-500 block font-sans text-xs mb-1">输入参数 (Input):</span>
                                    <pre className="text-zinc-300 overflow-x-auto p-2 bg-zinc-900 rounded-lg border border-zinc-800">
                                      {JSON.stringify(tc.input, null, 2)}
                                    </pre>
                                  </div>
                                  {tc.output && (
                                    <div>
                                      <span className="text-zinc-500 block font-sans text-xs mb-1">输出结果 (Output):</span>
                                      <pre className="text-emerald-400 overflow-x-auto p-2 bg-zinc-900 rounded-lg border border-zinc-800">
                                        {JSON.stringify(tc.output, null, 2)}
                                      </pre>
                                    </div>
                                  )}

                                  {tc.targetWorkspaceTab && (
                                    <button
                                      type="button"
                                      onClick={() => onOpenWorkspaceTab(tc.targetWorkspaceTab!)}
                                      className="w-full py-1.5 mt-1 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 border border-zinc-700/80 rounded-lg font-sans text-xs flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                                    >
                                      <span>前往对应视窗 ({getTabLabel(tc.targetWorkspaceTab)})</span>
                                      <ArrowRight size={12} />
                                    </button>
                                  )}
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      );
                    }

                    // 3. Final Synthesized Text Block (Rendered Markdown & KaTeX)
                    if (block.type === 'text') {
                      return (
                        <div key={block.id || `text-${bIdx}`} className="pt-0.5">
                          <FormattedMessageText
                            content={block.content}
                            isStreaming={block.isStreaming && isProcessing && isLatest}
                          />
                        </div>
                      );
                    }

                    return null;
                  })}
                </div>
              </div>
            </div>
          );
        })}

        {/* Global Loading Spinner if processing but no blocks yet */}
        {isProcessing && (!messages.length || messages[messages.length - 1].sender === 'user') && (
          <div className="flex items-center gap-2 text-xs text-zinc-400 bg-zinc-900 border border-zinc-800 px-3.5 py-2 rounded-xl shadow-xs w-fit">
            <Loader2 size={13} className="animate-spin text-purple-400" />
            <span>正在分析并启动推理...</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Bottom Input Dock (Claude Desktop / Codex App Style) */}
      <div className="p-3 bg-zinc-950 shrink-0 border-t border-zinc-800/80">
        <form
          onSubmit={handleSubmit}
          className="bg-zinc-900/90 border border-zinc-800 focus-within:border-zinc-700 rounded-2xl p-3 transition-all shadow-md space-y-2.5"
        >
          {/* Text Input Area */}
          <textarea
            ref={textareaRef}
            rows={2}
            value={inputText}
            onChange={(e) => {
              setInputText(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`;
            }}
            onKeyDown={handleKeyDown}
            placeholder="输入指令或提问 (Enter 发送，Shift+Enter 换行)..."
            disabled={isProcessing}
            className="w-full bg-transparent text-[13px] text-zinc-100 placeholder-zinc-500 focus:outline-none resize-none font-sans leading-relaxed"
          />

          {/* Bottom Bar in Input Box */}
          <div className="flex items-center justify-between pt-1 border-t border-zinc-800/60">
            {/* Left Controls: Thinking & Web Search Toggles */}
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setThinkingEnabled(!thinkingEnabled)}
                title={thinkingEnabled ? '深度思考：已开启' : '深度思考：已关闭'}
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors cursor-pointer ${
                  thinkingEnabled
                    ? 'text-purple-300 bg-purple-950/70 border border-purple-800/70 font-medium'
                    : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'
                }`}
              >
                <BrainCircuit size={13} />
                <span>思考</span>
              </button>

              <button
                type="button"
                onClick={() => setWebSearchEnabled(!webSearchEnabled)}
                title={webSearchEnabled ? '联网检索：已开启' : '联网检索：已关闭'}
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors cursor-pointer ${
                  webSearchEnabled
                    ? 'text-sky-300 bg-sky-950/70 border border-sky-800/70 font-medium'
                    : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'
                }`}
              >
                <Globe size={13} />
                <span>联网</span>
              </button>

              <button
                type="button"
                title="添加附件"
                className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors cursor-pointer"
              >
                <Paperclip size={13} />
              </button>
            </div>

            {/* Right Control: Submit Button */}
            <button
              type="submit"
              disabled={!inputText.trim() || isProcessing}
              className="p-1.5 bg-zinc-100 hover:bg-white disabled:opacity-40 text-zinc-950 font-medium rounded-lg transition-all flex items-center justify-center shadow-xs cursor-pointer"
            >
              <Send size={13} />
            </button>
          </div>
        </form>
      </div>
    </section>
  );
};
