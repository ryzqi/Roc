import type { ChatRunState } from '../../chat-run-state';
import type { LoadedState } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';

export function TaskDetailView({
  onBackToBoard
}: {
  client: RocClient;
  liveTaskRun: ChatRunState | null;
  onBackToBoard: () => void;
  onSubmitTaskInput: (payload: { input: string; taskId: string }) => Promise<{ ok: true } | { ok: false; error: string }>;
  state: LoadedState;
  taskId: string;
  updateLoadedState: (partial: Partial<LoadedState>) => void;
}): React.JSX.Element {
  return (
    <section className="canvas-stage task-detail-page" data-testid="task-detail-view">
      <button className="action-button" type="button" onClick={onBackToBoard}>
        返回任务工作台
      </button>
    </section>
  );
}
