import { LazyBoundary, retryableLazy } from '../shell/LazyBoundary';
import { DelayedFallback } from '../shell/DelayedFallback';
import { ModalShell } from '../shell/ModalShell';
import { SearchPaletteModal } from '../shell/SearchPaletteModal';
import type { ArtifactInspectorSelection } from '../artifacts/artifact-interactions';
import type { ArtifactReadingLocations } from '../artifacts/artifact-reading-location';
import type { ReviewProtocolDrafts } from '../artifacts/review-protocol-draft';
import type { GitCommitDrafts } from '../canvas/git/git-commit-draft';
import type { ManagementTabId } from '../management/use-management-stores';
import type { RocClient } from '../shared/roc-client';
import type { AppRoute } from './routes';
import type { NavigateOptions } from './use-app-route';
import type { SettingsModalProps } from '../settings/SettingsModal';

const SettingsModal = retryableLazy(async () => ({ default: (await import('../settings/SettingsModal')).SettingsModal }));
const ManagementPanel = retryableLazy(async () => ({ default: (await import('../management/ManagementPanel')).ManagementPanel }));
const GitPanel = retryableLazy(async () => ({ default: (await import('../canvas/git/GitPanel')).GitPanel }));
const ArtifactInspector = retryableLazy(async () => ({ default: (await import('../artifacts/ArtifactInspector')).ArtifactInspector }));

type Navigate = (next: AppRoute, options?: NavigateOptions) => void;

export type OverlayHostProps = {
  client: RocClient;
  route: AppRoute;
  navigate: Navigate;
  projectWritable: boolean;
  workspacePath: string | null;
  settingsMounted: boolean;
  settingsOpen: boolean;
  themeOverride: SettingsModalProps['themeOverride'];
  onThemeOverrideChange: SettingsModalProps['onThemeOverrideChange'];
  onResetUiPreferences: SettingsModalProps['onResetUiPreferences'];
  onCloseSettings: () => void;
  searchOpen: boolean;
  searchQuery: string;
  onCloseSearch: () => void;
  onSearchQueryChange: (query: string) => void;
  searchGroups: React.ComponentProps<typeof SearchPaletteModal>['groups'];
  artifactSelection: ArtifactInspectorSelection | null;
  artifactReadingLocations: ArtifactReadingLocations;
  reviewProtocolDrafts: ReviewProtocolDrafts;
  onCloseArtifact: () => void;
  onOpenTask: (projectId: string, taskId: string, closeArtifact?: boolean) => void;
  managementMounted: boolean;
  managementOpen: boolean;
  managementTab: ManagementTabId;
  onCloseManagement: () => void;
  onManagementTabChange: (tab: ManagementTabId) => void;
  gitDrawerOpen: boolean;
  gitBusy: { current: (() => boolean) | null };
  commitDrafts: GitCommitDrafts;
  onGitBusyChange: (read: (() => boolean) | null) => void;
};

/** Mount-on-demand overlay owner. Lazy identities and state latches stay outside AppShell wiring. */
export function OverlayHost(props: OverlayHostProps): React.JSX.Element {
  const {
    client, route, navigate, projectWritable, workspacePath,
    settingsMounted, settingsOpen, themeOverride, onThemeOverrideChange, onResetUiPreferences, onCloseSettings,
    searchOpen, searchQuery, onCloseSearch, onSearchQueryChange, searchGroups,
    artifactSelection, artifactReadingLocations, reviewProtocolDrafts, onCloseArtifact, onOpenTask,
    managementMounted, managementOpen, managementTab, onCloseManagement, onManagementTabChange,
    gitDrawerOpen, gitBusy, commitDrafts, onGitBusyChange
  } = props;
  return <>
    {settingsMounted ? <LazyBoundary active={settingsOpen} label="设置加载失败" fallback={<DelayedFallback label="正在加载设置…" />}
      renderError={content => <ModalShell open={settingsOpen} title="设置" testId="settings-load" onClose={onCloseSettings}>{content}</ModalShell>}>
      <SettingsModal open={settingsOpen} client={client} projectId={route.projectId} workspacePath={workspacePath}
        themeOverride={themeOverride} onThemeOverrideChange={onThemeOverrideChange}
        onResetUiPreferences={onResetUiPreferences} onClose={onCloseSettings} />
    </LazyBoundary> : null}

    <SearchPaletteModal open={searchOpen} onClose={onCloseSearch} query={searchQuery}
      onQueryChange={onSearchQueryChange} groups={searchGroups} />

    {artifactSelection === null || artifactSelection.request.projectId !== route.projectId ? null : (
      <LazyBoundary label="工件检查器加载失败" resetKey={JSON.stringify(artifactSelection.request)}
        fallback={<DelayedFallback label="正在加载工件检查器…" />}
        renderError={content => <ModalShell open kind="drawer" title="工件检查器" testId="artifact-load" onClose={onCloseArtifact}>{content}</ModalShell>}>
        <ArtifactInspector key={JSON.stringify(artifactSelection.request)} client={client} selection={artifactSelection}
          writable={projectWritable} readingLocations={artifactReadingLocations} reviewDrafts={reviewProtocolDrafts}
          onClose={onCloseArtifact} onOpenTask={taskId => onOpenTask(artifactSelection.request.projectId, taskId, true)} />
      </LazyBoundary>
    )}

    {managementMounted ? <LazyBoundary active={managementOpen} label="管理面板加载失败" fallback={<DelayedFallback label="正在加载管理面板…" />}
      renderError={content => <ModalShell open={managementOpen} kind="drawer" title="管理" testId="mgmt-load" onClose={onCloseManagement}>{content}</ModalShell>}>
      <ManagementPanel open={managementOpen} onClose={onCloseManagement} activeTab={managementTab} onTabChange={onManagementTabChange} />
    </LazyBoundary> : null}

    <ModalShell open={gitDrawerOpen} kind="drawer" title="Git" beforeClose={() => !gitBusy.current?.()} closeOnBackdrop={false}
      onClose={() => navigate({ ...route, tool: null })} widthClassName="w-[520px]" testId="git-drawer">
      <LazyBoundary label="Git 面板加载失败" resetKey={workspacePath ?? ''} fallback={<DelayedFallback label="正在加载 Git 面板…" />}>
        <GitPanel client={client} workspacePath={workspacePath} writable={projectWritable} commitDrafts={commitDrafts}
          onBusyChange={onGitBusyChange} layout="drawer" />
      </LazyBoundary>
    </ModalShell>
  </>;
}
