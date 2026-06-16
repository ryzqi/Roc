import { expect } from 'vitest';
import { ZodError } from 'zod';
import { proposeInputSchema, proposeToolInputSchema } from '../../src/main/services/deep-agent/background-task-tools';

const FORBIDDEN_FIELD_PATTERNS = [
  /\btrigger\.schedule\b/u,
  /\btrigger\.expr\b/u,
  /\btrigger\.expression\b/u,
  /\btrigger\.cron\b/u,
  /\bnotificationPolicy:\s*on_error\b/u
];

function readIssues(input: unknown): ZodError['issues'] {
  const result = proposeInputSchema.safeParse(input);
  return result.success ? [] : result.error.issues;
}

function readToolIssues(input: unknown): ZodError['issues'] {
  const result = proposeToolInputSchema.safeParse(input);
  return result.success ? [] : result.error.issues;
}

function formatPath(path: readonly PropertyKey[]): string {
  return path.map(String).join('.');
}

function hasIssueAtPath(input: unknown, expectedPath: string): boolean {
  return readIssues(input).some((issue) => {
    const actualPath = formatPath(issue.path);
    return actualPath === expectedPath || actualPath.startsWith(`${expectedPath}.`);
  });
}

function formatIssues(input: unknown): string {
  const issues = readIssues(input);
  if (issues.length === 0) {
    return 'no Zod issues';
  }
  return issues.map((issue) => `${formatPath(issue.path) || '<root>'}: ${issue.message}`).join('\n');
}

function readUnrecognizedKeys(issue: ZodError['issues'][number]): string[] {
  if (issue.code !== 'unrecognized_keys') {
    return [];
  }
  return issue.keys.map(String);
}

expect.extend({
  toBeAcceptedByProposeSchema(input: unknown) {
    const result = proposeInputSchema.safeParse(input);
    return {
      pass: result.success,
      message: () => `expected input to be accepted by propose schema, got:\n${formatIssues(input)}`
    };
  },
  toBeAcceptedByProposeToolSchema(input: unknown) {
    const result = proposeToolInputSchema.safeParse(input);
    return {
      pass: result.success,
      message: () =>
        `expected input to be accepted by model-visible propose schema, got:\n${
          result.success
            ? 'no Zod issues'
            : result.error.issues.map((issue) => `${formatPath(issue.path) || '<root>'}: ${issue.message}`).join('\n')
        }`
    };
  },
  toBeRejectedByProposeSchemaAtPath(input: unknown, expectedPath: string) {
    const pass = hasIssueAtPath(input, expectedPath);
    return {
      pass,
      message: () => `expected input to be rejected at ${expectedPath}, got:\n${formatIssues(input)}`
    };
  },
  toBeRejectedByProposeToolSchemaAtPath(input: unknown, expectedPath: string) {
    const issues = readToolIssues(input);
    const pass = issues.some((issue) => {
      const actualPath = formatPath(issue.path);
      return (
        actualPath === expectedPath ||
        actualPath.startsWith(`${expectedPath}.`) ||
        readUnrecognizedKeys(issue).includes(expectedPath)
      );
    });
    return {
      pass,
      message: () =>
        `expected input to be rejected by model-visible propose schema at ${expectedPath}, got:\n${
          issues.length === 0
            ? 'no Zod issues'
            : issues.map((issue) => `${formatPath(issue.path) || '<root>'}: ${issue.message}`).join('\n')
        }`
    };
  },
  toReferenceForbiddenField(text: string) {
    const matches = FORBIDDEN_FIELD_PATTERNS.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source);
    return {
      pass: matches.length > 0,
      message: () =>
        matches.length === 0
          ? 'expected prompt to reference a forbidden field'
          : `expected prompt not to reference forbidden fields, matched: ${matches.join(', ')}`
    };
  }
});

declare module 'vitest' {
  interface Assertion<T = any> {
    toBeAcceptedByProposeSchema(): T;
    toBeAcceptedByProposeToolSchema(): T;
    toBeRejectedByProposeSchemaAtPath(expectedPath: string): T;
    toBeRejectedByProposeToolSchemaAtPath(expectedPath: string): T;
    toReferenceForbiddenField(): T;
  }

  interface AsymmetricMatchersContaining {
    toBeAcceptedByProposeSchema(): unknown;
    toBeAcceptedByProposeToolSchema(): unknown;
    toBeRejectedByProposeSchemaAtPath(expectedPath: string): unknown;
    toBeRejectedByProposeToolSchemaAtPath(expectedPath: string): unknown;
    toReferenceForbiddenField(): unknown;
  }
}
