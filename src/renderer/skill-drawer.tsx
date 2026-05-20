import { motion } from 'motion/react';
import type React from 'react';
import type { SkillFileEntry, SkillFilePreviewResult, SkillSnapshot } from '../shared/types';
import { drawerSlideIn, drawerTransition, resolveMotionTransition } from './animations';

export type SkillBrowserViewState = {
  rootEntries: SkillFileEntry[] | null;
  expandedDirectories: Set<string>;
  directoryChildren: Record<string, SkillFileEntry[]>;
  selectedFilePath: string | null;
  preview: SkillFilePreviewResult | null;
  loadingTree: boolean;
  loadingPreview: boolean;
  error: string | null;
};

type SkillDrawerProps = {
  skill: SkillSnapshot;
  state: SkillBrowserViewState;
  busy: boolean;
  treeView: React.ReactNode;
  previewView: React.ReactNode;
  onClose: () => void;
  onToggle: () => void;
  onDelete: () => void;
};

export function SkillDrawer({
  skill,
  state,
  busy,
  treeView,
  previewView,
  onClose,
  onToggle,
  onDelete
}: SkillDrawerProps): React.JSX.Element {
  const statusLabel = skill.status === 'invalid' ? 'invalid' : skill.enabled ? 'ready' : 'disabled';
  return (
    <motion.aside
      animate="animate"
      aria-label={`Skill ${skill.name}`}
      className="skill-drawer"
      data-testid="skill-drawer"
      exit="exit"
      initial="initial"
      transition={resolveMotionTransition(drawerTransition)}
      variants={drawerSlideIn}
    >
      <header className="skill-drawer-header">
        <div className="skill-drawer-headline">
          <span className="skill-drawer-kicker">Skill · {statusLabel}</span>
          <span className="skill-drawer-name">{skill.name}</span>
        </div>
        <button
          className="skill-drawer-action"
          data-testid="skill-drawer-toggle"
          disabled={busy}
          type="button"
          onClick={onToggle}
        >
          {skill.enabled ? '禁用' : '启用'}
        </button>
        <button
          className="skill-drawer-action skill-drawer-action--danger"
          data-testid="skill-drawer-delete"
          disabled={busy}
          type="button"
          onClick={onDelete}
        >
          删除
        </button>
        <button
          aria-label="关闭"
          className="skill-drawer-action skill-drawer-close"
          data-testid="skill-drawer-close"
          type="button"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div className="skill-drawer-body">
        <section className="skill-drawer-tree section" data-testid="skill-drawer-tree">
          {state.error !== null ? (
            <div className="muted" data-testid="skill-drawer-error" style={{ padding: '12px 14px' }}>
              {state.error}
            </div>
          ) : state.rootEntries === null ? (
            <div className="muted" data-testid="skill-drawer-loading" style={{ padding: '12px 14px' }}>
              {state.loadingTree ? '正在加载目录…' : '准备加载目录'}
            </div>
          ) : (
            treeView
          )}
        </section>
        <section className="skill-drawer-preview-pane section" data-testid="skill-drawer-preview-pane">
          <header className="skill-drawer-preview-header">
            {state.selectedFilePath ?? '尚未选中文件'}
          </header>
          <div className="skill-drawer-preview-body">{previewView}</div>
        </section>
      </div>
    </motion.aside>
  );
}
