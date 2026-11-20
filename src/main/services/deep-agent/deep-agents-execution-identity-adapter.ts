export type DeepAgentsExecutionIdentity = {
  executionPath: string;
  checkpointId: string;
};

export function readDeepAgentsExecutionIdentity(configurable: unknown): DeepAgentsExecutionIdentity | null {
  if (!isRecord(configurable)) {
    return null;
  }
  const checkpointNamespace = configurable.checkpoint_ns;
  const checkpointMap = configurable.checkpoint_map;
  const agentType = configurable.ls_agent_type;
  if (
    typeof checkpointNamespace !== 'string' ||
    !isRecord(checkpointMap) ||
    typeof agentType !== 'string'
  ) {
    return null;
  }
  const agentNamespace = readAgentNamespace(checkpointNamespace);
  if (agentNamespace === null) {
    return null;
  }
  const expectedAgentType = agentNamespace.length === 0 ? 'root' : 'subagent';
  if (agentType !== expectedAgentType) {
    return null;
  }
  const checkpointId = checkpointMap[agentNamespace];
  if (typeof checkpointId !== 'string' || checkpointId.length === 0) {
    return null;
  }
  return {
    executionPath: agentNamespace.length === 0 ? 'main' : `subagent/${agentNamespace}`,
    checkpointId
  };
}

function readAgentNamespace(checkpointNamespace: string): string | null {
  const separatorIndex = checkpointNamespace.lastIndexOf('|');
  if (separatorIndex === 0) {
    return null;
  }
  const toolSegment = separatorIndex === -1
    ? checkpointNamespace
    : checkpointNamespace.slice(separatorIndex + 1);
  if (!toolSegment.startsWith('tools:') || toolSegment.length === 'tools:'.length) {
    return null;
  }
  return separatorIndex === -1 ? '' : checkpointNamespace.slice(0, separatorIndex);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
