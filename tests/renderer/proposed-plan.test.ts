import { describe, expect, it } from 'vitest';

import { extractLastProposedPlan } from '../../src/renderer/chat/proposed-plan';

describe('extractLastProposedPlan', () => {
  it('returns trimmed inner text from a proposed plan block', () => {
    expect(extractLastProposedPlan('before\n<proposed_plan>\n# Plan\n- do it\n</proposed_plan>\nafter')).toBe(
      '# Plan\n- do it'
    );
  });

  it('uses the last complete proposed plan block', () => {
    expect(
      extractLastProposedPlan('<proposed_plan>old</proposed_plan>\ntext\n<proposed_plan>\nnew\n</proposed_plan>')
    ).toBe('new');
  });

  it('returns null when no complete block exists', () => {
    expect(extractLastProposedPlan('<proposed_plan>\nmissing close')).toBeNull();
    expect(extractLastProposedPlan('plain text')).toBeNull();
  });

  it('returns null for an empty proposed plan', () => {
    expect(extractLastProposedPlan('<proposed_plan>   \n </proposed_plan>')).toBeNull();
  });
});
