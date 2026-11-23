import {useCallback, useEffect, useRef, useState} from 'react';
import type {WorkspaceScope} from '../app/workspace-scope';
import type {SourceSelection} from './SourceEditor';
import {startPolishRun,verifyPolishSource,type PolishProposal,type PolishSource} from './inline-polish';

export function useInlinePolish(input: {
  scope: WorkspaceScope; canEdit: boolean; filePath: string | null; draft: string; baseline: string | null;
  selection: SourceSelection | null; note: (text: string | null) => void;
}) {
  const live = useRef(input); live.current = input;
  const pending = useRef<{source: PolishSource; dispose: () => void} | null>(null);
  const accepting = useRef(false);
  const [busy,setBusy] = useState(false);
  const [proposal,setProposal] = useState<PolishProposal | null>(null);
  const invalidate = useCallback((): void => {
    pending.current?.dispose(); pending.current = null;
    accepting.current = false;
    setBusy(false); setProposal(null);
  },[]);
  useEffect(() => {
    invalidate();
    return () => {pending.current?.dispose(); pending.current = null;};
  },[input.scope.client,input.scope.projectId,input.scope.workspacePath,input.canEdit,invalidate]);
  const matches = (source: PolishSource): boolean => {
    const current = live.current;
    return current.canEdit && current.scope.writable && current.scope.workspaceStatus === 'bound' &&
      current.scope.projectId === source.projectId && current.scope.workspacePath === source.workspacePath &&
      current.filePath === source.filePath && current.draft === source.draft && current.baseline === source.baseline &&
      current.selection?.from === source.from && current.selection.to === source.to && current.selection.text === source.original;
  };
  const start = async (): Promise<void> => {
    if (pending.current !== null || busy) return;
    const {scope,canEdit,filePath,draft,baseline,selection} = live.current;
    if (!canEdit || !scope.writable || scope.workspaceStatus !== 'bound' || scope.projectId === null ||
        scope.workspacePath === null || filePath === null || baseline === null || selection === null || selection.truncated) return;
    const source: PolishSource = {requestId:crypto.randomUUID(),projectId:scope.projectId,workspacePath:scope.workspacePath,
      filePath,draft,baseline,from:selection.from,to:selection.to,original:selection.text};
    const operation = {source,dispose:():void=>{}};
    pending.current = operation; setBusy(true); setProposal(null);
    const isCurrent = (): boolean => pending.current === operation && matches(source);
    const fail = (message: string): void => {
      if (!isCurrent()) return;
      invalidate(); live.current.note(message);
    };
    live.current.note('正在核对原文件并提交润色…');
    try {
      if (!await verifyPolishSource(scope.client,source,isCurrent)) return;
      const run = startPolishRun(scope.client,source,{
        isCurrent,
        accepted: receipt => {
          if (!isCurrent()) return;
          live.current.note('润色运行已开始，可在助手中查看或停止。');
          live.current.scope.adoptAcceptedRun({projectId:source.projectId,workspacePath:source.workspacePath,receipt});
        },
        completed: result => {
          if (!isCurrent()) return;
          setBusy(false);
          if (result.replacement === source.original) {invalidate();live.current.note('润色结果与原文相同，草稿未修改。');return;}
          setProposal(result);live.current.note('润色建议已就绪，请确认修改。');
        },
        failed: fail
      });
      operation.dispose = run.dispose;
      await run.started;
    } catch (error) {fail(error instanceof Error ? error.message : '润色请求失败。');}
  };
  const accept = async (apply: (source: PolishSource,text: string) => boolean): Promise<void> => {
    if (proposal === null || busy || accepting.current || pending.current?.source !== proposal.source) return;
    const operation = pending.current;
    const isCurrent = (): boolean => pending.current === operation && matches(proposal.source);
    if (!isCurrent()) {invalidate();live.current.note('文稿或选区已变化，请重新润色。');return;}
    accepting.current = true; setBusy(true);
    try {
      if (!await verifyPolishSource(live.current.scope.client,proposal.source,isCurrent)) return;
      if (apply(proposal.source,proposal.replacement)) invalidate();
    } catch (error) {
      if (isCurrent()) {invalidate();live.current.note(error instanceof Error ? error.message : '无法核对原文件。');}
    } finally {if (pending.current === operation) {accepting.current = false;setBusy(false);}}
  };
  return {busy,proposal,start,accept,invalidate};
}
