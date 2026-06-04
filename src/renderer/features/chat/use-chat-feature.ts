import { useMemo } from 'react';
import type { ChatResumeRunRequest, ChatRunEvent, ChatStartRunRequest } from '../../../shared/types';
import type { RocClient } from '../../shared/roc-client';

export interface ChatFeatureActions {
  cancelRun: (runId: string) => ReturnType<RocClient['api']['chat']['cancelRun']>;
  resumeRun: (request: ChatResumeRunRequest) => ReturnType<RocClient['api']['chat']['resumeRun']>;
  startRun: (request: ChatStartRunRequest) => ReturnType<RocClient['api']['chat']['startRun']>;
  subscribeRunEvents: (listener: (event: ChatRunEvent) => void) => () => void;
}

export function createChatFeatureActions(client: RocClient): ChatFeatureActions {
  return {
    cancelRun: (runId) => client.api.chat.cancelRun(runId),
    resumeRun: (request) => client.api.chat.resumeRun(request),
    startRun: (request) => client.api.chat.startRun(request),
    subscribeRunEvents: (listener) => client.api.chat.onRunEvent(listener)
  };
}

export function useChatFeature(client: RocClient): ChatFeatureActions {
  return useMemo(() => createChatFeatureActions(client), [client]);
}
