import type { PreCompactionFlushRecorder } from '../../../../../src/main/services/deep-agent/context/context-compaction-pipeline';

export type RecordedPreCompactionFlush = {
  content: string;
  threadId: string;
  tokenCount: number;
  workspaceHash: string | null;
};

export type FakePreCompactionFlushRecorder = PreCompactionFlushRecorder & {
  readonly flushes: readonly RecordedPreCompactionFlush[];
};

/** 压缩管线只需要"记一次 flush"这一个动作，所以测试替身把调用收进数组供断言，不碰 session_messages 表。 */
export function createFakePreCompactionFlushRecorder(): FakePreCompactionFlushRecorder {
  const flushes: RecordedPreCompactionFlush[] = [];
  return {
    flushes,
    recordPreCompactionFlush(input) {
      flushes.push(input);
    }
  };
}
