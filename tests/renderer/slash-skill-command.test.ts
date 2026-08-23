import { describe, expect, it } from 'vitest';

import { parseSlashSkillCommand } from '../../src/renderer/chat/slash-skill-command';

const availableSkillIds = ['tdd', 'typescript', 'python-expert'];

describe('parseSlashSkillCommand', () => {
  it('extracts a single skill id and the remaining prompt', () => {
    expect(parseSlashSkillCommand('/python-expert 优化这段代码', availableSkillIds)).toEqual({
      kind: 'ok',
      input: '优化这段代码',
      explicitSkillIds: ['python-expert']
    });
  });

  it('extracts multiple leading skill ids in order', () => {
    expect(parseSlashSkillCommand('/tdd /typescript 写个解析器', availableSkillIds)).toEqual({
      kind: 'ok',
      input: '写个解析器',
      explicitSkillIds: ['tdd', 'typescript']
    });
  });

  it('dedupes repeated skill ids while keeping first-seen order', () => {
    expect(parseSlashSkillCommand('/typescript /tdd /typescript 重构', availableSkillIds)).toEqual({
      kind: 'ok',
      input: '重构',
      explicitSkillIds: ['typescript', 'tdd']
    });
  });

  it('treats an unknown leading token as plain text', () => {
    expect(parseSlashSkillCommand('/usr/bin/env node 报错了', availableSkillIds)).toEqual({
      kind: 'none',
      input: '/usr/bin/env node 报错了'
    });
  });

  it('treats input without a leading slash as plain text', () => {
    expect(parseSlashSkillCommand('普通消息', availableSkillIds)).toEqual({
      kind: 'none',
      input: '普通消息'
    });
  });

  it('degrades to plain text when no skills are available', () => {
    expect(parseSlashSkillCommand('/tdd 写测试', [])).toEqual({
      kind: 'none',
      input: '/tdd 写测试'
    });
  });

  it('reports an error when a matched skill has no prompt body', () => {
    expect(parseSlashSkillCommand('/tdd', availableSkillIds)).toEqual({
      kind: 'error',
      message: '请输入要发送的内容。'
    });
    expect(parseSlashSkillCommand('/tdd /typescript   ', availableSkillIds)).toEqual({
      kind: 'error',
      message: '请输入要发送的内容。'
    });
  });

  it('stops consuming skill ids at the first unknown token', () => {
    expect(parseSlashSkillCommand('/tdd /unknown 继续', availableSkillIds)).toEqual({
      kind: 'ok',
      input: '/unknown 继续',
      explicitSkillIds: ['tdd']
    });
  });
});
