import React, { useState, useMemo } from 'react';
import { VirtualFile, FileTreeNode } from '../types/research';
import { FilePreviewModal } from './FilePreviewModal';
import {
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  FileCode,
  FileText,
  FileSpreadsheet,
  File,
  Plus,
  Trash2,
  Search,
  Check,
  X,
  Eye
} from 'lucide-react';

interface FileTreeViewProps {
  files: VirtualFile[];
  activeFilePath?: string;
  onSelectFile: (file: VirtualFile) => void;
  onCreateFile: (path: string, type: VirtualFile['type']) => void;
  onDeleteFile: (path: string) => void;
  onSaveFileContent?: (path: string, content: string) => void;
  onPreviewFile?: (file: VirtualFile) => void;
}

export const FileTreeView: React.FC<FileTreeViewProps> = ({
  files,
  activeFilePath,
  onSelectFile,
  onCreateFile,
  onDeleteFile,
  onSaveFileContent,
  onPreviewFile
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set(['src', 'data', 'sections', 'figures'])
  );
  const [isCreatingFile, setIsCreatingFile] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [newFileType, setNewFileType] = useState<VirtualFile['type']>('tex');
  const [previewFile, setPreviewFile] = useState<VirtualFile | null>(null);

  const toggleFolder = (folderPath: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) {
        next.delete(folderPath);
      } else {
        next.add(folderPath);
      }
      return next;
    });
  };

  // Build tree from flat files list
  const fileTree = useMemo(() => {
    const rootNodes: FileTreeNode[] = [];
    const dirMap: Record<string, FileTreeNode> = {};

    const targetFiles = searchQuery.trim()
      ? files.filter(
          (f) =>
            f.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            f.path.toLowerCase().includes(searchQuery.toLowerCase())
        )
      : files;

    targetFiles.forEach((file) => {
      const parts = file.path.split('/');
      if (parts.length === 1) {
        rootNodes.push({
          path: file.path,
          name: file.name,
          type: file.type,
          content: file.content
        });
      } else {
        const dirName = parts[0];
        if (!dirMap[dirName]) {
          const dirNode: FileTreeNode = {
            path: dirName,
            name: dirName,
            type: 'dir',
            children: []
          };
          dirMap[dirName] = dirNode;
          rootNodes.push(dirNode);
        }
        dirMap[dirName].children!.push({
          path: file.path,
          name: file.name,
          type: file.type,
          content: file.content
        });
      }
    });

    return rootNodes;
  }, [files, searchQuery]);

  const handleCreateSubmit = () => {
    if (!newFileName.trim()) {
      setIsCreatingFile(false);
      return;
    }
    const cleanName = newFileName.trim();
    let ext: VirtualFile['type'] = newFileType;
    if (cleanName.endsWith('.tex')) ext = 'tex';
    else if (cleanName.endsWith('.py')) ext = 'py';
    else if (cleanName.endsWith('.bib')) ext = 'bib';
    else if (cleanName.endsWith('.json')) ext = 'json';
    else if (cleanName.endsWith('.md')) ext = 'md';

    onCreateFile(cleanName, ext);
    setNewFileName('');
    setIsCreatingFile(false);
  };

  const getFileIcon = (type: VirtualFile['type']) => {
    switch (type) {
      case 'tex':
        return <FileText size={13} className="text-amber-400 shrink-0" />;
      case 'py':
        return <FileCode size={13} className="text-emerald-400 shrink-0" />;
      case 'bib':
        return <FileSpreadsheet size={13} className="text-purple-400 shrink-0" />;
      case 'json':
        return <FileCode size={13} className="text-sky-400 shrink-0" />;
      case 'md':
        return <FileText size={13} className="text-blue-400 shrink-0" />;
      default:
        return <File size={13} className="text-zinc-400 shrink-0" />;
    }
  };

  const handleOpenFilePreview = (targetPath: string) => {
    const match = files.find((f) => f.path === targetPath);
    if (match) {
      onSelectFile(match);
      if (onPreviewFile) {
        onPreviewFile(match);
      } else {
        setPreviewFile(match);
      }
    }
  };

  const renderNode = (node: FileTreeNode, depth = 0) => {
    const isDir = node.type === 'dir';
    const isExpanded = expandedFolders.has(node.path);
    const isSelected = activeFilePath === node.path;

    if (isDir) {
      return (
        <div key={node.path} className="select-none">
          <div
            onClick={() => toggleFolder(node.path)}
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
            className="flex items-center gap-1.5 py-1 px-2 rounded-md hover:bg-zinc-800/60 cursor-pointer text-zinc-300 text-xs transition-colors"
          >
            {isExpanded ? (
              <ChevronDown size={12} className="text-zinc-500 shrink-0" />
            ) : (
              <ChevronRight size={12} className="text-zinc-500 shrink-0" />
            )}
            {isExpanded ? (
              <FolderOpen size={13} className="text-amber-400 shrink-0" />
            ) : (
              <Folder size={13} className="text-amber-400 shrink-0" />
            )}
            <span className="font-medium truncate">{node.name}</span>
          </div>

          {isExpanded && node.children && (
            <div className="flex flex-col">
              {node.children.map((child) => renderNode(child, depth + 1))}
            </div>
          )}
        </div>
      );
    }

    return (
      <div
        key={node.path}
        onClick={() => handleOpenFilePreview(node.path)}
        style={{ paddingLeft: `${depth * 12 + 18}px` }}
        className={`group flex items-center justify-between py-1 px-2 rounded-md cursor-pointer text-xs transition-colors ${
          isSelected
            ? 'bg-zinc-800/90 text-zinc-100 font-medium'
            : 'text-zinc-400 hover:bg-zinc-900/80 hover:text-zinc-200'
        }`}
        title={`预览: ${node.path}`}
      >
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          {getFileIcon(node.type as VirtualFile['type'])}
          <span className="truncate">{node.name}</span>
        </div>

        <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleOpenFilePreview(node.path);
            }}
            className="text-zinc-400 hover:text-sky-300 p-0.5 rounded hover:bg-zinc-800 transition-colors"
            title="预览"
          >
            <Eye size={12} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDeleteFile(node.path);
            }}
            className="text-zinc-400 hover:text-rose-400 p-0.5 rounded hover:bg-zinc-800 transition-colors"
            title="删除"
          >
            <Trash2 size={11} />
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full overflow-hidden text-zinc-300">
      {/* File Tree Header */}
      <div className="p-2 border-b border-zinc-800/80 flex items-center justify-between gap-1 shrink-0 bg-zinc-900/40">
        <span className="text-[11px] font-semibold tracking-wide text-zinc-400 px-1">
          文件
        </span>
        <button
          onClick={() => setIsCreatingFile(true)}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/80 transition-colors cursor-pointer"
          title="新建"
        >
          <Plus size={12} />
          <span>新建</span>
        </button>
      </div>

      {/* Quick Search */}
      <div className="p-2 pb-1.5 shrink-0">
        <div className="relative">
          <Search size={11} className="absolute left-2 top-2 text-zinc-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索..."
            className="w-full pl-6 pr-2 py-1 bg-zinc-900/90 border border-zinc-800 focus:border-zinc-700 rounded text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none"
          />
        </div>
      </div>

      {/* Inline Create Input */}
      {isCreatingFile && (
        <div className="mx-2 mb-2 p-1.5 bg-zinc-900 border border-zinc-700 rounded shadow-xs shrink-0 flex items-center gap-1">
          <input
            type="text"
            autoFocus
            value={newFileName}
            onChange={(e) => setNewFileName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateSubmit();
              if (e.key === 'Escape') setIsCreatingFile(false);
            }}
            placeholder="名称 (如 model.py)"
            className="flex-1 text-xs text-zinc-100 bg-transparent outline-none"
          />
          <button
            onClick={handleCreateSubmit}
            className="text-emerald-400 hover:text-emerald-300 p-0.5 cursor-pointer"
          >
            <Check size={12} />
          </button>
          <button
            onClick={() => setIsCreatingFile(false)}
            className="text-zinc-400 hover:text-zinc-200 p-0.5 cursor-pointer"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* File Tree Nodes */}
      <div className="flex-1 overflow-y-auto px-1 py-1 space-y-0.5">
        {fileTree.length === 0 ? (
          <div className="py-8 px-3 text-center text-xs text-zinc-500 space-y-1.5">
            <FileText size={20} className="mx-auto text-zinc-600 mb-1" />
            <p className="text-zinc-400 font-medium">暂无文件</p>
            <p className="text-[11px] text-zinc-500">点击上方「新建」创建代码或 LaTeX 文件</p>
          </div>
        ) : (
          fileTree.map((node) => renderNode(node))
        )}
      </div>

      {/* File Preview Popup Modal (fallback if not handled by root) */}
      {!onPreviewFile && previewFile && (
        <FilePreviewModal
          file={previewFile}
          files={files}
          isOpen={true}
          onClose={() => setPreviewFile(null)}
          onOpenInEditor={(f) => {
            onSelectFile(f);
            setPreviewFile(null);
          }}
          onSaveContent={(path, content) => {
            if (onSaveFileContent) {
              onSaveFileContent(path, content);
            }
          }}
          onSelectFile={(f) => {
            setPreviewFile(f);
            onSelectFile(f);
          }}
        />
      )}
    </div>
  );
};
