export type ComposerTrigger =
  | { kind: 'file'; query: string; start: number; end: number }
  | { kind: 'skill'; query: string; start: number; end: number };

export function detectComposerTrigger(value: string, caret: number): ComposerTrigger | null {
  const boundedCaret = Math.max(0, Math.min(caret, value.length));
  for (let index = boundedCaret - 1; index >= 0; index -= 1) {
    const char = value[index];
    if (char === undefined || isWhitespace(char)) {
      return null;
    }
    if (char === '@') {
      if (!isTokenStart(value, index)) {
        return null;
      }
      return {
        kind: 'file',
        query: value.slice(index + 1, boundedCaret),
        start: index,
        end: boundedCaret
      };
    }
    if (char === '/') {
      if (!isInsideSlashCommandRegion(value, index)) {
        return null;
      }
      return {
        kind: 'skill',
        query: value.slice(index + 1, boundedCaret),
        start: index,
        end: boundedCaret
      };
    }
  }
  return null;
}

export function applyComposerCompletion(
  value: string,
  trigger: ComposerTrigger,
  replacement: string
): { value: string; caret: number } {
  const nextChar = value[trigger.end];
  // caret 后面已经是空白就不再补，避免补全后留下双空格；caret 仍然落在那个空白之后。
  const followedByWhitespace = nextChar !== undefined && isWhitespace(nextChar);
  const inserted = followedByWhitespace ? replacement : `${replacement} `;
  return {
    value: `${value.slice(0, trigger.start)}${inserted}${value.slice(trigger.end)}`,
    caret: trigger.start + inserted.length + (followedByWhitespace ? 1 : 0)
  };
}

function isTokenStart(value: string, index: number): boolean {
  if (index === 0) {
    return true;
  }
  const previous = value[index - 1];
  return previous !== undefined && isWhitespace(previous);
}

// 斜杠命令区：`/` 之前只允许空白和被空白终止的完整 `/<token>`，这样 `/tdd /ty` 的第二个 `/` 能触发，
// 而 `修一下 /usr/bin`、`/usr/bin` 里的 `/` 不会。
function isInsideSlashCommandRegion(value: string, index: number): boolean {
  let cursor = 0;
  while (cursor < index) {
    const char = value[cursor];
    if (char === undefined) {
      return false;
    }
    if (isWhitespace(char)) {
      cursor += 1;
      continue;
    }
    if (char !== '/') {
      return false;
    }
    cursor += 1;
    while (cursor < index) {
      const tokenChar = value[cursor];
      if (tokenChar === undefined || isWhitespace(tokenChar) || tokenChar === '/') {
        break;
      }
      cursor += 1;
    }
    // token 必须由空白终止；紧贴上一个 token 的 `/` 属于路径分隔符，不是新命令。
    if (value[cursor] === '/') {
      return false;
    }
  }
  return true;
}

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}
