import React, { useState, useEffect } from 'react';
import { ResearchPaper, RagWikiEntry, VirtualFile, WorkspaceTab, AgentSkill, ManagementTab } from '../types/research';
import {
  Search,
  BookOpen,
  FileText,
  Share2,
  Terminal,
  Sparkles
} from 'lucide-react';

interface SearchPaletteModalProps {
  isOpen: boolean;
  onClose: () => void;
  papers: ResearchPaper[];
  wikiEntries: RagWikiEntry[];
  files: VirtualFile[];
  skills?: AgentSkill[];
  onSelectPaper: (p: ResearchPaper) => void;
  onSelectWiki: (w: RagWikiEntry) => void;
  onSelectFile: (f: VirtualFile) => void;
  onOpenWorkspaceTab: (tab: WorkspaceTab) => void;
  onOpenManagementPanel?: (tab: ManagementTab) => void;
}

export const SearchPaletteModal: React.FC<SearchPaletteModalProps> = ({
  isOpen,
  onClose,
  papers,
  wikiEntries,
  files,
  skills = [],
  onSelectPaper,
  onSelectWiki,
  onSelectFile,
  onOpenWorkspaceTab,
  onOpenManagementPanel
}) => {
  const [query, setQuery] = useState('');

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
      } else if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  if (!isOpen) return null;

  const filteredPapers = papers.filter((p) => p.title.toLowerCase().includes(query.toLowerCase()) || p.arxivId.includes(query));
  const filteredWiki = wikiEntries.filter((w) => w.title.toLowerCase().includes(query.toLowerCase()));
  const filteredFiles = files.filter((f) => f.name.toLowerCase().includes(query.toLowerCase()));
  const filteredSkills = skills.filter(
    (s) =>
      s.name.toLowerCase().includes(query.toLowerCase()) ||
      s.description.toLowerCase().includes(query.toLowerCase()) ||
      s.triggers.some((t) => t.toLowerCase().includes(query.toLowerCase()))
  );

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start justify-center pt-20 p-4 select-none"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[540px] bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-100 flex flex-col max-h-[70vh] text-zinc-100"
      >
        {/* Search input line */}
        <div className="p-3.5 border-b border-zinc-800 flex items-center gap-2.5 bg-zinc-900 shrink-0">
          <Search size={15} className="text-zinc-500" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索文献、文件或功能..."
            className="flex-1 bg-transparent text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none"
            autoFocus
          />
          <kbd className="text-[10px] bg-zinc-800 border border-zinc-700 px-1.5 py-0.5 rounded text-zinc-400 font-mono shadow-xs">ESC</kbd>
        </div>

        {/* Results Stream */}
        <div className="flex-1 overflow-y-auto p-3 space-y-3 text-xs bg-zinc-900">
          {/* Quick Actions */}
          <div className="space-y-1">
            <span className="text-[10px] uppercase font-mono text-zinc-500 px-2 block font-medium">快捷导航</span>
            <div className="grid grid-cols-3 gap-1.5">
              <button
                onClick={() => {
                  onOpenWorkspaceTab('latex');
                  onClose();
                }}
                className="flex items-center gap-2 p-2 rounded-xl hover:bg-zinc-800 text-zinc-300 hover:text-white text-left transition-colors border border-transparent hover:border-zinc-700"
              >
                <FileText size={13} className="text-amber-400 shrink-0" />
                <span className="truncate">LaTeX</span>
              </button>
              <button
                onClick={() => {
                  onOpenWorkspaceTab('graph');
                  onClose();
                }}
                className="flex items-center gap-2 p-2 rounded-xl hover:bg-zinc-800 text-zinc-300 hover:text-white text-left transition-colors border border-transparent hover:border-zinc-700"
              >
                <Share2 size={13} className="text-sky-400 shrink-0" />
                <span className="truncate">图谱</span>
              </button>
              <button
                onClick={() => {
                  onOpenWorkspaceTab('terminal');
                  onClose();
                }}
                className="flex items-center gap-2 p-2 rounded-xl hover:bg-zinc-800 text-zinc-300 hover:text-white text-left transition-colors border border-transparent hover:border-zinc-700"
              >
                <Terminal size={13} className="text-emerald-400 shrink-0" />
                <span className="truncate">终端</span>
              </button>
            </div>
          </div>

          {/* Agent Skills */}
          {query && filteredSkills.length > 0 && (
            <div className="space-y-1 pt-2 border-t border-zinc-800">
              <span className="text-[10px] uppercase font-mono text-zinc-500 px-2 block font-medium">技能</span>
              {filteredSkills.map((s) => (
                <div
                  key={s.id}
                  onClick={() => {
                    onOpenManagementPanel?.('skills');
                    onClose();
                  }}
                  className="flex items-center justify-between p-2 rounded-xl hover:bg-zinc-800 cursor-pointer text-zinc-200 transition-colors"
                >
                  <div className="flex items-center gap-2 truncate">
                    <Sparkles size={13} className="text-purple-400 shrink-0" />
                    <span className="truncate font-medium">{s.name}</span>
                    <span className="text-[10px] text-zinc-500 font-mono">({s.version})</span>
                  </div>
                  <span className="text-[10px] text-purple-400 bg-purple-950/60 px-1.5 py-0.5 rounded border border-purple-800/60 shrink-0">
                    {s.enabled ? '已启用' : '已停用'}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Papers */}
          {filteredPapers.length > 0 && (
            <div className="space-y-1 pt-2 border-t border-zinc-800">
              <span className="text-[10px] uppercase font-mono text-zinc-500 px-2 block font-medium">文献</span>
              {filteredPapers.map((p) => (
                <div
                  key={p.id}
                  onClick={() => {
                    onSelectPaper(p);
                    onOpenWorkspaceTab('paper');
                    onClose();
                  }}
                  className="flex items-center justify-between p-2 rounded-xl hover:bg-zinc-800 cursor-pointer text-zinc-200 transition-colors"
                >
                  <div className="flex items-center gap-2 truncate">
                    <BookOpen size={13} className="text-sky-400 shrink-0" />
                    <span className="truncate font-medium">{p.title}</span>
                  </div>
                  <span className="text-[10px] font-mono text-zinc-500 shrink-0">arXiv:{p.arxivId}</span>
                </div>
              ))}
            </div>
          )}

          {/* Wiki Entries */}
          {filteredWiki.length > 0 && (
            <div className="space-y-1 pt-2 border-t border-zinc-800">
              <span className="text-[10px] uppercase font-mono text-zinc-500 px-2 block font-medium">Wiki</span>
              {filteredWiki.map((w) => (
                <div
                  key={w.id}
                  onClick={() => {
                    onSelectWiki(w);
                    onClose();
                  }}
                  className="flex items-center justify-between p-2 rounded-xl hover:bg-zinc-800 cursor-pointer text-zinc-200 transition-colors"
                >
                  <span className="truncate font-medium">{w.title}</span>
                  <span className="text-[10px] text-amber-400 font-mono shrink-0">{w.category}</span>
                </div>
              ))}
            </div>
          )}

          {/* Files */}
          {filteredFiles.length > 0 && (
            <div className="space-y-1 pt-2 border-t border-zinc-800">
              <span className="text-[10px] uppercase font-mono text-zinc-500 px-2 block font-medium">文件</span>
              {filteredFiles.map((f) => (
                <div
                  key={f.path}
                  onClick={() => {
                    onSelectFile(f);
                    onOpenWorkspaceTab('file');
                    onClose();
                  }}
                  className="flex items-center justify-between p-2 rounded-xl hover:bg-zinc-800 cursor-pointer text-zinc-200 transition-colors"
                >
                  <span className="font-mono text-zinc-300">{f.path}</span>
                  <span className="text-[10px] text-zinc-500 uppercase font-mono">{f.type}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
