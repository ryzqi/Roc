import { useEffect } from 'react';

import type { AgentCapabilityPreview } from '../../shared/types';
import { unwrap } from '../loaded-state';
import type { RocClient } from '../shared/roc-client';
import type { AppBootstrap } from './use-app-bootstrap';

interface UseAgentCapabilityPreviewOptions {
  client: RocClient;
  currentAgentExecution: string | null;
  currentSelectedMcpServers: string[];
  currentSelectedSkills: string[];
  setState: AppBootstrap['setState'];
  state: AppBootstrap['state'];
}

export function useAgentCapabilityPreview({
  client,
  currentAgentExecution,
  currentSelectedMcpServers,
  currentSelectedSkills,
  setState,
  state
}: UseAgentCapabilityPreviewOptions): void {
  useEffect(() => {
    if (state === null) {
      return;
    }
    if (currentAgentExecution !== 'ready' || (currentSelectedMcpServers.length === 0 && currentSelectedSkills.length === 0)) {
      setState((current) =>
        current === null || current.agentCapabilityPreview === null
          ? current
          : {
              ...current,
              agentCapabilityPreview: null
            }
      );
      return;
    }

    let cancelled = false;
    void client.api.agent
      .getCapabilityPreview({
        mcpServers: currentSelectedMcpServers,
        skills: currentSelectedSkills
      })
      .then((result) => {
        if (cancelled) {
          return;
        }
        setState((current) =>
          current === null
            ? current
            : {
                ...current,
                agentCapabilityPreview: unwrap<AgentCapabilityPreview>('agent capability preview', result)
              }
        );
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentAgentExecution, currentSelectedMcpServers, currentSelectedSkills]);
}
