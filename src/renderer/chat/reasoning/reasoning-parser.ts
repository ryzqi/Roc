export type ReasoningStepType = 'observation' | 'analysis' | 'plan' | 'decision' | 'reflection' | 'unknown';

export type ReasoningStep = {
  id: string;
  type: ReasoningStepType;
  content: string;
  lineNumber: number;
  timestamp: number;
};

export function parseReasoningContent(raw: string): ReasoningStep[] {
  const lines = raw.split('\n');
  const steps: ReasoningStep[] = [];

  type CurrentStep = {
    type: ReasoningStepType;
    lines: string[];
    startLine: number;
  };

  let currentStep: CurrentStep | null = null;

  const finishCurrentStep = (): void => {
    if (currentStep !== null && currentStep.lines.length > 0) {
      steps.push({
        id: `step-${steps.length}`,
        type: currentStep.type,
        content: currentStep.lines.join('\n').trim(),
        lineNumber: currentStep.startLine,
        timestamp: Date.now() + steps.length
      });
    }
  };

  lines.forEach((line, index) => {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      finishCurrentStep();
      currentStep = null;
      return;
    }

    const detectedType = detectStepType(trimmed);

    if (detectedType !== 'unknown' && (currentStep === null || currentStep.type !== detectedType)) {
      finishCurrentStep();
      currentStep = {
        type: detectedType,
        lines: [trimmed],
        startLine: index + 1
      };
      return;
    }

    if (currentStep === null) {
      currentStep = {
        type: 'unknown',
        lines: [trimmed],
        startLine: index + 1
      };
      return;
    }

    currentStep.lines.push(trimmed);
  });

  finishCurrentStep();

  return steps;
}

function detectStepType(line: string): ReasoningStepType {
  const lower = line.toLowerCase();

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

export function getStepTypeLabel(type: ReasoningStepType): string {
  const labels: Record<ReasoningStepType, string> = {
    observation: '观察',
    analysis: '分析',
    plan: '计划',
    decision: '决策',
    reflection: '反思',
    unknown: '思考'
  };
  return labels[type];
}

export function getStepTypeColor(type: ReasoningStepType): string {
  const colors: Record<ReasoningStepType, string> = {
    observation: '#2563eb',
    analysis: '#7c3aed',
    plan: '#059669',
    decision: '#d97706',
    reflection: '#db2777',
    unknown: '#6b7280'
  };
  return colors[type];
}
