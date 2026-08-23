import { describe, expect, it } from 'vitest';

import { applyComposerCompletion, detectComposerTrigger } from '../../src/renderer/chat/composer-trigger';

describe('detectComposerTrigger', () => {
  it('detects an @ trigger at the start of the input', () => {
    expect(detectComposerTrigger('@chat', 5)).toEqual({ kind: 'file', query: 'chat', start: 0, end: 5 });
  });

  it('detects an @ trigger after whitespace and reads only up to the caret', () => {
    expect(detectComposerTrigger('解释 @chat-comp 一下', 9)).toEqual({
      kind: 'file',
      query: 'chat-',
      start: 3,
      end: 9
    });
  });

  it('rejects an @ that is glued to a previous word', () => {
    expect(detectComposerTrigger('user@example', 12)).toBeNull();
  });

  it('stops at whitespace between the caret and any trigger character', () => {
    expect(detectComposerTrigger('@src/app.ts 说明', 14)).toBeNull();
  });

  it('returns null when there is no trigger character before the caret', () => {
    expect(detectComposerTrigger('普通消息', 4)).toBeNull();
  });

  it('detects a / trigger at the start of the input', () => {
    expect(detectComposerTrigger('/td', 3)).toEqual({ kind: 'skill', query: 'td', start: 0, end: 3 });
  });

  it('detects the second / when the first token is already a slash command', () => {
    expect(detectComposerTrigger('/tdd /ty', 8)).toEqual({ kind: 'skill', query: 'ty', start: 5, end: 8 });
  });

  it('ignores a / that sits outside the slash command region', () => {
    expect(detectComposerTrigger('修一下 /usr/bin', 11)).toBeNull();
  });

  it('ignores the inner / of a path even when the path starts the input', () => {
    expect(detectComposerTrigger('/usr/bin', 8)).toBeNull();
  });

  it('clamps a caret beyond the input length', () => {
    expect(detectComposerTrigger('@doc', 99)).toEqual({ kind: 'file', query: 'doc', start: 0, end: 4 });
  });

  it('returns an empty query right after the trigger character is typed', () => {
    expect(detectComposerTrigger('解释 @', 4)).toEqual({ kind: 'file', query: '', start: 3, end: 4 });
  });
});

describe('applyComposerCompletion', () => {
  it('replaces the trigger span and appends a trailing space', () => {
    const trigger = detectComposerTrigger('解释 @chat 一下', 8);
    expect(trigger).not.toBeNull();

    const completion = applyComposerCompletion('解释 @chat 一下', trigger!, '@src/renderer/chat/chat-composer.tsx');

    expect(completion.value).toBe('解释 @src/renderer/chat/chat-composer.tsx 一下');
    expect(completion.caret).toBe('解释 @src/renderer/chat/chat-composer.tsx '.length);
    expect(completion.value.slice(completion.caret)).toBe('一下');
  });

  it('keeps text after the caret when completing mid-input', () => {
    const trigger = detectComposerTrigger('/ty 优化', 3);
    expect(trigger).not.toBeNull();

    const completion = applyComposerCompletion('/ty 优化', trigger!, '/typescript');

    expect(completion.value).toBe('/typescript 优化');
    expect(completion.caret).toBe('/typescript '.length);
  });
});
