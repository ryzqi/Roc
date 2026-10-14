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

export function parseSlashSkillCommand(
  value: string,
  availableSkillIds: readonly string[]
): SlashSkillCommandParseResult {
  const knownSkillIds = new Set(availableSkillIds);
  const explicitSkillIds: string[] = [];
  let rest = value.trimStart();

  while (rest.startsWith('/')) {
    const tokenEnd = findFirstWhitespaceIndex(rest);
    const token = tokenEnd === -1 ? rest : rest.slice(0, tokenEnd);
    const skillId = token.slice(1);
    if (!knownSkillIds.has(skillId)) {
      break;
    }
    if (!explicitSkillIds.includes(skillId)) {
      explicitSkillIds.push(skillId);
    }
    rest = tokenEnd === -1 ? '' : rest.slice(tokenEnd).trimStart();
  }

  // 首个 token 不是已知技能 id 时按普通文本发送，`/usr/bin/env ...` 这类消息不能被命令解析卡住。
  if (explicitSkillIds.length === 0) {
    return {
      kind: 'none',
      input: value
    };
  }

  const input = rest.trim();
  if (input.length === 0) {
    return {
      kind: 'error',
      message: '请输入要发送的内容。'
    };
  }

  return {
    kind: 'ok',
    input,
    explicitSkillIds
  };
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
