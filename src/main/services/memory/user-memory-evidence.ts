import { createHash } from 'node:crypto';

const userClaim = /^(?:user (?:stated|confirmed|selected|chose|requested|asked)|用户(?:明确表示|表示|确认|选择|要求|说))\s*[:：]?\s*/iu;
const quotes = new Map([['"', '"'], ["'", "'"], ['“', '”'], ['「', '」']]);
const normalize = (text: string): string => text.normalize('NFKC').replace(/\s+/gu, ' ').trim();

/** Verifies quoted user text, not semantic entailment of the model's proposed summary. */
export function verifyUserMemoryEvidence(input: {
  type: string;
  evidence: readonly string[];
  userInput: string;
  runId: string;
}): { ok: true; evidence: string[] } | { ok: false; reason: string } {
  const source = normalize(input.userInput);
  const evidence: string[] = [];
  let matched = false;
  for (const item of input.evidence) {
    // Use the same normalization before recognizing and checking a claim; the writer
    // also collapses whitespace, so checking raw prefixes would permit forged claims.
    const normalized = normalize(item);
    if (!userClaim.test(normalized)) { evidence.push(item); continue; }
    const claimed = normalized.replace(userClaim, '').trim();
    const closing = quotes.get(claimed[0]);
    if (closing === undefined || !claimed.endsWith(closing)) return { ok: false, reason: 'user_evidence_quote_required' };
    const quote = normalize(claimed.slice(1, -1));
    if (quote.length === 0 || !source.includes(quote)) return { ok: false, reason: 'user_evidence_not_in_current_input' };
    evidence.push(`user stated: ${JSON.stringify(quote)}`);
    matched = true;
  }
  if (input.type === 'user_preference' && !matched) return { ok: false, reason: 'user_preference_verified_quote_required' };
  if (matched) {
    const digest = createHash('sha256').update(input.userInput).digest('hex');
    evidence.push(`source:run:${input.runId}:user_input:sha256:${digest}`);
  }
  return { ok: true, evidence };
}
