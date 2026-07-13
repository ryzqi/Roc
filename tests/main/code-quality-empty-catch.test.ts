import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import type { Expression, Node, SourceFile } from 'typescript/unstable/ast';
import * as ts from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/sync';
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

function formatLocation(sourceFile: SourceFile, file: string, position: number): string {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(position);
  return `${relative(process.cwd(), file).replace(/\\/g, '/')}:${line + 1}:${character + 1}`;
}

function withParsedSourceFiles(files: string[], visitFile: (file: string, sourceFile: SourceFile) => void): void {
  const api = new API({ cwd: process.cwd() });
  try {
    const snapshot = api.updateSnapshot({ openFiles: files });
    try {
      for (const file of files) {
        const project = snapshot.getDefaultProjectForFile(file);
        if (project === undefined) {
          throw new Error(`TypeScript 7 API did not resolve a project for ${file}`);
        }
        const sourceFile = project.program.getSourceFile(file);
        if (sourceFile === undefined) {
          throw new Error(`TypeScript 7 API did not return SourceFile for ${file}`);
        }
        visitFile(file, sourceFile);
      }
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}

function findEmptyCatchHandlers(): string[] {
  const findings: string[] = [];
  const files = collectSourceFiles(join(process.cwd(), 'src'));
  withParsedSourceFiles(files, (file, sourceFile) => {
    function visit(node: Node): void {
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
      node.forEachChild(visit);
    }

    visit(sourceFile);
  });
  return findings;
}

function findExplicitAnyTypes(): string[] {
  const findings: string[] = [];
  const files = collectSourceFiles(join(process.cwd(), 'src', 'main'));
  withParsedSourceFiles(files, (file, sourceFile) => {
    function visit(node: Node): void {
      if (node.kind === ts.SyntaxKind.AnyKeyword) {
        findings.push(`${formatLocation(sourceFile, file, node.getStart(sourceFile))} explicit any type`);
      }
      node.forEachChild(visit);
    }

    visit(sourceFile);
  });
  return findings;
}

function findWeakToBeDefinedAssertions(): string[] {
  const findings: string[] = [];
  const files = collectSourceFiles(join(process.cwd(), 'tests'));
  withParsedSourceFiles(files, (file, sourceFile) => {
    function visit(node: Node): void {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const assertion = node.expression;
        if (assertion.name.text === 'toBeDefined' && isExpectChain(assertion.expression)) {
          findings.push(`${formatLocation(sourceFile, file, node.getStart(sourceFile))} weak toBeDefined assertion`);
        }
      }
      node.forEachChild(visit);
    }

    visit(sourceFile);
  });
  return findings;
}

function isExpectChain(expression: Expression): boolean {
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === 'expect') {
    return true;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return isExpectChain(expression.expression);
  }
  return false;
}

function readClassMethodSource(file: string, className: string, methodName: string): string {
  let methodSource: string | null = null;
  withParsedSourceFiles([file], (_file, sourceFile) => {
    function visit(node: Node): void {
      if (ts.isClassDeclaration(node) && node.name !== undefined && node.name.text === className) {
        for (const member of node.members) {
          if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === methodName) {
            methodSource = member.getText(sourceFile);
          }
        }
      }
      node.forEachChild(visit);
    }

    visit(sourceFile);
  });
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

  it('does not use weak toBeDefined assertions in automated tests', () => {
    expect(findWeakToBeDefinedAssertions()).toEqual([]);
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

  it('does not synchronously append infrastructure plugin logs', () => {
    const source = readClassMethodSource(
      join(process.cwd(), 'src', 'main', 'infrastructure', 'logger.ts'),
      'InfrastructureLogger',
      'append'
    );

    expect(source).not.toContain('appendFileSync');
  });

  it('does not reimplement native AbortSignal.any for NVIDIA probe cancellation', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'main', 'services', 'langchain-nvidia-probe.ts'), 'utf8');

    expect(source).not.toContain('function anySignal');
  });

  it('does not keep an inert DeepAgent executor cleanup registry', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'main', 'plugins', 'agent', 'deep-agent-executor.ts'), 'utf8');

    expect(source).not.toContain('const closers: Array<() => Promise<void>> = []');
    expect(source).not.toContain('Promise.allSettled(closers.map');
  });

  it('does not keep the retired DeepAgent prompt-builder compatibility export', () => {
    expect(existsSync(join(process.cwd(), 'src', 'main', 'services', 'deep-agent', 'prompt-builder.ts'))).toBe(false);
  });

  it('does not keep the unused infrastructure schema registry', () => {
    expect(existsSync(join(process.cwd(), 'src', 'main', 'infrastructure', 'schema-registry.ts'))).toBe(false);
  });
});
