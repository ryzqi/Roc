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
