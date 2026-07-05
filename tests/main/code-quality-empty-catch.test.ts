import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function collectSourceFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(fullPath, files);
      continue;
    }
    if (sourceExtensions.has(extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function scriptKindFor(file: string): ts.ScriptKind {
  switch (extname(file)) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function formatLocation(sourceFile: ts.SourceFile, file: string, position: number): string {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(position);
  return `${relative(process.cwd(), file).replace(/\\/g, '/')}:${line + 1}:${character + 1}`;
}

function findEmptyCatchHandlers(): string[] {
  const findings: string[] = [];
  for (const file of collectSourceFiles(join(process.cwd(), 'src'))) {
    const source = readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindFor(file));

    function visit(node: ts.Node): void {
      if (ts.isCatchClause(node) && node.block.statements.length === 0) {
        findings.push(`${formatLocation(sourceFile, file, node.getStart(sourceFile))} empty catch clause`);
      }
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        const handler = node.arguments[0];
        if (
          ts.isPropertyAccessExpression(expression) &&
          expression.name.text === 'catch' &&
          handler !== undefined &&
          (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) &&
          ts.isBlock(handler.body) &&
          handler.body.statements.length === 0
        ) {
          findings.push(`${formatLocation(sourceFile, file, handler.getStart(sourceFile))} empty Promise.catch handler`);
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }
  return findings;
}

function findExplicitAnyTypes(): string[] {
  const findings: string[] = [];
  for (const file of collectSourceFiles(join(process.cwd(), 'src', 'main'))) {
    const source = readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindFor(file));

    function visit(node: ts.Node): void {
      if (node.kind === ts.SyntaxKind.AnyKeyword) {
        findings.push(`${formatLocation(sourceFile, file, node.getStart(sourceFile))} explicit any type`);
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }
  return findings;
}

function readClassMethodSource(file: string, className: string, methodName: string): string {
  const source = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  let methodSource: string | null = null;

  function visit(node: ts.Node): void {
    if (ts.isClassDeclaration(node) && node.name !== undefined && node.name.text === className) {
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === methodName) {
          methodSource = member.getText(sourceFile);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  if (methodSource === null) {
    throw new Error(`Could not find ${className}.${methodName}`);
  }
  return methodSource;
}

describe('source code quality', () => {
  it('does not leave empty catch handlers in production source', () => {
    expect(findEmptyCatchHandlers()).toEqual([]);
  });

  it('does not use explicit any types in main-process production source', () => {
    expect(findExplicitAnyTypes()).toEqual([]);
  });

  it('does not synchronously append terminal output logs on the PTY output path', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'main', 'services', 'terminal-session-service.ts'), 'utf8');

    expect(source).not.toContain('appendFileSync');
  });

  it('does not synchronously buffer PDF preview resources', () => {
    const source = readClassMethodSource(
      join(process.cwd(), 'src', 'main', 'services', 'file-service.ts'),
      'FileService',
      'streamPdfPreviewResource'
    );

    expect(source).not.toContain('readFileSync');
  });
});
