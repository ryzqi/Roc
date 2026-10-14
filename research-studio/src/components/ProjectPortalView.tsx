import React, { useState, useMemo } from 'react';
import { PaperProject } from '../types/research';
import {
  FolderGit2,
  Plus,
  Search,
  Trash2,
  Edit3,
  ArrowRight,
  X,
  RotateCcw,
  Settings
} from 'lucide-react';

interface ProjectPortalViewProps {
  projects: PaperProject[];
  onSelectProject: (projectId: string) => void;
  onCreateProject: (
    newProject: Omit<PaperProject, 'id' | 'createdAt' | 'updatedAt' | 'paperCount' | 'fileCount' | 'wordCount'>,
    template: string
  ) => void;
  onCloneProject: (projectId: string) => void;
  onDeleteProject: (projectId: string) => void;
  onToggleStar: (projectId: string) => void;
  onUpdateProject: (project: PaperProject) => void;
  onOpenSettings?: () => void;
}

export const ProjectPortalView: React.FC<ProjectPortalViewProps> = ({
  projects,
  onSelectProject,
  onCreateProject,
  onDeleteProject,
  onUpdateProject,
  onOpenSettings
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<PaperProject | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);

  // Form state for creating a new project
  const [newTitle, setNewTitle] = useState('');

  // Filtered projects: only filtered by title
  const filteredProjects = useMemo(() => {
    if (!searchQuery.trim()) return projects;
    const q = searchQuery.toLowerCase();
    return projects.filter((p) => p.title.toLowerCase().includes(q));
  }, [projects, searchQuery]);

  const handleOpenCreateModal = () => {
    setNewTitle('');
    setIsCreateModalOpen(true);
  };

  const handleSubmitCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;

    const generatedSlug =
      newTitle
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-') || `project-${Date.now().toString().slice(-4)}`;

    onCreateProject(
      {
        slug: generatedSlug,
        title: newTitle.trim(),
        description: '',
        field: '',
        targetVenue: '',
        status: 'drafting',
        tags: [],
        isStarred: false
      },
      'blank'
    );

    setNewTitle('');
    setIsCreateModalOpen(false);
  };

  const handleSaveEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingProject || !editingProject.title.trim()) return;
    onUpdateProject(editingProject);
    setEditingProject(null);
  };

  return (
    <div className="flex-1 flex flex-col h-screen w-screen bg-zinc-950 text-zinc-100 overflow-y-auto selection:bg-zinc-800 selection:text-zinc-200">
      {/* Main Content Container */}
      <div className="max-w-6xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 flex flex-col gap-6 flex-1 min-h-0">
        {/* Minimalist Header with Actions */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-zinc-800/80">
          <div className="flex items-center gap-3">
            <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-100">
              论文项目
            </h1>
            <span className="px-2 py-0.5 text-xs font-mono text-zinc-400 bg-zinc-900 border border-zinc-800 rounded-md">
              {projects.length}
            </span>
          </div>

          <div className="flex items-center gap-2.5">
            {/* Search Box */}
            <div className="relative w-56 sm:w-64">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索项目名称..."
                className="w-full pl-8.5 pr-7 py-1.5 bg-zinc-900 border border-zinc-800 rounded-lg text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-600 transition-colors"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 p-0.5"
                >
                  <X size={12} />
                </button>
              )}
            </div>

            {/* Settings Button */}
            {onOpenSettings && (
              <button
                onClick={onOpenSettings}
                title="设置 (⌘,)"
                className="flex items-center gap-1.5 px-2.5 py-1.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-zinc-100 border border-zinc-800 rounded-lg text-xs font-medium transition-colors cursor-pointer shrink-0"
              >
                <Settings size={14} className="text-zinc-400" />
                <span className="hidden sm:inline">设置</span>
              </button>
            )}

            {/* Create Project Button */}
            <button
              onClick={handleOpenCreateModal}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-100 hover:bg-white text-zinc-900 font-medium text-xs rounded-lg transition-colors shadow-xs active:scale-[0.98] cursor-pointer shrink-0"
            >
              <Plus size={14} className="text-zinc-900 stroke-[2.5]" />
              <span>新建项目</span>
            </button>
          </div>
        </div>

        {/* Project Cards Grid - Only Project Title */}
        {filteredProjects.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center p-12 text-center bg-zinc-900/30 border border-zinc-800/60 rounded-2xl min-h-[260px]">
            <FolderGit2 size={32} className="text-zinc-600 mb-2.5" />
            <h3 className="text-sm font-medium text-zinc-300">暂无项目</h3>
            <div className="flex items-center gap-2.5 mt-3.5">
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-200 rounded-lg transition-colors flex items-center gap-1.5"
                >
                  <RotateCcw size={12} />
                  <span>清除搜索</span>
                </button>
              )}
              <button
                onClick={handleOpenCreateModal}
                className="px-3 py-1.5 bg-zinc-100 hover:bg-white text-zinc-900 text-xs font-medium rounded-lg transition-colors flex items-center gap-1.5"
              >
                <Plus size={13} />
                <span>新建项目</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
            {filteredProjects.map((project) => (
              <div
                key={project.id}
                onClick={() => onSelectProject(project.id)}
                className="group relative bg-zinc-900/60 hover:bg-zinc-900 border border-zinc-800/80 hover:border-zinc-700 rounded-xl p-4 transition-all flex flex-col justify-between gap-3 cursor-pointer hover:shadow-lg hover:shadow-black/30 hover:-translate-y-0.5"
              >
                <div className="flex items-start gap-2.5 min-w-0">
                  <FolderGit2
                    size={16}
                    className="text-zinc-500 group-hover:text-emerald-400 shrink-0 mt-0.5 transition-colors"
                  />
                  {/* ONLY Project Title */}
                  <h2 className="text-sm font-medium text-zinc-100 group-hover:text-white leading-snug line-clamp-2 transition-colors">
                    {project.title}
                  </h2>
                </div>

                {/* Bottom Actions */}
                <div
                  className="flex items-center justify-end gap-1.5 pt-2 border-t border-zinc-800/40 text-xs"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    onClick={() => setEditingProject(project)}
                    title="重命名项目"
                    className="p-1.5 text-zinc-400 hover:text-zinc-200 rounded hover:bg-zinc-800 transition-colors"
                  >
                    <Edit3 size={13} />
                  </button>

                  <button
                    onClick={() => setDeletingProjectId(project.id)}
                    title="删除项目"
                    className="p-1.5 text-zinc-400 hover:text-red-400 rounded hover:bg-red-500/10 transition-colors"
                  >
                    <Trash2 size={13} />
                  </button>

                  <button
                    onClick={() => onSelectProject(project.id)}
                    title="进入项目"
                    className="flex items-center gap-1 pl-2 pr-1.5 py-1 text-xs font-medium text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10 rounded transition-colors"
                  >
                    <span>进入</span>
                    <ArrowRight size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 1. Create New Project Modal */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fadeIn">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-md p-5 shadow-2xl flex flex-col gap-4">
            <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
              <div className="flex items-center gap-2">
                <FolderGit2 size={16} className="text-emerald-400" />
                <h3 className="text-sm font-semibold text-zinc-100">新建项目</h3>
              </div>
              <button
                onClick={() => setIsCreateModalOpen(false)}
                className="text-zinc-400 hover:text-zinc-200 p-1 rounded-lg hover:bg-zinc-800 transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            <form onSubmit={handleSubmitCreate} className="flex flex-col gap-4 text-xs sm:text-sm">
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                  项目名称 <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  required
                  autoFocus
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="请输入论文项目名称..."
                  className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-600 focus:ring-1 focus:ring-zinc-600 text-xs"
                />
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-zinc-800">
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg transition-colors"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-3.5 py-1.5 text-xs font-medium bg-zinc-100 hover:bg-white text-zinc-900 rounded-lg transition-colors flex items-center gap-1.5 shadow-sm"
                >
                  <Plus size={13} className="stroke-[2.5]" />
                  <span>创建项目</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 2. Edit Project Modal */}
      {editingProject && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fadeIn">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-md p-5 shadow-2xl flex flex-col gap-4">
            <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
              <div className="flex items-center gap-2">
                <Edit3 size={15} className="text-zinc-300" />
                <h3 className="text-sm font-semibold text-zinc-100">重命名项目</h3>
              </div>
              <button
                onClick={() => setEditingProject(null)}
                className="text-zinc-400 hover:text-zinc-200 p-1 rounded-lg hover:bg-zinc-800 transition-colors"
              >
                <X size={15} />
              </button>
            </div>

            <form onSubmit={handleSaveEdit} className="flex flex-col gap-3 text-xs sm:text-sm">
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">项目名称</label>
                <input
                  type="text"
                  required
                  autoFocus
                  value={editingProject.title}
                  onChange={(e) =>
                    setEditingProject({ ...editingProject, title: e.target.value })
                  }
                  className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-lg text-zinc-200 text-xs focus:outline-none focus:border-zinc-600"
                />
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-zinc-800">
                <button
                  type="button"
                  onClick={() => setEditingProject(null)}
                  className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-3.5 py-1.5 text-xs font-medium bg-zinc-100 hover:bg-white text-zinc-900 rounded-lg"
                >
                  保存
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 3. Delete Confirmation Modal */}
      {deletingProjectId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fadeIn">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-sm p-5 shadow-2xl flex flex-col gap-4">
            <div className="flex items-center gap-2 text-red-400">
              <Trash2 size={16} />
              <h3 className="text-sm font-semibold text-zinc-100">确认删除项目？</h3>
            </div>
            <p className="text-xs text-zinc-400 leading-relaxed">
              确定要删除此项目吗？该操作不可撤销。
            </p>
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-zinc-800">
              <button
                onClick={() => setDeletingProjectId(null)}
                className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg"
              >
                取消
              </button>
              <button
                onClick={() => {
                  onDeleteProject(deletingProjectId);
                  setDeletingProjectId(null);
                }}
                className="px-3 py-1.5 text-xs font-medium bg-red-600 hover:bg-red-500 text-white rounded-lg transition-colors"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
