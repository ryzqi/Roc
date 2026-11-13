// OpenAI completion tool calls become indexed deltas in a streaming response.
export function completionDelta(message: unknown): unknown {
  if (message === null || typeof message !== 'object'
    || !('tool_calls' in message) || !Array.isArray(message.tool_calls)) return message;
  return {
    ...message,
    tool_calls: message.tool_calls.map((call: unknown, index: number) => {
      if (call === null || typeof call !== 'object') throw new Error('evaluation_tool_call_invalid');
      return { ...call, index };
    })
  };
}
