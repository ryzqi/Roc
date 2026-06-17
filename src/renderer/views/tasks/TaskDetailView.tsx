import { useMemo, useRef, useState } from 'react';
import type { ChatResumeDecision } from '../../../shared/types';
import type { ChatRunState } from '../../chat-run-state';
import { buildPersistedTranscriptMessages } from '../../chat-transcript';
import { ChatTranscriptPanel } from '../../chat/chat-transcript-panel';
import type { LoadedState } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';

export type TaskDetailApprovalRequest = {
  runId: string;
  threadId: string;
  interruptId: string;
  decisions: ChatResumeDecision[];
};

export function TaskDetailView({
  liveTaskRun,
  onApprovalDecision,
  onBackToBoard,
  onSubmitTaskInput,
  state,
  taskId
}: {
  client: RocClient;
  liveTaskRun: ChatRunState | null;
  onApprovalDecision: (request: TaskDetailApprovalRequest) => Promise<{ ok: true } | { ok: false; error: string }>;
  onBackToBoard: () => void;
  onSubmitTaskInput: (payload: { input: string; taskId: string }) => Promise<{ ok: true } | { ok: false; error: string }>;
  state: LoadedState;
  taskId: string;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
}): React.JSX.Element {
  const [followupInput, setFollowupInput] = useState('');
  const [inlineError, setInlineError] = useState<string | null>(null);
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);
  const detail = state.taskDetail;
  const transcript = useMemo(() => {
    if (detail === null) {
      return [];
    }
    return buildPersistedTranscriptMessages(detail.recentEvents, detail.threadId);
  }, [detail]);

  if (detail === null || detail.taskId !== taskId) {
    return (
      <section className="canvas-stage task-detail-page" data-testid="task-detail-view">
        <button className="action-button" type="button" onClick={onBackToBoard}>
          返回任务工作台
        </button>
        <div className="section-empty-state">
          <strong>任务不存在</strong>
          <p>当前任务不存在或已经删除。</p>
        </div>
      </section>
    );
  }

  const waitingUser = detail.thread.status === 'waiting_user';
  const liveSignal = `${liveTaskRun?.runId ?? ''}|${transcript.length}`;

  async function submitFollowup(): Promise<void> {
    const input = followupInput.trim();
    if (input.length === 0) {
      setInlineError('请输入继续任务的内容。');
      return;
    }
    const result = await onSubmitTaskInput({ input, taskId });
    if (result.ok) {
      setFollowupInput('');
      setInlineError(null);
      return;
    }
    setInlineError(result.error);
  }

  return (
    <section className="canvas-stage task-detail-page" data-testid="task-detail-view">
      <div className="task-detail-page-head">
        <button className="action-button" type="button" onClick={onBackToBoard}>
          返回任务工作台
        </button>
        <div className="page-copy">
          <h1 className="page-title mini">{detail.thread.title}</h1>
          <p className="page-meta">{detail.thread.status}</p>
        </div>
      </div>
      <div className="task-detail-page-body" ref={transcriptScrollRef}>
        <ChatTranscriptPanel
          messages={transcript}
          liveSignal={liveSignal}
          scrollContainerRef={transcriptScrollRef}
          onApprovalDecision={(interruptId, decisions) => {
            if (detail.lastRunId === null) {
              setInlineError('当前没有可恢复的审批运行。');
              return;
            }
            void onApprovalDecision({
              runId: detail.lastRunId,
              threadId: detail.threadId,
              interruptId,
              decisions
            }).then((result) => {
              if (result.ok) {
                setInlineError(null);
              } else {
                setInlineError(result.error);
              }
            });
          }}
        />
        {waitingUser ? (
          <form
            className="task-detail-followup"
            onSubmit={(event) => {
              event.preventDefault();
              void submitFollowup();
            }}
          >
            <textarea
              data-testid="task-detail-followup-input"
              value={followupInput}
              onChange={(event) => setFollowupInput(event.target.value)}
            />
            <button className="action-button" data-testid="task-detail-followup-submit" type="submit">
              继续任务
            </button>
          </form>
        ) : null}
        {inlineError === null ? null : <span className="inline-warning">{inlineError}</span>}
      </div>
    </section>
  );
}
