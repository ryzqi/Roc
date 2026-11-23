import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {RocClient} from '../shared/roc-client';
import type {ArtifactInspectorSelection, OpenResearchArtifact, OpenReviewInspector} from '../artifacts/artifact-interactions';
import {requestArtifactInspectorChange} from '../artifacts/artifact-interactions';
import type {ArtifactReadingLocations} from '../artifacts/artifact-reading-location';
import {useReviewProtocolDraftGuard, type ReviewProtocolDrafts} from '../artifacts/review-protocol-draft';
import {useGitCommitDraftGuard, type GitCommitDrafts} from '../canvas/git/git-commit-draft';
import {BEFORE_NAVIGATE, type NavigationRequest} from './navigation-guard';
import {isDrawerSectionId, type DrawerSectionId, type MenuIntent} from '../../shared/surfaces';
import {DEFAULT_VIEW, routeForMenuIntent, routeForView, type AppViewTarget} from './routes';
import {useMenuIntentBridge, type AppRouteController} from './use-app-route';
import type {LayoutPersistence} from './useLayoutPersistence';
import {dismissOnboarding, readOnboardingDismissed} from './ui-state';
import type {WorkspaceScope, LiteratureOpenRequest, LiteratureOpenTarget} from './workspace-scope';
import type {ManagementTabId} from '../management/use-management-stores';
import type {ManagementScope} from '../management/management-scope';
import {requestManagementEditorChange} from '../management/management-interactions';
import {useSearchGroups} from '../shell/use-search-groups';
import {recordUxEvent} from './ux-metrics';
import type {WorkspaceController} from './workspace-controller';
import type {RunAttentionController} from './run-attention-controller';

/**
 * Owns transient panels and object-opening commands. The route remains authoritative;
 * related selection, nonce and close actions commit only in the existing guard callbacks.
 * Draft maps outlive the overlays that display them.
 */
export function usePanelController(client: RocClient, {route, navigate}: AppRouteController,
  layout: LayoutPersistence, workspace: WorkspaceController, attention: RunAttentionController) {
  const routeRef = useRef(route);
  routeRef.current = route;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const {projectName, projectWritable, boundWorkspace, literature, conceptRows} = workspace;
  const {taskCenter, taskCenterRequestId, researchTaskId, setAssistantThreadId, seedAssistant, selectTask, showAllTasks, adoptAcceptedRun} = attention;
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchToken, setSearchToken] = useState(0);
  const openSearch = useCallback((): void => {
    setSearchToken(current => current + 1);
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
  const [filePreview, setFilePreview] = useState<{relativePath: string; nonce: number} | null>(null);
  const previewNonceRef = useRef(0);
  const [literatureRequest, setLiteratureRequest] = useState<LiteratureOpenRequest | null>(null);
  const literatureRequestNonce = useRef(0);
  const [managementMounted, setManagementMounted] = useState(false);
  const [settingsMounted, setSettingsMounted] = useState(false);
  const settingsOpen = route.page === 'settings';
  const gitDrawerOpen = route.tool === 'git';
  const [firstStepsVisible, setFirstStepsVisible] = useState(() => !readOnboardingDismissed());
  const [firstStepsRequestId, setFirstStepsRequestId] = useState(0);
  useEffect(() => {setArtifactSelection(null); setFilePreview(null);}, [route.projectId]);
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
      navigate({...routeRef.current, assistantOpen: false}, {onNavigated: () => {
        if (layoutRef.current.drawerFloating) layoutRef.current.setDrawerOpen(false);
        setArtifactSelection(selection);
        onOpened?.();
      }});
    });
  }, [navigate, route.projectId]);
  const openArtifact = useCallback<OpenResearchArtifact>((request, onReviewContext): void => {
    showArtifactSelection({kind: 'stage', request, onReviewContext});
  }, [showArtifactSelection]);
  const openReviewInspector = useCallback<OpenReviewInspector>((request): void => {
    showArtifactSelection({kind: 'review', request});
  }, [showArtifactSelection]);
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
        showAllTasks();
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
  }, [navigate, openView, showAllTasks]);
  const openTask = useCallback((projectId: string, taskId: string, closeArtifact = false): void => {
    if (routeRef.current.projectId !== projectId) return;
    openView('runs', () => {
      selectTask(projectId, taskId);
      if (closeArtifact) setArtifactSelection(null);
    });
  }, [openView, selectTask]);
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

  // Native menu, tray and global-hotkey intents use the same guarded actions as the window.
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

  // Stable canvas scope prevents unrelated panel state from rerendering every retained view.
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
      openAssistant,
      adoptAcceptedRun
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
      openAssistant,
      adoptAcceptedRun
    ]
  );

  // Drawer and task canvas share selection and commands. Deferred actions read the latest route.
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
      researchTaskId,
      onSelectResearchTask: (taskId) => {
        const projectId = routeRef.current.projectId;
        if (projectId === null) throw new Error('research_task_project_required');
        requestManagementEditorChange(() => {
          if (routeRef.current.projectId === projectId) selectTask(projectId, taskId);
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
            seedAssistant(prompt);
            setManagementOpen(false);
          }});
        });
      },
      openSettings
    }),
    [client, route.projectId, boundWorkspace.path, taskCenter, taskCenterRequestId, openLiterature, navigate, researchTaskId, showArtifactSelection, openSettings, selectTask, seedAssistant, setAssistantThreadId]
  );
  const managementStoresScopeKey = JSON.stringify([managementScope.projectId, managementScope.workspacePath]);
  const managementStoresEnabled =
    managementMounted || route.view === 'runs' ||
    (route.tool !== null && isDrawerSectionId(route.tool));

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

  return {scope, managementScope, managementStoresScopeKey, managementStoresEnabled,
    searchOpen, searchQuery, setSearchOpen, setSearchQuery, searchGroups, openSearch,
    artifactSelection, setArtifactSelection, artifactReadingLocations, reviewProtocolDrafts,
    gitCommitDrafts, gitBusy, registerGitBusy, gitDrawerOpen,
    managementMounted, managementOpen, managementTab, setManagementTab, closeManagement,
    settingsMounted, settingsOpen, filePreview, setFilePreview, setFirstStepsVisible,
    openProject, selectThread, openView, openFileInCanvas, openLiterature, openFirstSteps,
    openSettings, openAssistant, openManagementSection, openTask, openArtifact, openReviewInspector};
}
