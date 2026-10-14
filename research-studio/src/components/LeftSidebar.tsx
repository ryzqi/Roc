import React, { useState } from 'react';
import {
  ChatSession,
  VirtualFile,
  ResearchPaper,
  LiteratureSubView,
  ManagementTab
} from '../types/research';
import { FileTreeView } from './FileTreeView';
import {
  FolderTree,
  BookOpen,
  MessagesSquare,
  Plus,
  Search,
  Trash2,
  Edit3,
  Check,
  X,
  FileText,
  Sun,
  Moon,
  FolderGit2
} from 'lucide-react';

interface LeftSidebarProps {
  projectName?: string;
  onBackToProjects?: () => void;
  sessions: ChatSession[];
  activeSessionId: string;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onRenameSession: (id: string, newTitle: string) => void;
  onDeleteSession: (id: string) => void;
  // Files
  files: VirtualFile[];
  activeFilePath?: string;
  onSelectFile: (file: VirtualFile) => void;
  onCreateFile: (path: string, type: VirtualFile['type']) => void;
  onDeleteFile: (path: string) => void;
  onSaveFileContent?: (path: string, content: string) => void;
  onPreviewFile?: (file: VirtualFile) => void;
  // Literature Library
  papers: ResearchPaper[];
  activePaperId: string;
  onSelectPaper: (paper: ResearchPaper) => void;
  isLiteratureActive: boolean;
  onOpenLiteratureHub: (subView?: LiteratureSubView) => void;
  // Panel
  onOpenManagementPanel?: (tab: ManagementTab) => void;
  width?: number;
  theme?: 'light' | 'dark' | 'system';
  onToggleTheme?: () => void;
}

export const LeftSidebar: React.FC<LeftSidebarProps> = ({
  projectName,
  onBackToProjects,
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onRenameSession,
  onDeleteSession,
  files,
  activeFilePath,
  onSelectFile,
  onCreateFile,
  onDeleteFile,
  onSaveFileContent,
  onPreviewFile,
  papers,
  activePaperId,
  onSelectPaper,
  isLiteratureActive,
  onOpenLiteratureHub,
  width,
  theme = 'dark',
  onToggleTheme
}) => {
  // Sidebar view switcher: 'files' (default) | 'literature' | 'sessions'
  const [sidebarTab, setSidebarTab] = useState<'files' | 'literature' | 'sessions'>('files');

  // Session search & inline editing states
  const [sessionSearch, setSessionSearch] = useState('');
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');

  // Literature quick search inside sidebar
  const [paperSearch, setPaperSearch] = useState('');

  // Filtered sessions
  const filteredSessions = sessions.filter((s) =>
    s.title.toLowerCase().includes(sessionSearch.toLowerCase())
  );

  // Filtered papers
  const filteredPapers = papers.filter((p) =>
    p.title.toLowerCase().includes(paperSearch.toLowerCase()) ||
    p.arxivId.includes(paperSearch)
  );

  const handleStartRename = (session: ChatSession, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingSessionId(session.id);
    setEditTitle(session.title);
  };

  const handleSaveRename = (id: string) => {
    if (editTitle.trim()) {
      onRenameSession(id, editTitle.trim());
    }
    setEditingSessionId(null);
  };

  const handleKeyDownRename = (e: React.KeyboardEvent, id: string) => {
    if (e.key === 'Enter') {
      handleSaveRename(id);
    } else if (e.key === 'Escape') {
      setEditingSessionId(null);
    }
  };

  return (
    <aside
      style={width ? { width: `${width}px` } : undefined}
      className={`${width ? '' : 'w-72'} bg-zinc-950 border-r border-zinc-800/80 flex flex-col h-full select-none shrink-0 z-10 overflow-hidden text-zinc-300`}
    >
      {/* Current Project Quick Banner with Switch Link */}
      {projectName && (
        <div className="px-2.5 py-1.5 border-b border-zinc-800/80 bg-zinc-900/90 flex items-center justify-between text-xs gap-2 shrink-0">
          <div className="flex items-center gap-1.5 min-w-0 truncate text-zinc-300">
            <FolderGit2 size={12} className="text-zinc-500 shrink-0" />
            <span className="truncate font-medium text-[11px]" title={projectName}>
              {projectName}
            </span>
          </div>
          {onBackToProjects && (
            <button
              onClick={onBackToProjects}
              title="返回论文课题门户"
              className="text-[11px] text-zinc-400 hover:text-emerald-400 transition-colors shrink-0 px-1 py-0.5 rounded hover:bg-zinc-800/60"
            >
              切换课题
            </button>
          )}
        </div>
      )}

      {/* Top Segmented Navigation Tabs */}
      <div className="p-2 border-b border-zinc-800/80 bg-zinc-900/60 shrink-0">
        <div className="flex items-center gap-1 bg-zinc-950/90 p-0.5 rounded-lg text-xs border border-zinc-800/70">
          <button
            onClick={() => setSidebarTab('files')}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1 rounded-md font-medium transition-all ${
              sidebarTab === 'files'
                ? 'bg-zinc-800 text-zinc-100 shadow-xs font-semibold'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <FolderTree size={12} className="text-amber-400" />
            <span>文件</span>
          </button>
          <button
            onClick={() => {
              setSidebarTab('literature');
              onOpenLiteratureHub();
            }}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1 rounded-md font-medium transition-all ${
              sidebarTab === 'literature' || isLiteratureActive
                ? 'bg-zinc-800 text-zinc-100 shadow-xs font-semibold'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <BookOpen size={12} className="text-sky-400" />
            <span>文献</span>
          </button>
          <button
            onClick={() => setSidebarTab('sessions')}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1 rounded-md font-medium transition-all ${
              sidebarTab === 'sessions'
                ? 'bg-zinc-800 text-zinc-100 shadow-xs font-semibold'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <MessagesSquare size={12} className="text-zinc-400" />
            <span>会话</span>
          </button>
        </div>
      </div>

      {/* Main Content Area based on Tab */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {/* TAB 1: FILE TREE (文件树) */}
        {sidebarTab === 'files' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            <FileTreeView
              files={files}
              activeFilePath={activeFilePath}
              onSelectFile={onSelectFile}
              onCreateFile={onCreateFile}
              onDeleteFile={onDeleteFile}
              onSaveFileContent={onSaveFileContent}
              onPreviewFile={onPreviewFile}
            />
          </div>
        )}

        {/* TAB 2: LITERATURE LIBRARY (文献库快捷索引) */}
        {sidebarTab === 'literature' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Quick action header */}
            <div className="p-2.5 pb-2 border-b border-zinc-800/80 bg-zinc-900/40 shrink-0">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5 text-zinc-200 font-semibold text-xs">
                  <BookOpen size={13} className="text-sky-400" />
                  <span>文献</span>
                  <span className="text-[11px] text-zinc-500 font-mono">({papers.length})</span>
                </div>
              </div>

              {/* Search */}
              <div className="relative">
                <Search size={12} className="absolute left-2.5 top-2 text-zinc-500" />
                <input
                  type="text"
                  value={paperSearch}
                  onChange={(e) => setPaperSearch(e.target.value)}
                  placeholder="搜索论文..."
                  className="w-full bg-zinc-900/90 focus:bg-zinc-900 border border-zinc-800 focus:border-zinc-700 rounded-md pl-7 pr-2 py-1 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none transition-all"
                />
              </div>
            </div>

            {/* Paper items */}
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {filteredPapers.length === 0 ? (
                <div className="py-8 px-2 text-center text-xs text-zinc-500 space-y-1.5">
                  <BookOpen size={18} className="mx-auto text-zinc-600 mb-1" />
                  <p className="text-zinc-400 font-medium">文献库暂无文献</p>
                  <p className="text-[11px] text-zinc-500">可在文献库中导入 PDF 或 arXiv</p>
                </div>
              ) : (
                filteredPapers.map((paper) => {
                  const isSelected = paper.id === activePaperId && isLiteratureActive;
                  return (
                    <div
                      key={paper.id}
                      onClick={() => {
                        onSelectPaper(paper);
                        onOpenLiteratureHub('reader');
                      }}
                      className={`p-2 rounded-lg cursor-pointer transition-all border text-left ${
                        isSelected
                          ? 'bg-zinc-900 border-zinc-700 text-zinc-100 shadow-xs ring-1 ring-white/10'
                          : 'bg-transparent border-transparent text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200'
                      }`}
                    >
                      <div className="flex items-center gap-1.5 py-0.5">
                        <FileText size={12} className="text-sky-400 shrink-0" />
                        <h4 className="text-xs font-medium truncate flex-1 leading-snug">
                          {paper.title}
                        </h4>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* TAB 3: CHAT SESSIONS (历史对话) */}
        {sidebarTab === 'sessions' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="p-2.5 pb-2 border-b border-zinc-800/80 bg-zinc-900/40 shrink-0">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5 text-zinc-200 font-semibold text-xs">
                  <MessagesSquare size={13} className="text-zinc-400" />
                  <span>会话</span>
                  <span className="text-[11px] text-zinc-500 font-mono">({sessions.length})</span>
                </div>
                <button
                  onClick={onNewSession}
                  className="flex items-center gap-1 px-2 py-0.5 bg-zinc-100 hover:bg-white text-zinc-950 rounded text-[11px] font-medium transition-colors"
                >
                  <Plus size={11} />
                  <span>新建</span>
                </button>
              </div>

              <div className="relative">
                <Search size={12} className="absolute left-2.5 top-2 text-zinc-500" />
                <input
                  type="text"
                  value={sessionSearch}
                  onChange={(e) => setSessionSearch(e.target.value)}
                  placeholder="搜索会话..."
                  className="w-full bg-zinc-900/90 focus:bg-zinc-900 border border-zinc-800 focus:border-zinc-700 rounded-md pl-7 pr-6 py-1 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none transition-all"
                />
                {sessionSearch && (
                  <button
                    onClick={() => setSessionSearch('')}
                    className="absolute right-2 top-1.5 text-zinc-400 hover:text-zinc-200"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
              {filteredSessions.map((session) => {
                const isActive = session.id === activeSessionId;
                const isEditing = editingSessionId === session.id;

                return (
                  <div
                    key={session.id}
                    onClick={() => onSelectSession(session.id)}
                    className={`group relative rounded-lg px-2.5 py-2 cursor-pointer transition-all border text-left ${
                      isActive
                        ? 'bg-zinc-900 border-zinc-700 text-zinc-100 shadow-xs ring-1 ring-white/10'
                        : 'bg-transparent border-transparent text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1 mb-1">
                      {isEditing ? (
                        <div
                          className="flex items-center gap-1 w-full"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="text"
                            value={editTitle}
                            onChange={(e) => setEditTitle(e.target.value)}
                            onKeyDown={(e) => handleKeyDownRename(e, session.id)}
                            onBlur={() => handleSaveRename(session.id)}
                            autoFocus
                            className="w-full bg-zinc-900 border border-zinc-600 rounded px-1.5 py-0.5 text-xs text-zinc-100 focus:outline-none"
                          />
                          <button
                            onClick={() => handleSaveRename(session.id)}
                            className="text-emerald-400 hover:text-emerald-300 p-0.5"
                          >
                            <Check size={12} />
                          </button>
                        </div>
                      ) : (
                        <>
                          <h4
                            onDoubleClick={(e) => handleStartRename(session, e)}
                            className="text-xs font-medium truncate flex-1 leading-snug"
                          >
                            {session.title}
                          </h4>
                          <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 shrink-0 transition-opacity">
                            <button
                              onClick={(e) => handleStartRename(session, e)}
                              className="p-1 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded"
                            >
                              <Edit3 size={11} />
                            </button>
                            {sessions.length > 1 && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onDeleteSession(session.id);
                                }}
                                className="p-1 text-zinc-400 hover:text-rose-400 hover:bg-zinc-800 rounded"
                              >
                                <Trash2 size={11} />
                              </button>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                      <span>{session.updatedAt || session.createdAt}</span>
                      <span aria-hidden="true">·</span>
                      <span>{session.messages.length} 条</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Bottom Theme Bar */}
      <div className="p-2 border-t border-zinc-800/80 bg-zinc-900/50 flex items-center shrink-0">
        {onToggleTheme && (
          <button
            onClick={onToggleTheme}
            className="w-full flex items-center justify-center gap-2 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800/80 text-zinc-300 hover:text-zinc-100 transition-colors cursor-pointer text-xs font-medium"
            title="切换外观 (⌘D)"
          >
            {theme === 'light' ? (
              <>
                <Moon size={12} className="text-indigo-400" />
                <span>深色</span>
              </>
            ) : (
              <>
                <Sun size={12} className="text-amber-400" />
                <span>浅色</span>
              </>
            )}
          </button>
        )}
      </div>
    </aside>
  );
};
