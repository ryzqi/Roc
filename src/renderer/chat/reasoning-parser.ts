/**
 * 推理内容解析器
 *
 * 将纯文本推理内容解析为结构化的推理步骤，便于交互式展示
 */

export type ReasoningStepType = 'observation' | 'analysis' | 'plan' | 'decision' | 'reflection' | 'unknown';

export type ReasoningStep = {
  id: string;
  type: ReasoningStepType;
  content: string;
  lineNumber: number;
  timestamp: number;
};

/**
 * 解析推理内容为结构化步骤
 */
export function parseReasoningContent(raw: string): ReasoningStep[] {
  const lines = raw.split('\n');
  const steps: ReasoningStep[] = [];

  interface CurrentStep {
    type: ReasoningStepType;
    lines: string[];
    startLine: number;
  }

  let currentStep: CurrentStep | null = null;

  const finishCurrentStep = (): void => {
    if (currentStep !== null && currentStep.lines.length > 0) {
      steps.push({
        id: `step-${steps.length}`,
        type: currentStep.type,
        content: currentStep.lines.join('\n').trim(),
        lineNumber: currentStep.startLine,
        timestamp: Date.now() + steps.length,
      });
    }
  };

  lines.forEach((line, index) => {
    const trimmed = line.trim();

    // 空行处理：结束当前步骤
    if (trimmed.length === 0) {
      finishCurrentStep();
      currentStep = null;
      return;
    }

    // 检测新的步骤类型
    const detectedType = detectStepType(trimmed);

    // 如果检测到明确的步骤类型，开始新步骤
    if (detectedType !== 'unknown' && (currentStep === null || currentStep.type !== detectedType)) {
      finishCurrentStep();
      currentStep = {
        type: detectedType,
        lines: [trimmed],
        startLine: index + 1,
      };
    } else {
      // 继续当前步骤
      if (currentStep === null) {
        currentStep = {
          type: 'unknown',
          lines: [trimmed],
          startLine: index + 1,
        };
      } else {
        currentStep.lines.push(trimmed);
      }
    }
  });

  // 处理最后一个步骤
  finishCurrentStep();

  return steps;
}

/**
 * 检测单行文本的步骤类型
 */
function detectStepType(line: string): ReasoningStepType {
  const lower = line.toLowerCase();

  // 观察类
  if (
    lower.startsWith('观察') ||
    lower.startsWith('注意到') ||
    lower.startsWith('发现') ||
    lower.includes('observe') ||
    lower.includes('notice') ||
    lower.includes('find that')
  ) {
    return 'observation';
  }

  // 分析类
  if (
    lower.startsWith('分析') ||
    lower.startsWith('考虑') ||
    lower.startsWith('评估') ||
    lower.includes('analyze') ||
    lower.includes('consider') ||
    lower.includes('evaluate') ||
    lower.includes('examine')
  ) {
    return 'analysis';
  }

  // 计划类
  if (
    lower.startsWith('计划') ||
    lower.startsWith('我将') ||
    lower.startsWith('接下来') ||
    lower.startsWith('步骤') ||
    lower.includes('plan to') ||
    lower.includes('will') ||
    lower.includes('next step') ||
    lower.includes('approach')
  ) {
    return 'plan';
  }

  // 决策类
  if (
    lower.startsWith('决定') ||
    lower.startsWith('选择') ||
    lower.startsWith('确定') ||
    lower.includes('decide') ||
    lower.includes('choose') ||
    lower.includes('determine') ||
    lower.includes('conclude')
  ) {
    return 'decision';
  }

  // 反思类
  if (
    lower.startsWith('反思') ||
    lower.startsWith('总结') ||
    lower.startsWith('回顾') ||
    lower.includes('reflect') ||
    lower.includes('summarize') ||
    lower.includes('in summary') ||
    lower.includes('looking back')
  ) {
    return 'reflection';
  }

  return 'unknown';
}

/**
 * 获取步骤类型的显示标签
 */
export function getStepTypeLabel(type: ReasoningStepType): string {
  const labels: Record<ReasoningStepType, string> = {
    observation: '观察',
    analysis: '分析',
    plan: '计划',
    decision: '决策',
    reflection: '反思',
    unknown: '思考',
  };
  return labels[type];
}

/**
 * 获取步骤类型的颜色
 */
export function getStepTypeColor(type: ReasoningStepType): string {
  const colors: Record<ReasoningStepType, string> = {
    observation: '#3b82f6', // blue
    analysis: '#8b5cf6',    // purple
    plan: '#10b981',        // green
    decision: '#f59e0b',    // amber
    reflection: '#ec4899',  // pink
    unknown: '#6b7280',     // gray
  };
  return colors[type];
}

/**
 * 获取步骤类型的图标
 */
export function getStepTypeIcon(type: ReasoningStepType): string {
  const icons: Record<ReasoningStepType, string> = {
    observation: '👁️',
    analysis: '🔍',
    plan: '📋',
    decision: '✅',
    reflection: '💭',
    unknown: '💡',
  };
  return icons[type];
}
