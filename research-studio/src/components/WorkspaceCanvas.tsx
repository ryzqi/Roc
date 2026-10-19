import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  WorkspaceTab,
  ResearchPaper,
  GraphNode,
  GraphLink,
  VirtualFile,
  RagWikiEntry,
  LiteratureSubView,
  ModelSettings
} from '../types/research';
import { LatexEditorView } from './views/LatexEditorView';
import { TerminalView } from './views/TerminalView';
import { LiteratureHubView } from './views/LiteratureHubView';
import {
  FileText,
  Terminal,
  BookOpen
} from 'lucide-react';

interface WorkspaceCanvasProps {
  activeTab: WorkspaceTab;
  onChangeTab: (tab: WorkspaceTab) => void;
  // Literature & Knowledge Hub
  papers: ResearchPaper[];
  activePaperId: string;
  onSelectPaper: (paper: ResearchPaper) => void;
  onAddPaper: (paper: ResearchPaper) => void;
  onAskAboutPaper: (paper: ResearchPaper) => void;
  graphNodes: GraphNode[];
  graphLinks: GraphLink[];
  selectedGraphNodeId?: string;
  onSelectGraphNode: (node: GraphNode) => void;
  onExpandGraphWithNode: (node: GraphNode) => void;
  wikiEntries: RagWikiEntry[];
  onAddWikiEntry?: (entry: RagWikiEntry) => void;
  initialLiteratureSubView?: LiteratureSubView;
  // LaTeX
  latexCode: string;
  onLatexCodeChange: (code: string) => void;
  onAskAgentToEditLatex: (prompt: string) => void;
  // Plot & Terminal
  plotCode: string;
  onRunScriptInTerminal: (code: string) => void;
  terminalCommand?: string;
  // Files
  activeFile?: VirtualFile;
  files?: VirtualFile[];
  onSelectFile?: (file: VirtualFile) => void;
  onSaveFileContent?: (path: string, content: string) => void;
  settings?: ModelSettings;
  onOpenSettings?: (tab?: string) => void;
}

export const WorkspaceCanvas: React.FC<WorkspaceCanvasProps> = ({
  activeTab,
  onChangeTab,
  papers,
  activePaperId,
  onSelectPaper,
  onAddPaper,
  onAskAboutPaper,
  graphNodes,
  graphLinks,
  selectedGraphNodeId,
  onSelectGraphNode,
  onExpandGraphWithNode,
  wikiEntries,
  onAddWikiEntry,
  initialLiteratureSubView,
  latexCode,
  onLatexCodeChange,
  onAskAgentToEditLatex,
  terminalCommand,
  activeFile,
  settings,
  onOpenSettings
}) => {
  const isLiterature = activeTab === 'literature' || activeTab === 'paper' || activeTab === 'graph';

  // Unified Workspace View Tabs
  const toolTabs: { id: WorkspaceTab; label: string; icon: React.ReactNode; isMatch: boolean }[] = [
    {
      id: 'literature',
      label: '文献',
      icon: <BookOpen size={13} className="text-sky-400" />,
      isMatch: isLiterature
    },
    {
      id: 'latex',
      label: 'LaTeX',
      icon: <FileText size={13} className="text-amber-400" />,
      isMatch: activeTab === 'latex'
    },
    {
      id: 'terminal',
      label: '终端',
      icon: <Terminal size={13} className="text-emerald-400" />,
      isMatch: activeTab === 'terminal'
    }
  ];

  return (
    <main className="flex-1 bg-zinc-950 flex flex-col h-full overflow-hidden select-none min-w-0 text-zinc-200">
      {/* Top Workspace Tab Bar */}
      <div className="h-10 bg-zinc-950 border-b border-zinc-800/80 px-3 flex items-center justify-between shrink-0 overflow-x-auto no-scrollbar">
        <div className="flex items-center gap-1">
          {toolTabs.map((tab) => {
            const isActive = tab.isMatch;
            return (
              <button
                key={tab.id}
                onClick={() => onChangeTab(tab.id)}
                className={`relative flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all whitespace-nowrap shrink-0 ${
                  isActive
                    ? 'bg-zinc-900 text-zinc-100 border border-zinc-700/80 shadow-xs font-semibold'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/60 border border-transparent'
                }`}
              >
                {tab.icon}
                <span>{tab.label}</span>
                {isActive && (
                  <motion.div
                    layoutId="activeTabIndicator"
                    className="absolute bottom-0 left-2 right-2 h-0.5 bg-zinc-200 rounded-full"
                    transition={{ type: 'spring', bounce: 0.15, duration: 0.18 }}
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Main Tab View Port */}
      <div className="flex-1 overflow-hidden relative">
        <AnimatePresence mode="wait">
          {/* 文献库全功能科研中心 */}
          {isLiterature && (
            <motion.div
              key="literature"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              className="h-full w-full"
            >
              <LiteratureHubView
                papers={papers}
                activePaperId={activePaperId}
                onSelectPaper={onSelectPaper}
                onAddPaper={onAddPaper}
                onAskAboutPaper={onAskAboutPaper}
                graphNodes={graphNodes}
                graphLinks={graphLinks}
                selectedGraphNodeId={selectedGraphNodeId}
                onSelectGraphNode={onSelectGraphNode}
                onExpandGraphWithNode={onExpandGraphWithNode}
                wikiEntries={wikiEntries}
                onAddWikiEntry={onAddWikiEntry}
                initialSubView={initialLiteratureSubView || (activeTab === 'graph' ? 'graph' : activeTab === 'paper' ? 'reader' : 'reader')}
                settings={settings}
                onOpenSettings={onOpenSettings}
              />
            </motion.div>
          )}

          {/* LaTeX 编辑器 */}
          {activeTab === 'latex' && (
            <motion.div
              key="latex"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              className="h-full w-full"
            >
              <LatexEditorView
                initialCode={latexCode}
                onCodeChange={onLatexCodeChange}
                onAskAgentToEdit={onAskAgentToEditLatex}
                settings={settings}
                onOpenSettings={onOpenSettings}
                fileName={activeFile?.type === 'tex' ? activeFile.name : (latexCode ? 'paper.tex' : undefined)}
              />
            </motion.div>
          )}

          {/* 系统终端 */}
          {activeTab === 'terminal' && (
            <motion.div
              key="terminal"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              className="h-full w-full"
            >
              <TerminalView initialCommand={terminalCommand} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </main>
  );
};
