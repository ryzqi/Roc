import React from 'react';
import { 
  FolderGit2, 
  Settings, 
  PanelLeftClose, 
  PanelLeft, 
  Bot, 
  GitBranch, 
  Search, 
  Sliders,
  ArrowLeft
} from 'lucide-react';
import { ManagementTab } from '../types/research';

interface MacWindowChromeProps {
  projectName: string;
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
  isAgentOpen: boolean;
  onToggleAgent: () => void;
  onOpenSystemDrawer: () => void;
  onOpenSettings: () => void;
  onOpenSearch: () => void;
  onOpenManagementPanel?: (tab: ManagementTab) => void;
  onBackToProjects?: () => void;
}

export const MacWindowChrome: React.FC<MacWindowChromeProps> = ({
  projectName,
  isSidebarOpen,
  onToggleSidebar,
  isAgentOpen,
  onToggleAgent,
  onOpenSystemDrawer,
  onOpenSettings,
  onOpenSearch,
  onOpenManagementPanel,
  onBackToProjects
}) => {
  return (
    <header className="h-11 bg-zinc-950/95 backdrop-blur-md border-b border-zinc-800/80 flex items-center justify-between px-3 select-none z-30 shrink-0 gap-2 overflow-hidden text-zinc-200">
      {/* Left zone: macOS Traffic lights & sidebar toggle & Breadcrumb */}
      <div className="flex items-center gap-2.5 min-w-0 shrink">
        <div className="flex items-center gap-1.5 group/lights px-1 shrink-0">
          <button 
            aria-label="Close Window"
            title="关闭"
            className="w-3 h-3 rounded-full bg-[#FF5F56] border border-[#E0443E] hover:opacity-90 flex items-center justify-center transition-opacity"
          >
            <span className="opacity-0 group-hover/lights:opacity-100 text-[8px] font-bold text-black/60 leading-none">×</span>
          </button>
          <button 
            aria-label="Minimize Window"
            title="最小化"
            className="w-3 h-3 rounded-full bg-[#FFBD2E] border border-[#DEA123] hover:opacity-90 flex items-center justify-center transition-opacity"
          >
            <span className="opacity-0 group-hover/lights:opacity-100 text-[8px] font-bold text-black/60 leading-none">−</span>
          </button>
          <button 
            aria-label="Expand Window"
            title="全屏"
            className="w-3 h-3 rounded-full bg-[#27C93F] border border-[#1AAB29] hover:opacity-90 flex items-center justify-center transition-opacity"
          >
            <span className="opacity-0 group-hover/lights:opacity-100 text-[7px] font-bold text-black/60 leading-none">+</span>
          </button>
        </div>

        <button
          onClick={onToggleSidebar}
          title={isSidebarOpen ? "收起侧栏 (⌘B)" : "展开侧栏 (⌘B)"}
          className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/70 transition-colors shrink-0"
        >
          {isSidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeft size={15} />}
        </button>

        {/* Back to Projects Button */}
        {onBackToProjects && (
          <button
            onClick={onBackToProjects}
            title="返回论文项目列表"
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium text-zinc-300 hover:text-white bg-zinc-900/90 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 transition-colors shrink-0 cursor-pointer"
          >
            <ArrowLeft size={13} className="text-zinc-400" />
            <span className="hidden md:inline">项目列表</span>
          </button>
        )}

        {/* Project Breadcrumb */}
        <div className="flex items-center gap-1.5 text-xs text-zinc-400 min-w-0 truncate">
          {onBackToProjects ? (
            <button
              onClick={onBackToProjects}
              className="hover:text-zinc-200 transition-colors truncate hidden sm:inline"
              title="点击返回课题门户"
            >
              论文课题
            </button>
          ) : (
            <FolderGit2 size={13} className="text-zinc-500 shrink-0" />
          )}
          <span className="text-zinc-600 hidden sm:inline">/</span>
          <span className="text-zinc-200 font-medium tracking-tight truncate max-w-[120px] sm:max-w-[200px]" title={projectName}>
            ~/{projectName}
          </span>
          <span className="text-zinc-600 hidden sm:inline">/</span>
          <span className="text-emerald-400 text-[11px] font-mono hidden sm:inline shrink-0">main</span>
        </div>
      </div>

      {/* Center Zone: Quick Command Palette Trigger */}
      <div className="flex items-center justify-center shrink min-w-0">
        <button
          onClick={onOpenSearch}
          className="flex items-center gap-2 px-3 py-1 bg-zinc-900/90 hover:bg-zinc-800/80 border border-zinc-800 hover:border-zinc-700 rounded-lg text-xs text-zinc-400 hover:text-zinc-200 transition-all w-32 sm:w-48 md:w-56 justify-between group truncate"
        >
          <span className="flex items-center gap-1.5 text-zinc-400 group-hover:text-zinc-200 truncate">
            <Search size={12} className="text-zinc-500 shrink-0" />
            <span className="truncate">搜索...</span>
          </span>
          <kbd className="text-[10px] bg-zinc-800 border border-zinc-700/80 px-1.5 py-0.5 rounded text-zinc-400 font-mono hidden sm:inline shrink-0">⌘K</kbd>
        </button>
      </div>

      {/* Right Zone: View Controls & Quick Action Buttons */}
      <div className="flex items-center gap-1.5 shrink-0">
        {/* Toggle AI Copilot Button */}
        <button
          onClick={onToggleAgent}
          title={isAgentOpen ? "收起助手 (⌘J)" : "打开助手 (⌘J)"}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border transition-all ${
            isAgentOpen
              ? 'bg-zinc-100 text-zinc-900 border-zinc-200 shadow-xs'
              : 'bg-zinc-900 hover:bg-zinc-800/90 border-zinc-800 text-zinc-300'
          }`}
        >
          <Bot size={13} className={isAgentOpen ? 'text-zinc-900' : 'text-zinc-400'} />
          <span>助手</span>
        </button>

        {/* System & Agent Management Hub Trigger */}
        <button
          onClick={() => onOpenManagementPanel?.('memory')}
          title="管理"
          className="flex items-center gap-1.5 px-2.5 py-1 bg-zinc-900 hover:bg-zinc-800/90 border border-zinc-800 rounded-lg text-xs font-medium text-zinc-300 hover:text-zinc-100 transition-colors"
        >
          <Sliders size={13} className="text-purple-400" />
          <span className="hidden sm:inline">管理</span>
        </button>

        {/* Git Version Drawer Trigger Button */}
        <button
          onClick={onOpenSystemDrawer}
          title="Git"
          className="flex items-center gap-1.5 px-2.5 py-1 bg-zinc-900 hover:bg-zinc-800/90 border border-zinc-800 rounded-lg text-xs font-medium text-zinc-300 hover:text-zinc-100 transition-colors"
        >
          <GitBranch size={13} className="text-emerald-400" />
          <span className="hidden sm:inline">Git</span>
        </button>

        {/* Settings Action Button */}
        <button
          onClick={onOpenSettings}
          title="设置 (⌘,)"
          className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/90 border border-zinc-800 transition-colors cursor-pointer"
        >
          <Settings size={14} />
        </button>
      </div>
    </header>
  );
};
