import {useCallback, useEffect, useRef, useState} from 'react';
import type {RocClient} from '../shared/roc-client';
import type {LiteratureStore} from '../literature/use-literature-store';
import {useTaskCenter} from '../management/use-task-center';
import {clearAssistantComposerDraft} from '../assistant/composer-draft';
import type {AppRouteController} from './use-app-route';
import {recordUxEvent} from './ux-metrics';

/** Selects existing runs and hands drafts to the assistant; never starts or resumes a run. */
export function useRunAttentionController(client: RocClient, {route, navigate}: AppRouteController,
  workspacePath: string | null, literature: LiteratureStore) {
  const routeRef = useRef(route);
  routeRef.current = route;
  const taskCenter = useTaskCenter(client, route.projectId, workspacePath);
  const [researchTaskSelection, setResearchTaskSelection] = useState<{projectId: string; taskId: string} | null>(null);
  const [taskCenterRequestId, setTaskCenterRequestId] = useState(0);
  const [assistantThreadId, setAssistantThreadId] = useState<string | null>(null);
  const [assistantRunning, setAssistantRunning] = useState(false);
  const [assistantMounted, setAssistantMounted] = useState(false);
  const [assistantSeed, setAssistantSeed] = useState<{text: string; nonce: number} | null>(null);
  const assistantSeedNonceRef = useRef(0);
  const seedAssistant = useCallback((text: string): void => {
    setAssistantSeed({text, nonce: ++assistantSeedNonceRef.current});
  }, []);
  const selectTask = useCallback((projectId: string, taskId: string): void => {
    setResearchTaskSelection({projectId, taskId});
  }, []);
  const showAllTasks = useCallback((): void => {
    setResearchTaskSelection(null);
    setTaskCenterRequestId(current => current + 1);
    recordUxEvent('action_initiated', 'tasks');
  }, []);
  const deleteThread = useCallback((threadId: string): void => {
    clearAssistantComposerDraft(routeRef.current.projectId, threadId);
    setAssistantThreadId(current => current === threadId ? null : current);
  }, []);
  useEffect(() => {
    setAssistantThreadId(null);
    setAssistantRunning(false);
  }, [route.projectId]);
  useEffect(() => {
    if (route.projectId !== null && route.assistantOpen) setAssistantMounted(true);
  }, [route.projectId, route.assistantOpen]);

  // A literature action may already have created a run; adopt its thread for event replay.
  const literatureAssistantThreadId = literature.assistant.threadId;
  useEffect(() => {
    if (literatureAssistantThreadId === null) return;
    setAssistantThreadId(literatureAssistantThreadId);
    navigate({...route, assistantOpen: true});
    literature.adoptAssistantThread();
  }, [literature, literatureAssistantThreadId, navigate, route]);

  useEffect(() => {
    const onInlineSelectionCommand = (event: Event): void => {
      const detail = (event as CustomEvent<{action?: string; context?: {filePath?: string; selectionText?: string; lineRange?: {start: number; end: number} | null}}>).detail;
      const context = detail.context;
      if (context === undefined || typeof context.filePath !== 'string' || typeof context.selectionText !== 'string' || context.selectionText.trim().length === 0) return;
      const actionLabel: Record<string, string> = {
        explain: '解释这段内容', polish: '学术润色这段内容', 'extract-citation': '提取这段内容的引用', 'send-to-assistant': '处理这段内容'
      };
      const range = context.lineRange === null || context.lineRange === undefined ? '' : `（第 ${context.lineRange.start}–${context.lineRange.end} 行）`;
      seedAssistant(`${actionLabel[detail.action ?? 'send-to-assistant'] ?? '处理这段内容'}。\n文件：${context.filePath}${range}\n\n选中文本：\n${context.selectionText}`);
      navigate({...routeRef.current, assistantOpen: true});
    };
    window.addEventListener('roc:inline-selection-command', onInlineSelectionCommand);
    return () => window.removeEventListener('roc:inline-selection-command', onInlineSelectionCommand);
  }, [navigate, seedAssistant]);

  return {taskCenter, taskCenterRequestId, assistantThreadId, setAssistantThreadId, assistantRunning, setAssistantRunning,
    assistantMounted, assistantSeed, setAssistantSeed, seedAssistant, selectTask, showAllTasks, deleteThread,
    researchTaskId: researchTaskSelection?.projectId === route.projectId ? researchTaskSelection.taskId : null};
}

export type RunAttentionController = ReturnType<typeof useRunAttentionController>;
