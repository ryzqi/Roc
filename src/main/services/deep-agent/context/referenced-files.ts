import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export type ReferencedFileContext = {
  path: string;
};

const maxReferencedFiles = 20;
const trailingPunctuation = new Set([
  ',',
  '.',
  ';',
  ':',
  '!',
  '?',
  ')',
  ']',
  '}',
  '>',
  '"',
  "'",
  '`',
  '，',
  '。',
  '；',
  '：',
  '！',
  '？',
  '）',
  '】',
  '》',
  '”',
  '’'
]);

export function loadReferencedFileContexts(input: {
  userInput: string;
  workspacePath: string | null;
}): ReferencedFileContext[] {
  const workspacePath = input.workspacePath;
  if (workspacePath === null) {
    return [];
  }

  const contexts: ReferencedFileContext[] = [];
  const seen = new Set<string>();
  for (const token of extractReferenceTokens(input.userInput)) {
    if (contexts.length >= maxReferencedFiles) {
      break;
    }
    const relativePath = token.replaceAll('\\', '/');
    if (seen.has(relativePath)) {
      continue;
    }
    if (!isWorkspaceRelativeFile(workspacePath, relativePath)) {
      continue;
    }
    seen.add(relativePath);
    contexts.push({ path: relativePath });
  }
  return contexts;
}

function extractReferenceTokens(userInput: string): string[] {
  const tokens: string[] = [];
  for (let index = 0; index < userInput.length; index += 1) {
    if (userInput[index] !== '@') {
      continue;
    }
    if (index > 0 && !/\s/.test(userInput[index - 1])) {
      continue;
    }
    let end = index + 1;
    while (end < userInput.length && !/\s/.test(userInput[end])) {
      end += 1;
    }
    const token = trimTrailingPunctuation(userInput.slice(index + 1, end));
    if (token.length > 0) {
      tokens.push(token);
    }
    index = end - 1;
  }
  return tokens;
}

function trimTrailingPunctuation(token: string): string {
  let end = token.length;
  while (end > 0 && trailingPunctuation.has(token[end - 1])) {
    end -= 1;
  }
  return token.slice(0, end);
}

function isWorkspaceRelativeFile(workspacePath: string, relativePath: string): boolean {
  if (isAbsoluteReference(relativePath)) {
    return false;
  }
  if (relativePath.split('/').includes('..')) {
    return false;
  }
  const absolutePath = resolve(workspacePath, relativePath);
  if (!isInsideWorkspace(absolutePath, workspacePath)) {
    return false;
  }
  if (!existsSync(absolutePath)) {
    return false;
  }
  return statSync(absolutePath).isFile();
}

function isAbsoluteReference(relativePath: string): boolean {
  return relativePath.startsWith('/') || /^[A-Za-z]:/.test(relativePath);
}

function isInsideWorkspace(absolutePath: string, workspacePath: string): boolean {
  const normalizedRoot = resolve(workspacePath).toLocaleLowerCase();
  const normalizedPath = resolve(absolutePath).toLocaleLowerCase();
  return normalizedPath.startsWith(`${normalizedRoot}\\`) || normalizedPath.startsWith(`${normalizedRoot}/`);
}
