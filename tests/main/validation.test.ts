import { describe, expect, it } from 'vitest';
import { RocDomainError } from '../../src/main/services/errors';
import { requireText } from '../../src/main/services/validation';

describe('main validation helper', () => {
  it('trims non-empty text and throws the provided validation error contract for empty text', () => {
    expect(requireText('  alpha  ', 'text_empty', '文本不能为空。', '请填写文本。')).toBe('alpha');

    expect(() => requireText('   ', 'text_empty', '文本不能为空。', '请填写文本。')).toThrowError(
      expect.objectContaining<Partial<RocDomainError>>({
        code: 'text_empty',
        message: '文本不能为空。',
        category: 'validation',
        retryable: false,
        userAction: '请填写文本。'
      })
    );
  });
});
