const PROPOSED_PLAN_OPEN = '<proposed_plan>';
const PROPOSED_PLAN_CLOSE = '</proposed_plan>';

export function extractLastProposedPlan(text: string): string | null {
  let searchEnd = text.length;
  while (searchEnd > 0) {
    const closeIndex = text.lastIndexOf(PROPOSED_PLAN_CLOSE, searchEnd);
    if (closeIndex === -1) {
      return null;
    }
    const openIndex = text.lastIndexOf(PROPOSED_PLAN_OPEN, closeIndex);
    if (openIndex === -1) {
      return null;
    }
    const plan = text.slice(openIndex + PROPOSED_PLAN_OPEN.length, closeIndex).trim();
    if (plan.length > 0) {
      return plan;
    }
    searchEnd = openIndex;
  }
  return null;
}
