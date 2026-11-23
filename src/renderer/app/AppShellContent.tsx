import type {ArtifactInspectorSelection, OpenResearchArtifact, OpenReviewInspector} from '../artifacts/artifact-interactions';
import {requestArtifactInspectorChange} from '../artifacts/artifact-interactions';
import type {ArtifactReadingLocations} from '../artifacts/artifact-reading-location';
import {useReviewProtocolDraftGuard, type ReviewProtocolDrafts} from '../artifacts/review-protocol-draft';
import {useGitCommitDraftGuard, type GitCommitDrafts} from '../canvas/git/git-commit-draft';
import {BEFORE_NAVIGATE, type NavigationRequest} from './navigation-guard';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LazyBoundary, retryableLazy } from '../shell/LazyBoundary';
import type { AppStatus } from '../../shared/types';
import { isDrawerSectionId, type DrawerSectionId, type MenuIntent } from '../../shared/surfaces';
import { errorMessage } from './loaded-state';
import { DEFAULT_VIEW, routeForMenuIntent, routeForView, type AppViewId, type AppViewTarget, type LayoutPreset } from './routes';
import { useMenuIntentBridge, useAppRoute } from './use-app-route';
import { useContentPreferenceSync } from './use-content-preferences';
import { useLayoutPersistence } from './useLayoutPersistence';
import { useKeyboardShortcuts } from './shortcuts';
import { clearUiState, dismissOnboarding, readOnboardingDismissed, recordProjectVisit, CONTENT_PREFERENCES_CHANGED } from './ui-state';
import { ViewContent } from './ViewContent';
import { WorkspaceLayout } from './WorkspaceLayout';
import { WorkspaceScopeProvider, type WorkspaceScope, type LiteratureOpenRequest, type LiteratureOpenTarget } from './workspace-scope';
import { WorkspaceCanvas } from '../canvas/WorkspaceCanvas';
import { clearAssistantComposerDraft } from '../assistant/composer-draft';
import type { ManagementTabId } from '../management/use-management-stores';
import { ManagementScopeProvider, type ManagementScope } from '../management/management-scope';
import { ManagementStoresProvider } from '../management/management-stores-provider';
import { requestManagementEditorChange } from '../management/management-interactions';
import { ProjectPortalView } from '../project/ProjectPortalView';
import { useCurrentProject } from '../project/use-projects';
import { useProjectList } from '../project/use-project-list';
import { useProjectWorkspace } from '../project/use-project-workspace';
import { isProjectWritable } from '../project/project-store';
import type { RocClient } from '../shared/roc-client';
import { DelayedFallback } from '../shell/DelayedFallback';
import { ErrorBar } from '../shell/ErrorBar';
import { ActivityRail } from '../shell/ActivityRail';
import { ContextDrawer } from '../shell/ContextDrawer';
import { useGitSummary } from '../shell/use-git-summary';
import { OverlayHost } from './OverlayHost';
import { useSearchGroups } from '../shell/use-search-groups';
import { StartupFailure, StartupLoading } from '../shell/StartupSurface';
import { WindowChrome } from '../shell/WindowChrome';
import { useThemeSync } from './hooks/useThemeSync';
import { useTaskCenter } from '../management/use-task-center';
import { recordUxEvent } from './ux-metrics';
import type { WindowStateResource } from '../shell/use-window-state';
import { useBoundWorkspace } from '../workspace/use-bound-workspace';
import { LiteratureScopeProvider } from '../literature/literature-scope';
import { useLiteratureStore } from '../literature/use-literature-store';
import { wikiConceptRows } from '../literature/wiki-concepts';

/**
 * The application shell (P1).
 *
 * Responsibilities, in order:
 *   1. boot gate — `app.getStatus` decides loading / failed / ready
 *   2. appearance — system snapshot + in-app override drive the token layer
 *   3. navigation — the URL is the single source of truth; the native
 *      menu arrives through `app.onNavigate`
 *   4. layout — three columns with persisted widths and a drawer breakpoint
 *   5. overlays — settings (URL-driven), search, management, Git
 *
 * Deliberately *not* here: any product data. Projects, literature, files and
 * sessions arrive in P2–P9; this shell proves the frame, the routing contract,
 * focus/Escape layering, and the shortcut split with the native menu.
 *
 * The window's own controls are system traffic lights
 * (`titleBarStyle: 'hiddenInset'`), so nothing is drawn for them.
 */

type BootState =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; appStatus: AppStatus };

/**
 * Lazily loaded overlays and panels.
 *
 * Two things have to be true for these imports, and both are easy to get wrong:
 *
 *   1. **They must be `import()`**, because `check-renderer-chunks.mjs` forbids
 *      `markdown|streamdown|highlight|settings` from the eager graph. The assistant
 *      pulls in the whole Markdown family in P4
 *      and settings pulls in every section in P8, so the boundary has to exist
 *      before those phases land.
 *   2. **They must be mounted on demand.** `React.lazy` starts fetching on first
 *      *render*, not first open, so a lazy element left in the tree with only a
 *      falsy `open` prop still downloads at boot — which would fetch the
 *      assistant's Markdown bundle at startup even though the assistant defaults
 *      to closed. The `latch` below defers the first render until something
 *      actually opens, then keeps the subtree mounted so state and scroll
 *      position survive toggling.
 *
 * The manifest also only inspects *static* imports, so a stray eager import here
 * would pass the check while defeating it. Keeping these lazy is a discipline.
 */
const AssistantPanel = retryableLazy(async () => ({ default: (await import('../assistant/AssistantPanel')).AssistantPanel }));

export function AppShellContent({ client, windowState }: { client: RocClient; windowState: WindowStateResource }): React.JSX.Element {
  const [boot, setBoot] = useState<BootState>({ status: 'loading' });
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  /**
   * Bumped on every palette open so the ⌘K groups re-read what can change while
   * the palette is closed (the project list has no server-side query to key on).
   */
  const [searchToken, setSearchToken] = useState(0);
  const openSearch = useCallback((): void => {
    setSearchToken((current) => current + 1);
    setSearchOpen(true);
  }, []);
  const [artifactSelection, setArtifactSelection] = useState<ArtifactInspectorSelection | null>(null);
  const [artifactReadingLocations] = useState<ArtifactReadingLocations>(() => new Map());
  const [reviewProtocolDrafts] = useState<ReviewProtocolDrafts>(() => new Map());
  useReviewProtocolDraftGuard(reviewProtocolDrafts);
  const [gitCommitDrafts] = useState<GitCommitDrafts>(() => new Map());
  useGitCommitDraftGuard(gitCommitDrafts);
  const gitBusy = useRef<(() => boolean) | null>(null);
  const registerGitBusy = useCallback((read: (() => boolean) | null): void => {gitBusy.current = read;}, []);
  const [managementOpen, setManagementOpen] = useState(false);
  const [managementTab, setManagementTab] = useState<ManagementTabId>('memory');
  const [researchTaskSelection, setResearchTaskSelection] = useState<{ projectId: string; taskId: string } | null>(null);
  const [taskCenterRequestId, setTaskCenterRequestId] = useState(0);
  /**
   * A prompt handed to the assistant's composer by the management drawer (P9/T9.1).
   *
   * The drawer must not start a run itself: run state, the transcript and the HITL cards live in
   * the assistant panel, so a run started from a drawer would be invisible. The nonce makes the
   * hand-off idempotent per request (the same text twice still replaces the draft).
   */
  const [assistantSeed, setAssistantSeed] = useState<{ text: string; nonce: number } | null>(null);
  const assistantSeedNonceRef = useRef(0);
  // The selected conversation lives here because two surfaces need it: the sidebar lists
  // threads, the assistant panel renders one. Cleared when the project changes (gate 6).
  const [assistantThreadId, setAssistantThreadId] = useState<string | null>(null);
  // Mount-on-demand latches; see the lazy block comment above.
  const [assistantMounted, setAssistantMounted] = useState(false);
  /** A file another surface asked the 文件 tab to preview (see `openFileInCanvas`). */
  const [filePreview, setFilePreview] = useState<{ relativePath: string; nonce: number } | null>(null);
  const previewNonceRef = useRef(0);
  const [literatureRequest, setLiteratureRequest] = useState<LiteratureOpenRequest | null>(null);
  const literatureRequestNonce = useRef(0);
  const [managementMounted, setManagementMounted] = useState(false);
  const [settingsMounted, setSettingsMounted] = useState(false);
  const [firstStepsVisible, setFirstStepsVisible] = useState(() => !readOnboardingDismissed());
  const [firstStepsRequestId, setFirstStepsRequestId] = useState(0);

  const { override, setOverride, cycle: cycleTheme } = useThemeSync(client, boot.status === 'ready' ? boot.appStatus.appearance : null);
  const { route, navigate } = useAppRoute();
  useEffect(() => {
    const guardGit = (event: Event): void => {
      if (!gitBusy.current?.()) return;
      const next = (event as CustomEvent<NavigationRequest>).detail.next;
      const current = routeRef.current;
      if (next.projectId !== current.projectId || next.tool !== 'git' || next.view !== current.view) {
        event.preventDefault();
      }
    };
    window.addEventListener(BEFORE_NAVIGATE, guardGit);
    return () => window.removeEventListener(BEFORE_NAVIGATE, guardGit);
  }, []);
  const showArtifactSelection = useCallback((selection: ArtifactInspectorSelection, onOpened?: () => void): void => {
    if (selection.request.projectId !== route.projectId) throw new Error(
      selection.kind === 'stage' ? 'research_artifact_project_mismatch' : 'research_review_project_mismatch');
    requestArtifactInspectorChange(() => {
      if (selection.request.projectId !== routeRef.current.projectId) return;
      setArtifactSelection(selection);
      onOpened?.();
    });
  }, [route.projectId]);
  const openArtifact = useCallback<OpenResearchArtifact>((request, onReviewContext): void => {
    showArtifactSelection({kind: 'stage', request, onReviewContext});
  }, [showArtifactSelection]);
  const openReviewInspector = useCallback<OpenReviewInspector>((request): void => {
    showArtifactSelection({kind: 'review', request});
  }, [showArtifactSelection]);
  const layout = useLayoutPersistence(route.layoutPreset ?? 'research', route.projectId);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  useContentPreferenceSync();

  const previousTool = useRef(route.tool);
  useEffect(() => {
    const geometry = layoutRef.current;
    if (route.tool === 'files') geometry.setDrawerOpen(true);
    else if (previousTool.current === 'files' && geometry.drawerFloating) geometry.setDrawerOpen(false);
    previousTool.current = route.tool;
    if (route.tool !== null && isDrawerSectionId(route.tool)) {
      setManagementTab(route.tool);
      setManagementOpen(true);
    }
  }, [route.projectId, route.tool]);
  const closeManagement = (): void => {
    requestManagementEditorChange(() => {
      setManagementOpen(false);
      if (route.tool !== null && isDrawerSectionId(route.tool)) navigate({...route, tool: null});
    });
  };

  // The chrome and the read-only gate need the real project, not the raw id.
  const currentProject = useCurrentProject(client, route.projectId);
  const projects = useProjectList(client).data ?? [];
  const [assistantRunning, setAssistantRunning] = useState(false);

  const inProject = route.projectId !== null;
  const settingsOpen = route.page === 'settings';
  const project = currentProject.data;
  useEffect(() => {
    if (project !== null && project.id === route.projectId) recordProjectVisit(project.id);
  }, [project?.id, route.projectId]);
  const projectName = project?.title ?? null;
  const projectWritable = isProjectWritable(project);
  /**
   * A project that failed to load must not silently render an empty workspace.
   * Surface the backend message with a retry instead of pretending the
   * project exists (a stale deep link or a deleted project is the common case).
   */
  const projectLoadFailed = inProject && currentProject.status === 'error';

  useEffect(() => {setArtifactSelection(null); setFilePreview(null); setAssistantRunning(false);}, [route.projectId]);

  // A conversation belongs to one project, so a project switch drops the selection.
  useEffect(() => {
    setAssistantThreadId(null);
  }, [route.projectId]);

  const reloadCurrentProject = currentProject.reload;
  const workspaceBinding = useProjectWorkspace(client, project, reloadCurrentProject);
  // T3.1: the project's `workspacePath` is inert data until `workspace.select`
  // scopes the backend to it. Every file/Git/terminal call is keyed on the
  // **bound** path, so a project switch rebuilds all three (gate 6).
  const boundWorkspace = useBoundWorkspace(client, project);
  const gitDrawerOpen = route.tool === 'git';
  const gitSummary = useGitSummary(client, boundWorkspace.path, gitDrawerOpen);
  const taskCenter = useTaskCenter(client, route.projectId, boundWorkspace.path);

  /**
   * The literature store lives here, not in the literature view.
   *
   * The sidebar's 文献 tab and the canvas hub are siblings in different subtrees,
   * and T5.1 requires them to share one state: importing from the canvas must show
   * up in the sidebar, and selecting in one must select in the other. Creating the
   * store once and providing it (like the workspace scope in P3) is what makes
   * "shared" structural rather than a convention.
   */
  const literature = useLiteratureStore(client, route.projectId);

  /**
   * Latest route, readable from callbacks that live inside the memoised scope.
   *
   * `navigate` compares against its own ref and writes the URL, but merging a change
   * into the *current* route needs that route at call time. Reading `route` from the
   * closure would freeze whatever was current when the scope was built: switching the
   * canvas view does not change `projectId`/`openFile`, so the memo would not
   * recompute and 「打开设置中心」 would merge `page=settings` into the view the user
   * had left. (Opening a file had the same shape but overwrites `view`, so it was
   * invisible there.)
   */
  const routeRef = useRef(route);
  routeRef.current = route;

  const openFirstSteps = useCallback((): void => {
    const current = routeRef.current;
    if (current.projectId === null) return;
    navigate({...current, page: 'research', ...routeForView('overview'), tool: null,
      assistantOpen: layoutRef.current.assistantFloating ? false : current.assistantOpen}, {
      mode: 'push', onNavigated: () => {
        if (layoutRef.current.drawerFloating) layoutRef.current.setDrawerOpen(false);
        setFirstStepsVisible(true);
        setFirstStepsRequestId(current => current + 1);
      }
    });
  }, [navigate]);
  const dismissFirstSteps = useCallback((): void => {
    dismissOnboarding();
    setFirstStepsVisible(false);
    recordUxEvent('onboarding_dismissed', 'overview');
  }, []);

  const consumeLiteratureRequest = useCallback((nonce: number): void => {
    setLiteratureRequest(current => current?.nonce === nonce ? null : current);
  }, []);
  const openLiterature = useCallback((target: LiteratureOpenTarget, onOpened?: () => void): void => {
    const projectId = routeRef.current.projectId;
    if (projectId === null) return;
    const proceed = (commitSelection?: () => void): void => {
      if (routeRef.current.projectId !== projectId) return;
      navigate({...routeRef.current, ...routeForView(target.kind === 'concept' ? 'knowledge' : 'library'), tool: null,
        assistantOpen: layoutRef.current.assistantFloating ? false : routeRef.current.assistantOpen}, {
        mode: 'push',
        onNavigated: () => {
          if (layoutRef.current.drawerFloating) layoutRef.current.setDrawerOpen(false);
          commitSelection?.();
          setLiteratureRequest({projectId, nonce: ++literatureRequestNonce.current, target});
          onOpened?.();
        }
      });
    };
    if (target.kind === 'reader') literature.select(target.libraryItemId ?? literature.selectedId, proceed);
    else proceed();
  }, [literature.select, literature.selectedId, navigate]);

  const openFileInCanvas = useCallback((relativePath: string): void => {
    navigate({ ...routeRef.current, ...routeForView('writing'), openFile: relativePath, tool: null,
      assistantOpen: layoutRef.current.assistantFloating ? false : routeRef.current.assistantOpen }, {
      onNavigated: () => {
        layoutRef.current.setDrawerOpen(!layoutRef.current.drawerFloating);
        setFilePreview({ relativePath, nonce: ++previewNonceRef.current });
      }
    });
  }, [navigate]);

  const openView = useCallback((view: AppViewTarget, onNavigated?: () => void): void => {
    requestManagementEditorChange(() => {
      navigate({ ...routeRef.current, page: 'research', ...routeForView(view), tool: null,
        assistantOpen: layoutRef.current.assistantFloating ? false : routeRef.current.assistantOpen }, {
        mode: 'push', onNavigated: () => {
          if (layoutRef.current.drawerFloating) layoutRef.current.setDrawerOpen(false);
          setManagementOpen(false);
          onNavigated?.();
        }
      });
    });
  }, [navigate]);
  const openManagementSection = useCallback((section: DrawerSectionId): void => {
    if (section === 'tasks' && routeRef.current.projectId !== null) {
      openView('runs', () => {
        setResearchTaskSelection(null);
        setTaskCenterRequestId(current => current + 1);
        recordUxEvent('action_initiated', 'tasks');
      });
      return;
    }
    requestManagementEditorChange(() => {
      const current = routeRef.current;
      navigate({ ...current, tool: section }, { onNavigated: () => {
        setManagementTab(section);
        setManagementOpen(true);
      }});
    });
  }, [navigate, openView]);
  const openTask = useCallback((projectId: string, taskId: string, closeArtifact = false): void => {
    if (routeRef.current.projectId !== projectId) return;
    openView('runs', () => {
      setResearchTaskSelection({projectId, taskId});
      if (closeArtifact) setArtifactSelection(null);
    });
  }, [openView]);
  const openSettings = useCallback((): void => {
    requestManagementEditorChange(() => {
      navigate({...routeRef.current, page: 'settings'}, {onNavigated: () => setManagementOpen(false)});
    });
  }, [navigate]);
  const openAssistant = useCallback((): void => {
    requestManagementEditorChange(() => {
      const current = routeRef.current;
      if (current.projectId === null) return;
      navigate({...current, assistantOpen: true}, {onNavigated: () => {
        if (layoutRef.current.drawerFloating) layoutRef.current.setDrawerOpen(false);
        setManagementOpen(false);
      }});
    });
  }, [navigate]);

  /**
   * The shell's handling of the four things the native menu, the tray and the global hotkey can ask
   * for (`src/shared/surfaces.ts` owns the list and the meaning of each).
   *
   * Three of them are pure route changes, so they live in `routes.routeForMenuIntent` where they can
   * be asserted without a renderer. The fourth is 打开任务, and it is the reason this handler exists
   * at all: a route cannot carry "open the management drawer on its 任务 section", and the old
   * implementation expressed that by returning the *current* route — which `navigate`'s
   * `sameAppRoute` early-return then dropped, so the tray item only raised the window while its own
   * comment claimed the drawer was opened. `RoutableMenuIntent` excludes that case at the type
   * level, so this branch cannot be forgotten again.
   */
  const handleMenuIntent = useCallback(
    (intent: MenuIntent): void => {
      if (intent.kind === 'management') {
        openManagementSection(intent.section);
        return;
      }
      navigate(routeForMenuIntent(intent, routeRef.current));
    },
    [navigate, openManagementSection]
  );

  useMenuIntentBridge(client, handleMenuIntent);

  useEffect(() => {
    const onInlineSelectionCommand = (event: Event): void => {
      const detail = (event as CustomEvent<{ action?: string; context?: { filePath?: string; selectionText?: string; lineRange?: { start: number; end: number } | null } }>).detail;
      const context = detail.context;
      if (context === undefined || typeof context.filePath !== 'string' || typeof context.selectionText !== 'string' || context.selectionText.trim().length === 0) return;
      const actionLabel: Record<string, string> = {
        explain: '解释这段内容', polish: '学术润色这段内容', 'extract-citation': '提取这段内容的引用', 'send-to-assistant': '处理这段内容'
      };
      const range = context.lineRange === null || context.lineRange === undefined ? '' : `（第 ${context.lineRange.start}–${context.lineRange.end} 行）`;
      const prompt = `${actionLabel[detail.action ?? 'send-to-assistant'] ?? '处理这段内容'}。\n文件：${context.filePath}${range}\n\n选中文本：\n${context.selectionText}`;
      assistantSeedNonceRef.current += 1;
      setAssistantSeed({ text: prompt, nonce: assistantSeedNonceRef.current });
      navigate({ ...routeRef.current, assistantOpen: true });
    };
    window.addEventListener('roc:inline-selection-command', onInlineSelectionCommand);
    return () => window.removeEventListener('roc:inline-selection-command', onInlineSelectionCommand);
  }, [navigate]);

  /**
   * The canvas data scope (P3). Memoised because every view reads it and a new
   * identity on each render would re-render them all on unrelated shell state
   * changes (the tray label updates on background task ticks).
   */
  const scope = useMemo<WorkspaceScope>(
    () => ({
      client,
      projectId: route.projectId,
      projectTitle: projectName,
      writable: projectWritable,
      workspacePath: boundWorkspace.path,
      workspaceStatus: boundWorkspace.status,
      workspaceError: boundWorkspace.error,
      rebindWorkspace: boundWorkspace.rebind,
      openFile: route.openFile,
      openFileInCanvas,
      openSettings,
      firstStepsVisible,
      firstStepsRequestId,
      openFirstSteps,
      dismissFirstSteps,
      contextDrawerOpen: layout.drawerOpen,
      openView,
      openLiterature,
      literatureRequest: literatureRequest?.projectId === route.projectId ? literatureRequest : null,
      consumeLiteratureRequest,
      tool: route.tool,
      openTool: (tool) => navigate({ ...routeRef.current, tool }),
      openTasks: (taskId) => {
        if (taskId !== undefined && route.projectId !== null) openTask(route.projectId, taskId);
        else openManagementSection('tasks');
      },
      openReviewInspector,
      openArtifact,
      openAssistant
    }),
    [
      client,
      route.projectId,
      route.openFile,
      route.tool,
      openView,
      openFileInCanvas,
      openLiterature,
      literatureRequest,
      consumeLiteratureRequest,
      openTask,
      openManagementSection,
      navigate,
      projectName,
      projectWritable,
      layout.drawerOpen,
      boundWorkspace.path,
      boundWorkspace.status,
      boundWorkspace.error,
      boundWorkspace.rebind,
      openSettings,
      firstStepsVisible,
      firstStepsRequestId,
      openFirstSteps,
      dismissFirstSteps,
      openReviewInspector,
      openArtifact,
      openAssistant
    ]
  );

  /**
   * The management scope (P9/T9.5).
   *
   * Built once for the same structural reason as the literature and workflow scopes: the drawer and
   * the three canvas views are siblings in different subtrees, and both need the four datasets plus
   * the two actions that leave the management surface. `routeRef` is read at call time so a
   * hand-off merges into the *current* route rather than the one captured when this memo was built.
   */
  const managementScope = useMemo<ManagementScope>(
    () => ({
      client,
      projectId: route.projectId,
      workspacePath: boundWorkspace.path,
      taskCenter,
      taskCenterRequestId,
      onOpenLiteratureTask: (libraryItemId) => {
        requestManagementEditorChange(() => openLiterature({kind: 'reader', libraryItemId}, () => setManagementOpen(false)));
      },
      researchTaskId: researchTaskSelection?.projectId === route.projectId ? researchTaskSelection.taskId : null,
      onSelectResearchTask: (taskId) => {
        const projectId = routeRef.current.projectId;
        if (projectId === null) throw new Error('research_task_project_required');
        requestManagementEditorChange(() => {
          if (routeRef.current.projectId === projectId) setResearchTaskSelection({projectId, taskId});
        });
      },
      onOpenArtifact: (request, onReviewContext) => {
        requestManagementEditorChange(() => showArtifactSelection(
          {kind: 'stage', request, onReviewContext}, () => setManagementOpen(false)));
      },
      onOpenThread: (threadId) => {
        requestManagementEditorChange(() => {
          navigate({...routeRef.current, assistantOpen: true}, {onNavigated: () => {
            setAssistantThreadId(threadId);
            setManagementOpen(false);
          }});
        });
      },
      onAskAssistant: (prompt) => {
        requestManagementEditorChange(() => {
          navigate({...routeRef.current, assistantOpen: true}, {onNavigated: () => {
            assistantSeedNonceRef.current += 1;
            setAssistantSeed({text: prompt, nonce: assistantSeedNonceRef.current});
            setManagementOpen(false);
          }});
        });
      },
      openSettings
    }),
    [client, route.projectId, boundWorkspace.path, taskCenter, taskCenterRequestId, openLiterature, navigate, researchTaskSelection, showArtifactSelection, openSettings]
  );
  const managementStoresScopeKey = JSON.stringify([managementScope.projectId, managementScope.workspacePath]);
  const managementStoresEnabled =
    managementMounted || route.view === 'runs' ||
    (route.tool !== null && isDrawerSectionId(route.tool));

  /**
   * Concept rows for the ⌘K 概念 group.
   *
   * Uses lightweight titles and citation counts from the same
   * claims/evidence snapshot the store already holds — so the palette cannot claim
   * a concept the panel would not show. Empty until the project's claims/evidence
   * have loaded, which the group's own wording says.
   */
  const conceptRows = useMemo(() => {
    const claims = literature.claims;
    const evidence = literature.evidence;
    if (claims === null || evidence === null) {
      return [];
    }
    return wikiConceptRows(claims, evidence, literature.wikiSnapshot?.relations);
  }, [literature.claims, literature.evidence, literature.wikiSnapshot]);

  const openProject = (projectId: string | null): void => {
    if (projectId === route.projectId) return;
    navigate({ ...route, projectId, ...routeForView(DEFAULT_VIEW), openFile: null, tool: null }, {
      mode: 'push', onNavigated: () => {
        if (layout.drawerFloating) layout.setDrawerOpen(false);
      }
    });
  };
  const selectThread = (threadId: string | null): void => {
    navigate({ ...route, assistantOpen: true }, { onNavigated: () => {
      if (layout.drawerFloating) layout.setDrawerOpen(false);
      setAssistantThreadId(threadId);
    }});
  };
  const searchGroups = useSearchGroups({
    client,
    query: searchQuery,
    workspacePath: boundWorkspace.path,
    openFile: openFileInCanvas,
    projectId: route.projectId,
    libraryItems: literature.items,
    concepts: conceptRows,
    conceptsLoaded: literature.claims !== null && literature.evidence !== null,
    onOpenLiterature: (libraryItemId) => openLiterature({kind: 'reader', libraryItemId}),
    onOpenConcept: (claimId) => openLiterature({kind: 'concept', claimId}),
    onOpenProject: openProject,
    onOpenManagementView: openManagementSection,
    onOpenSession: selectThread,
    searchToken,
    onOpenView: openView
  });

  /**
   * Adopts the thread a literature-triggered run landed in.
   *
   * The reader's 「问助手」 button calls `chat.startRun` (from the shared store) and
   * the run therefore exists **before** the panel is mounted; selecting the thread
   * and opening the panel is what lets P4's `getActiveRun` + event replay pick the
   * running run up. Navigation stays here because the URL has one writer
   * — the store only reports which thread to show.
   */
  const literatureAssistantThreadId = literature.assistant.threadId;
  useEffect(() => {
    if (literatureAssistantThreadId === null) {
      return;
    }
    setAssistantThreadId(literatureAssistantThreadId);
    navigate({ ...route, assistantOpen: true });
    literature.adoptAssistantThread();
  }, [literature, literatureAssistantThreadId, navigate, route]);

  useEffect(() => {
    if (managementOpen || route.view === 'runs') {
      setManagementMounted(true);
    }
  }, [managementOpen, route.view]);

  useEffect(() => {
    if (settingsOpen) {
      setSettingsMounted(true);
    }
  }, [settingsOpen]);

  useEffect(() => {
    if (inProject && route.assistantOpen) {
      setAssistantMounted(true);
    }
  }, [inProject, route.assistantOpen]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await client.api.app.getStatus();
        if (cancelled) {
          return;
        }
        if (!result.ok) {
          setBoot({ status: 'failed', message: result.error.message });
          return;
        }
        setBoot({ status: 'ready', appStatus: result.data });
      } catch (error) {
        if (!cancelled) {
          setBoot({ status: 'failed', message: errorMessage(error) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  const applyLayoutPreset = (next: LayoutPreset): void => {
    if (!inProject) return;
    navigate({ ...route, layoutPreset: next, assistantOpen: next !== 'writing' }, {
      onNavigated: () => layout.applyPreset(next)
    });
  };
  const closeAssistant = (): void => navigate({ ...route, assistantOpen: false });
  const toggleAssistant = (): void => {
    if (!inProject) return;
    const opening = !route.assistantOpen || (layout.mode === 'drawers' && layout.drawerOpen);
    navigate({ ...route, assistantOpen: opening }, { onNavigated: () => {
      if (opening && layout.mode === 'drawers') layout.setDrawerOpen(false);
    }});
  };
  const navigateMode = (view: AppViewId): void => {
    if (!inProject) return;
    if (view === 'runs') openManagementSection('tasks');
    else openView(view);
  };
  const toggleDrawer = (): void => {
    if (inProject) layout.toggleDrawer();
  };
  const resetLayout = (): void => {
    navigate({ ...route, assistantOpen: layout.preset === 'review' }, { onNavigated: layout.reset });
  };
  useKeyboardShortcuts({
    onToggleSidebar: toggleDrawer, onToggleAssistant: toggleAssistant, onOpenSearch: openSearch,
    onCycleTheme: cycleTheme, onLayoutPreset: applyLayoutPreset, onNavigateMode: navigateMode
  });

  if (boot.status === 'loading') {
    return <StartupLoading />;
  }
  if (boot.status === 'failed') {
    return <StartupFailure message={boot.message} />;
  }

  const activityRail = <ActivityRail view={inProject && !projectLoadFailed ? route.view : null}
    onNavigate={navigateMode} themeOverride={override} onCycleTheme={cycleTheme}
    onResetLayout={resetLayout} onOpenSettings={openSettings} />;

  return (
    <ManagementScopeProvider value={managementScope}>
      <ManagementStoresProvider
        enabled={managementStoresEnabled}
        scope={managementScope}
        scopeKey={managementStoresScopeKey}
      >
    <div
      className="app-shell flex h-full w-full flex-col bg-surface-base text-ink-primary"
      data-testid="roc-app"
      data-mode={boot.appStatus.mode}
    >
      {/* Keyboard users can jump the chrome and the sidebar in one Tab.
          Visible only while focused. */}
      <a
        href="#roc-main"
        className="sr-only rounded-control border-[0.5px] border-line bg-surface px-3 py-1 text-ink focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50"
        data-testid="skip-to-canvas"
      >
        跳到内容
      </a>

      <WindowChrome projectName={projectName} projectId={route.projectId} projects={projects}
        onOpenProject={openProject} onBackToPortal={() => openProject(null)} onOpenSearch={openSearch}
        sidebarCollapsed={!layout.drawerOpen} onToggleSidebar={toggleDrawer}
        assistantOpen={route.assistantOpen && !(layout.mode === 'drawers' && layout.drawerOpen)}
        onToggleAssistant={toggleAssistant} assistantRunning={assistantRunning}
        onOpenManagement={() => openManagementSection('memory')}
        onOpenGit={() => navigate({ ...route, tool: 'git' })} branchLabel={gitSummary.branch}
        gitChangeCount={gitSummary.changes} layoutPreset={layout.preset} onChangePreset={applyLayoutPreset} />

      {windowState.error === null ? null : (
        <div className="shrink-0 px-4 pt-2" data-testid="shell-window-state-error">
          <ErrorBar error={{level: 'page', message: `读取窗口状态失败：${windowState.error}`, retry: windowState.reload}} />
        </div>
      )}

      {projectLoadFailed ? (
        <main id="roc-main" className="flex min-h-0 flex-1 flex-col p-4" data-testid="project-load-error" tabIndex={-1}>
          <ErrorBar
            error={{
              level: 'page',
              message: currentProject.error ?? '读取当前科研项目失败',
              retry: currentProject.reload,
              actionLabel: '也可以返回项目列表'
            }}
          />
          <div className="mt-2">
            <button
              type="button"
              data-testid="project-load-error-back"
              onClick={() => openProject(null)}
              className="h-[var(--control-height)] rounded-control border-[0.5px] border-line px-3 text-ink hover:bg-[var(--overlay-hover)] active:bg-[var(--overlay-active)]"
            >
              返回项目列表
            </button>
          </div>
        </main>
      ) : inProject ? (
        // One literature store for the sidebar's 文献 tab and the canvas hub (T5.1):
        // the provider sits *above* the layout so both subtrees read the same state.
        <LiteratureScopeProvider value={literature}>
          <WorkspaceLayout
          layout={layout}
          assistantOpen={route.assistantOpen}
          onCloseAssistant={closeAssistant}
          activityRail={activityRail}
          contextDrawer={
            <ContextDrawer key={route.projectId} view={route.view} client={client} projectId={route.projectId}
              projects={projects} onOpenProject={openProject} binding={boundWorkspace} writable={projectWritable}
              openFile={route.openFile} onOpenFile={openFileInCanvas} previewRequest={filePreview}
              onPreviewRequestConsumed={() => setFilePreview(null)} activeThreadId={assistantThreadId}
              onSelectThread={selectThread} onStartNewThread={() => selectThread(null)}
              onThreadDeleted={(threadId) => {
                clearAssistantComposerDraft(route.projectId, threadId);
                setAssistantThreadId(current => current === threadId ? null : current);
              }}
              onSelectWorkspace={workspaceBinding.bind} workspacePending={workspaceBinding.pending}
              workspaceError={workspaceBinding.error} onOpenHelp={openFirstSteps}
              onOpenWriting={() => openView('writing', () => layoutRef.current.setDrawerOpen(true))}
              onOpenLiterature={libraryItemId => openLiterature({kind: 'reader', libraryItemId})}
              onOpenTasks={() => openManagementSection('tasks')}
              taskLabel={taskCenter.label} taskSummary={taskCenter.summary}
            />
          }
          canvas={
            <div className="flex h-full min-h-0 flex-col">
              {project !== null && !projectWritable ? (
                <p
                  role="note"
                  data-testid="project-readonly-banner"
                  className="shrink-0 border-b-[0.5px] border-line bg-bg-soft px-3 py-1.5 text-[var(--st-warn)] text-[length:var(--font-meta-size)]"
                >
                  项目已归档，仅可阅读：无法启动阶段运行、修改产物或写入文件。恢复项目后才能继续。
                </p>
              ) : null}
              <WorkspaceCanvas activeTab={route.view} subview={route.subview} onTabChange={openView}>
                {/* The scope is what lazily loaded views read; the routing
                    props stay on `ViewContent` (see workspace-scope.tsx). */}
                <WorkspaceScopeProvider value={scope}>
                  <ViewContent key={route.projectId} view={route.view} subview={route.subview} projectId={route.projectId} />
                </WorkspaceScopeProvider>
              </WorkspaceCanvas>
            </div>
          }
          assistant={
            assistantMounted ? (
              <LazyBoundary label="助手加载失败" fallback={<DelayedFallback label="正在加载助手…" motion="lockstep" />}>
                <AssistantPanel
                  client={client}
                  projectId={route.projectId}
                  threadId={assistantThreadId}
                  onThreadIdChange={setAssistantThreadId}
                  showNewThread={route.view !== 'runs' || !layout.drawerOpen}
                  onOpenArtifact={openArtifact}
                  onOpenReviewInspector={openReviewInspector}
                  onOpenTask={(taskId) => {
                    if (route.projectId === null) throw new Error('research_task_project_required');
                     openTask(route.projectId, taskId);
                  }}
                  workspacePath={boundWorkspace.path}
                  projectName={projectName}
                  composerSeed={assistantSeed}
                  onComposerSeedConsumed={() => setAssistantSeed(null)}
                   onOpenSettings={openSettings}
                  // Same handler the divider's double-click and Home key use, so the
                  // header button cannot drift from the drag handle (the shell previously had it
                  // only on the divider).
                  onResetWidth={layout.resetAssistant}
                  onRunActivity={setAssistantRunning}
                />
              </LazyBoundary>
            ) : null
          }
          />
        </LiteratureScopeProvider>
      ) : (
        <div className="flex min-h-0 flex-1">
          {activityRail}
          <main id="roc-main" className="flex min-w-0 min-h-0 flex-1 flex-col" data-testid="portal-column" tabIndex={-1}>
          <ProjectPortalView
            client={client}
            createFormRequested={route.newProject}
            onRequestConsumed={(requested) => navigate({ ...route, newProject: requested })}
            onOpenProject={openProject}
          />
          </main>
        </div>
      )}

      <OverlayHost
        client={client}
        route={route}
        navigate={navigate}
        projectWritable={projectWritable}
        workspacePath={boundWorkspace.path}
        settingsMounted={settingsMounted}
        settingsOpen={settingsOpen}
        themeOverride={override}
        onThemeOverrideChange={setOverride}
        onResetUiPreferences={() => {
          clearUiState();
          window.dispatchEvent(new Event(CONTENT_PREFERENCES_CHANGED));
          setOverride('system');
          setFirstStepsVisible(true);
        }}
        onCloseSettings={() => navigate({ ...route, page: 'research' })}
        searchOpen={searchOpen}
        searchQuery={searchQuery}
        onCloseSearch={() => setSearchOpen(false)}
        onSearchQueryChange={setSearchQuery}
        searchGroups={searchGroups}
        artifactSelection={artifactSelection}
        artifactReadingLocations={artifactReadingLocations}
        reviewProtocolDrafts={reviewProtocolDrafts}
        onCloseArtifact={() => setArtifactSelection(null)}
        onOpenTask={openTask}
        managementMounted={managementMounted}
        managementOpen={managementOpen}
        managementTab={managementTab}
        onCloseManagement={closeManagement}
        onManagementTabChange={setManagementTab}
        gitDrawerOpen={gitDrawerOpen}
        gitBusy={gitBusy}
        commitDrafts={gitCommitDrafts}
        onGitBusyChange={registerGitBusy}
      />
    </div>
      </ManagementStoresProvider>
    </ManagementScopeProvider>
  );
}
