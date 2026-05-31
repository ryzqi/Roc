import { describe, expect, it } from 'vitest';
import { CommandRewriter, RTKBinaryManager, createRTKMiddleware } from '../../src/rtk-integration';

describe('rtk-integration exports', () => {
  it('exports the public RTK integration API', () => {
    expect(RTKBinaryManager).toBeTypeOf('function');
    expect(CommandRewriter).toBeTypeOf('function');
    expect(createRTKMiddleware).toBeTypeOf('function');
  });
});
