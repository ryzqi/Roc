export function retryNudge(_rawResponse: string): string {
  return ['你上一条回复不是合法的工具调用。', '在当前回合中必须用工具调用回应，不要输出自由文本。', '请重新生成一条合法的工具调用。'].join('\n');
}

export function unknownToolNudge(toolName: string, availableTools: readonly string[]): string {
  return [`工具 ${toolName} 不存在。`, `当前可用工具：${availableTools.join('、')}。`, '请从上述工具中选择一个调用。'].join('\n');
}

export function stepNudge(attemptedTerminal: string, pendingSteps: readonly string[], tier: 1 | 2 | 3): string {
  const steps = pendingSteps.join('、');
  if (tier === 1) {
    return [`还不能调用 ${attemptedTerminal}。`, `必须先完成这些步骤：${steps}。`, '请立即调用其中之一。'].join('\n');
  }
  if (tier === 2) {
    return [`必须立刻调用以下工具之一：${steps}。请选择一个。`].join('\n');
  }
  return [`停止。必须调用以下工具之一：${steps}。`, `不要调用 ${attemptedTerminal}。`, '下一条回复必须是上述工具之一的调用。'].join('\n');
}

export function prerequisiteNudge(toolName: string, missingPrereqs: readonly string[]): string {
  return [`还不能调用 ${toolName}。`, `必须先调用：${missingPrereqs.join('、')}。`, '请立即调用前置工具。'].join('\n');
}

export function contextWarning(tokens: number, budget: number): string | null {
  if (budget <= 0) {
    return null;
  }
  const pct = tokens / budget;
  if (pct >= 0.8) {
    return `[Context usage: ${(pct * 100).toFixed(0)}% (${tokens} / ${budget} tokens). 上下文接近上限。旧的工具结果与推理可能很快被压缩——请尽快总结关键发现并优先完成当前任务。]`;
  }
  if (pct >= 0.65) {
    return `[Context usage: ${(pct * 100).toFixed(0)}% (${tokens} / ${budget} tokens). 上下文使用增高。压缩触发后旧的工具结果与推理会被精简。请简洁回应、优先表达重要信息。]`;
  }
  return null;
}
