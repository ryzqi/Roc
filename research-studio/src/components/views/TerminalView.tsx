import React, { useState, useRef, useEffect } from 'react';
import {
  Terminal as TerminalIcon,
  Trash2
} from 'lucide-react';

interface TerminalViewProps {
  initialCommand?: string;
  onExecuteCommand?: (cmd: string) => void;
}

interface CommandLog {
  id: string;
  cmd: string;
  output: string;
  type: 'success' | 'error' | 'info';
  timestamp: string;
}

export const TerminalView: React.FC<TerminalViewProps> = ({
  initialCommand,
  onExecuteCommand
}) => {
  const [logs, setLogs] = useState<CommandLog[]>([]);

  const [inputCmd, setInputCmd] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  useEffect(() => {
    if (initialCommand) {
      runCommand(initialCommand);
    }
  }, [initialCommand]);

  const runCommand = (cmd: string) => {
    const trimmed = cmd.trim();
    if (!trimmed) return;

    let output = '';
    let type: CommandLog['type'] = 'success';

    if (trimmed === 'clear') {
      setLogs([]);
      setInputCmd('');
      return;
    } else if (trimmed === 'help') {
      output = `Research Virtual Terminal (macOS zsh)
Available Commands:
  ls                                列出当前工作区文件
  pwd                               显示当前工作路径
  git status                        查看 Git 工作区状态
  git log                           查看提交历史记录
  pdflatex <file>                   编译 LaTeX 文档
  python <script>                   执行 Python 脚本
  arxiv search <query>              检索 arXiv 学术论文
  clear                             清屏`;
      type = 'info';
    } else if (trimmed === 'ls') {
      output = `(工作区为空或输入相应文件名操作)`;
    } else if (trimmed === 'pwd') {
      output = `/Users/researcher/ResearchWorkspace`;
    } else if (trimmed.startsWith('git status')) {
      output = `On branch main
nothing to commit, working tree clean`;
    } else if (trimmed.startsWith('git log')) {
      output = `commit 1a2b3c4 (HEAD -> main)
Author: AI Researcher <researcher@domain.ai>
Date:   Just now

    init: research workspace initialized`;
    } else if (trimmed.startsWith('pdflatex')) {
      const targetFile = trimmed.replace('pdflatex', '').trim() || 'paper.tex';
      output = `[LaTeX Engine] Compiling ${targetFile}...
LaTeX2e <2023-11-01> patch level 1
Output written on ${targetFile.replace(/\.tex$/, '')}.pdf (1 page).
Status: SUCCESS (0 errors, 0 warnings)`;
    } else if (trimmed.startsWith('python')) {
      output = `[Python Runtime] Script executed successfully.`;
    } else if (trimmed.startsWith('arxiv search')) {
      const q = trimmed.replace('arxiv search', '').trim();
      if (!q) {
        output = `用法: arxiv search <关键词或主题>`;
        type = 'error';
      } else {
        output = `[arXiv API Query] Searching preprints for: "${q}"
Found 0 matching results. Please specify academic keywords.`;
        type = 'info';
      }
    } else {
      output = `zsh: command not found: ${trimmed}
输入 'help' 获取所有支持的指令列表。`;
      type = 'error';
    }

    const now = new Date();
    const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;

    setLogs((prev) => [
      ...prev,
      {
        id: `cmd-${Date.now()}`,
        cmd: trimmed,
        output,
        type,
        timestamp: timeStr
      }
    ]);

    setInputCmd('');
    if (onExecuteCommand) {
      onExecuteCommand(trimmed);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      runCommand(inputCmd);
    }
  };

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100 select-none overflow-hidden">
      {/* Top Bar */}
      <div className="h-11 border-b border-zinc-800 bg-zinc-950 px-3 flex items-center justify-between text-xs shrink-0">
        <div className="flex items-center gap-2">
          <TerminalIcon size={14} className="text-zinc-400" />
          <span className="font-semibold text-xs text-zinc-200">终端</span>
          <span className="text-[10px] text-zinc-500 font-mono">zsh · virtualenv</span>
        </div>

        <button
          onClick={() => setLogs([])}
          title="清空"
          className="p-1 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900 rounded-lg transition-colors cursor-pointer"
        >
          <Trash2 size={13} />
        </button>
      </div>

      {/* Terminal Canvas Window */}
      <div className="flex-1 p-3 sm:p-4 overflow-hidden flex flex-col min-w-0">
        <div className="flex-1 bg-zinc-950 text-zinc-200 rounded-xl border border-zinc-800/80 p-3 sm:p-4 overflow-y-auto space-y-3 font-mono leading-relaxed select-text shadow-inner">
          <div className="text-zinc-600 text-[10px] pb-1.5 border-b border-zinc-900 flex items-center justify-between">
            <span>Terminal (zsh)</span>
            <span>输入 help 查看指令</span>
          </div>

          {logs.map((log) => (
            <div key={log.id} className="space-y-1">
              <div className="flex flex-wrap items-center gap-1.5 text-zinc-400 text-xs">
                <span className="text-emerald-400 font-semibold">(research-env)</span>
                <span className="text-sky-400">researcher@mac</span>
                <span className="text-zinc-600">:</span>
                <span className="text-purple-400">~/Research</span>
                <span className="text-zinc-500">%</span>
                <span className="text-zinc-100 font-semibold">{log.cmd}</span>
              </div>

              <pre className="text-zinc-300 text-[11px] whitespace-pre-wrap pl-3 border-l border-zinc-800">
                {log.output}
              </pre>
            </div>
          ))}

          {/* Active Command Input Line */}
          <div className="flex flex-wrap items-center gap-1.5 pt-1 text-zinc-200">
            <span className="text-emerald-400 font-semibold text-xs">(research-env)</span>
            <span className="text-sky-400 text-xs">researcher@mac</span>
            <span className="text-zinc-600">:</span>
            <span className="text-purple-400 text-xs">~/Research</span>
            <span className="text-zinc-500">%</span>
            <input
              type="text"
              value={inputCmd}
              onChange={(e) => setInputCmd(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="输入指令..."
              className="flex-1 min-w-[120px] bg-transparent text-white focus:outline-none caret-sky-400 font-mono text-xs"
              autoFocus
            />
          </div>

          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
};
