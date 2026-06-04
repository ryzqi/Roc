import { useEffect, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import type {
  SkillFileEntry,
  SkillFilePreviewResult,
  SkillFileTreeResult,
  SkillSnapshot
} from '../../../shared/types';
import { TreeItem } from '../../components/TreeItem';
import type { LoadedState } from '../../loaded-state';
import { unwrap } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';
import { createRocClient } from '../../shared/roc-client';
import { SkillsView as SkillControlView, buildSkillManagementViewModel, type SkillFilterId } from '../../skills-view';
import { SkillDrawer, type SkillBrowserViewState } from '../../skill-drawer';
import { flattenTreeEntries, isImagePreview, previewTextBody } from '../../workbench/file-tree-helpers';

export function SkillsHostView({
  client,
  state,
  updateLoadedState
}: {
  client?: RocClient;
  state: LoadedState;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
}): React.JSX.Element {
  const [filter, setFilter] = useState<SkillFilterId>('all');
  const [busySkillId, setBusySkillId] = useState<string | null>(null);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [browser, setBrowser] = useState<SkillBrowserViewState>({
    rootEntries: null,
    expandedDirectories: new Set(),
    directoryChildren: {},
    selectedFilePath: null,
    preview: null,
    loadingTree: false,
    loadingPreview: false,
    error: null
  });

  const model = buildSkillManagementViewModel(state.skills, filter, selectedSkillId);
  const selectedSkill = selectedSkillId === null ? null : state.skills.find((skill) => skill.id === selectedSkillId) ?? null;

  function resolveClient(): RocClient {
    return client ?? createRocClient();
  }

  function resetBrowser(): void {
    setBrowser({
      rootEntries: null,
      expandedDirectories: new Set(),
      directoryChildren: {},
      selectedFilePath: null,
      preview: null,
      loadingTree: false,
      loadingPreview: false,
      error: null
    });
  }

  async function refreshSkills(): Promise<void> {
    const skills = unwrap<SkillSnapshot[]>('skills', await resolveClient().api.skills.list());
    updateLoadedState({
      skills,
      selectedSkills: skills.filter((item) => item.enabled && item.status === 'ready').map((item) => item.id)
    });
  }

  async function loadRoot(skillId: string): Promise<void> {
    setBrowser((current) => ({ ...current, loadingTree: true, error: null }));
    try {
      const tree = unwrap<SkillFileTreeResult>(
        'skill files',
        await resolveClient().api.skills.listFiles({ id: skillId, relativePath: '' })
      );
      const firstFile = tree.entries.find((entry) => entry.type === 'file');
      let preview: SkillFilePreviewResult | null = null;
      if (firstFile !== undefined) {
        preview = unwrap<SkillFilePreviewResult>(
          'skill file preview',
          await resolveClient().api.skills.readFile({ id: skillId, relativePath: firstFile.relativePath })
        );
      }
      setBrowser({
        rootEntries: tree.entries,
        expandedDirectories: new Set(),
        directoryChildren: {},
        selectedFilePath: firstFile?.relativePath ?? null,
        preview,
        loadingTree: false,
        loadingPreview: false,
        error: null
      });
    } catch (error) {
      setBrowser({
        rootEntries: null,
        expandedDirectories: new Set(),
        directoryChildren: {},
        selectedFilePath: null,
        preview: null,
        loadingTree: false,
        loadingPreview: false,
        error: error instanceof Error ? error.message : '加载 Skill 目录失败。'
      });
    }
  }

  async function toggleDirectory(relativePath: string): Promise<void> {
    if (selectedSkillId === null) {
      return;
    }
    const alreadyExpanded = browser.expandedDirectories.has(relativePath);
    if (alreadyExpanded) {
      setBrowser((current) => {
        const next = new Set(current.expandedDirectories);
        next.delete(relativePath);
        return { ...current, expandedDirectories: next };
      });
      return;
    }
    if (browser.directoryChildren[relativePath] === undefined) {
      try {
        const tree = unwrap<SkillFileTreeResult>(
          'skill files',
          await resolveClient().api.skills.listFiles({ id: selectedSkillId, relativePath })
        );
        setBrowser((current) => ({
          ...current,
          directoryChildren: { ...current.directoryChildren, [relativePath]: tree.entries },
          expandedDirectories: new Set(current.expandedDirectories).add(relativePath)
        }));
      } catch (error) {
        setBrowser((current) => ({
          ...current,
          error: error instanceof Error ? error.message : '加载子目录失败。'
        }));
      }
      return;
    }
    setBrowser((current) => ({
      ...current,
      expandedDirectories: new Set(current.expandedDirectories).add(relativePath)
    }));
  }

  async function openFilePreview(relativePath: string): Promise<void> {
    if (selectedSkillId === null) {
      return;
    }
    setBrowser((current) => ({ ...current, loadingPreview: true, selectedFilePath: relativePath }));
    try {
      const preview = unwrap<SkillFilePreviewResult>(
        'skill file preview',
        await resolveClient().api.skills.readFile({ id: selectedSkillId, relativePath })
      );
      setBrowser((current) => ({ ...current, preview, loadingPreview: false }));
    } catch (error) {
      setBrowser((current) => ({
        ...current,
        loadingPreview: false,
        error: error instanceof Error ? error.message : '读取文件失败。'
      }));
    }
  }

  async function setSkillEnabled(id: string, enabled: boolean): Promise<void> {
    setBusySkillId(id);
    try {
      unwrap<SkillSnapshot>('skill toggle', await resolveClient().api.skills.setEnabled({ id, enabled }));
      await refreshSkills();
    } finally {
      setBusySkillId((current) => (current === id ? null : current));
    }
  }

  async function deleteSkill(id: string): Promise<void> {
    setBusySkillId(id);
    try {
      unwrap<{ deleted: true }>('skill delete', await resolveClient().api.skills.deleteSkill(id));
      await refreshSkills();
    } finally {
      setBusySkillId((current) => (current === id ? null : current));
    }
  }

  function handleSelectSkill(id: string): void {
    setSelectedSkillId(id);
    resetBrowser();
    void loadRoot(id);
  }

  function handleCloseDrawer(): void {
    setSelectedSkillId(null);
    resetBrowser();
  }

  useEffect(() => {
    if (selectedSkillId === null) {
      return;
    }
    if (state.skills.find((skill) => skill.id === selectedSkillId) === undefined) {
      setSelectedSkillId(null);
      resetBrowser();
    }
  }, [selectedSkillId, state.skills]);

  useEffect(() => {
    if (selectedSkillId === null) {
      return;
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        handleCloseDrawer();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedSkillId]);

  let drawerNode: React.ReactNode = null;
  if (selectedSkill !== null) {
    const treeEntries = browser.rootEntries ?? [];
    const treeNodes = flattenTreeEntries<SkillFileEntry>(treeEntries, browser.expandedDirectories, browser.directoryChildren);
    const treeView = (
      <>
        {treeNodes.map(({ entry, depth }) => (
          <TreeItem
            active={browser.selectedFilePath === entry.relativePath}
            depth={depth}
            expanded={browser.expandedDirectories.has(entry.relativePath)}
            entry={entry}
            key={entry.relativePath}
            onClick={
              entry.type === 'file'
                ? () => void openFilePreview(entry.relativePath)
                : () => void toggleDirectory(entry.relativePath)
            }
          />
        ))}
      </>
    );
    const previewView =
      browser.preview === null ? (
        <div className="muted" data-testid="skill-drawer-no-preview">
          {browser.loadingPreview ? '正在读取文件…' : '请选择左侧文件以预览。'}
        </div>
      ) : isImagePreview(browser.preview) ? (
        <div className="workbench-file-image-stage" data-testid="skill-drawer-image">
          <img
            alt={browser.preview.relativePath}
            className="workbench-file-image-preview"
            src={browser.preview.content}
          />
        </div>
      ) : browser.preview.kind === 'binary' ? (
        <div className="muted" data-testid="skill-drawer-binary">
          二进制文件，无法直接预览。
        </div>
      ) : (
        <pre data-testid="skill-drawer-text">{previewTextBody(browser.preview)}</pre>
      );
    drawerNode = (
      <SkillDrawer
        key={selectedSkill.id}
        skill={selectedSkill}
        state={browser}
        busy={busySkillId === selectedSkill.id}
        treeView={treeView}
        previewView={previewView}
        onClose={handleCloseDrawer}
        onToggle={() => void setSkillEnabled(selectedSkill.id, !selectedSkill.enabled)}
        onDelete={() => void deleteSkill(selectedSkill.id)}
      />
    );
  }

  return (
    <SkillControlView
      drawer={<AnimatePresence>{drawerNode}</AnimatePresence>}
      model={model}
      selectedSkillId={selectedSkillId}
      onFilterChange={(nextFilter) => setFilter(nextFilter)}
      onSelectSkill={handleSelectSkill}
    />
  );
}
