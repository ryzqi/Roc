import React, { useState } from 'react';
import { GitCommit } from '../types/research';
import {
  X,
  GitBranch,
  GitCommit as GitCommitIcon,
  FolderGit2,
  CheckCircle2,
  Plus,
  Clock,
  FileCode,
  FileText
} from 'lucide-react';

interface SystemDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  gitCommits: GitCommit[];
  onCommitGit: (message: string) => void;
}

export const SystemDrawer: React.FC<SystemDrawerProps> = ({
  isOpen,
  onClose,
  gitCommits,
  onCommitGit
}) => {
  const [commitMessage, setCommitMessage] = useState('');
  const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleCommitSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!commitMessage.trim()) return;
    onCommitGit(commitMessage.trim());
    setCommitMessage('');
  };

  const selectedCommit = gitCommits.find((c) => c.hash === selectedCommitHash) || gitCommits[0];

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex justify-end select-none"
    >
      {/* Drawer Container */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-zinc-900 h-full shadow-2xl border-l border-zinc-800 flex flex-col animate-in slide-in-from-right duration-200 text-zinc-100"
      >
        {/* Header */}
        <div className="h-12 border-b border-zinc-800 px-4 flex items-center justify-between shrink-0 bg-zinc-900">
          <div className="flex items-center gap-2">
            <GitBranch size={16} className="text-emerald-400" />
            <h2 className="text-xs font-semibold text-zinc-100">Git</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
            title="关闭"
          >
            <X size={16} />
          </button>
        </div>

        {/* Current Branch Status */}
        <div className="px-4 py-2.5 bg-zinc-950 border-b border-zinc-850 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FolderGit2 size={14} className="text-emerald-400" />
            <span className="text-xs font-mono font-medium text-zinc-200">main</span>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            <span className="text-[11px] text-zinc-400">干净</span>
          </div>
          <span className="text-[11px] text-zinc-500 font-mono">{gitCommits.length} 次提交</span>
        </div>

        {/* Create Snapshot Form */}
        <div className="p-3.5 border-b border-zinc-800 bg-zinc-900">
          <form onSubmit={handleCommitSubmit} className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-zinc-300 flex items-center gap-1.5">
                <Plus size={12} className="text-sky-400" />
                <span>新提交</span>
              </label>
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="说明 (如: 完成实验)..."
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                className="flex-1 bg-zinc-950 border border-zinc-800 focus:border-zinc-700 rounded-lg px-2.5 py-1 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none transition-colors"
              />
              <button
                type="submit"
                disabled={!commitMessage.trim()}
                className="px-3 py-1 bg-zinc-100 hover:bg-white disabled:bg-zinc-700 text-zinc-950 rounded-lg text-xs font-semibold transition-colors shadow-xs shrink-0 flex items-center gap-1"
              >
                <GitCommitIcon size={12} />
                <span>Commit</span>
              </button>
            </div>
          </form>
        </div>

        {/* Commit History Timeline */}
        <div className="flex-1 overflow-y-auto p-3.5 space-y-2.5 select-text">
          <div className="flex items-center justify-between text-xs text-zinc-400 font-medium px-1">
            <span>历史</span>
          </div>

          <div className="space-y-2">
            {gitCommits.map((commit, idx) => {
              const isSelected = selectedCommit?.hash === commit.hash;
              return (
                <div
                  key={commit.hash}
                  onClick={() => setSelectedCommitHash(commit.hash)}
                  className={`p-3 rounded-xl border text-left cursor-pointer transition-all ${
                    isSelected
                      ? 'bg-zinc-850 border-zinc-700 shadow-xs'
                      : 'bg-zinc-950/80 border-zinc-800/80 hover:border-zinc-700'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <div className="flex items-center gap-1.5">
                      <span className="px-1.5 py-0.5 bg-zinc-900 border border-zinc-800 rounded text-[11px] font-mono font-medium text-zinc-300">
                        {commit.hash}
                      </span>
                      {idx === 0 && (
                        <span className="text-[10px] text-emerald-400 bg-emerald-950/60 border border-emerald-800/60 px-1.5 py-0.2 rounded font-medium">
                          HEAD
                        </span>
                      )}
                    </div>
                    <span className="text-[11px] text-zinc-500 flex items-center gap-1">
                      <Clock size={11} />
                      {commit.date}
                    </span>
                  </div>

                  <p className="text-xs font-medium text-zinc-200 mb-1 leading-snug">
                    {commit.message}
                  </p>

                  <div className="flex items-center justify-between text-[11px] text-zinc-500">
                    <span>{commit.author}</span>
                    <span className="font-mono">
                      {commit.changedFiles} 个文件变更
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Selected commit detail inspect */}
          {selectedCommit && (
            <div className="mt-3 p-3 bg-zinc-950 rounded-xl border border-zinc-800 text-xs text-zinc-300 space-y-1.5">
              <div className="flex items-center justify-between font-medium text-zinc-200">
                <span className="flex items-center gap-1.5">
                  <CheckCircle2 size={13} className="text-emerald-400" />
                  <span>快照详情: {selectedCommit.hash}</span>
                </span>
                <span className="text-[10px] text-zinc-500 font-mono">{selectedCommit.author}</span>
              </div>
              <p className="text-zinc-400 text-xs">{selectedCommit.message}</p>
              <div className="pt-1.5 border-t border-zinc-850 flex items-center justify-between text-[11px] text-zinc-400">
                <span className="text-zinc-500 font-mono">变更文件: {selectedCommit.changedFiles || 1} 个</span>
                <span className="text-zinc-500 text-[10px]">{selectedCommit.date}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
