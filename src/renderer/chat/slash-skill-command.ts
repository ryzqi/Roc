export type SlashSkillCommandParseResult =
  | {
      kind: 'none';
      input: string;
    }
  | {
      kind: 'ok';
      input: string;
      explicitSkillIds: string[];
    }
  | {
      kind: 'error';
      message: string;
    };

export function parseSlashSkillCommand(value: string): SlashSkillCommandParseResult {
  if (!startsWithSkillCommand(value)) {
    return {
      kind: 'none',
      input: value
    };
  }

  const commandBody = value.slice('/skill'.length).trimStart();
  if (commandBody.length === 0) {
    return {
      kind: 'error',
      message: '请输入 Skill ID。'
    };
  }

  const skillIdEnd = findFirstWhitespaceIndex(commandBody);
  const skillId = skillIdEnd === -1 ? commandBody : commandBody.slice(0, skillIdEnd);
  const prompt = skillIdEnd === -1 ? '' : commandBody.slice(skillIdEnd).trimStart();

  if (prompt.trim().length === 0) {
    return {
      kind: 'error',
      message: '请输入要发送的内容。'
    };
  }

  return {
    kind: 'ok',
    input: prompt.trim(),
    explicitSkillIds: [skillId]
  };
}

function startsWithSkillCommand(value: string): boolean {
  if (value === '/skill') {
    return true;
  }
  const next = value.at('/skill'.length);
  return value.startsWith('/skill') && next !== undefined && /\s/.test(next);
}

function findFirstWhitespaceIndex(value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== undefined && /\s/.test(char)) {
      return index;
    }
  }
  return -1;
}
