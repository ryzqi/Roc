import { expect } from 'vitest';
import { ZodError } from 'zod';
import { proposeInputSchema } from '../../src/main/services/deep-agent/background-task-tools';

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

function formatPath(path: readonly (string | number)[]): string {
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

expect.extend({
  toBeAcceptedByProposeSchema(input: unknown) {
    const result = proposeInputSchema.safeParse(input);
    return {
      pass: result.success,
      message: () => `expected input to be accepted by propose schema, got:\n${formatIssues(input)}`
    };
  },
  toBeRejectedByProposeSchemaAtPath(input: unknown, expectedPath: string) {
    const pass = hasIssueAtPath(input, expectedPath);
    return {
      pass,
      message: () => `expected input to be rejected at ${expectedPath}, got:\n${formatIssues(input)}`
    };
  },
  toContainCanonicalExample(text: string) {
    const requiredFragments = ['"goal"', '"trigger"', '"workspacePath"', '"type": "cron"', '"cronExpression"', '"nextRunAt"'];
    const missing = requiredFragments.filter((fragment) => !text.includes(fragment));
    return {
      pass: missing.length === 0,
      message: () => `expected prompt to contain canonical example fragments, missing: ${missing.join(', ')}`
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
    toBeRejectedByProposeSchemaAtPath(expectedPath: string): T;
    toContainCanonicalExample(): T;
    toReferenceForbiddenField(): T;
  }

  interface AsymmetricMatchersContaining {
    toBeAcceptedByProposeSchema(): unknown;
    toBeRejectedByProposeSchemaAtPath(expectedPath: string): unknown;
    toContainCanonicalExample(): unknown;
    toReferenceForbiddenField(): unknown;
  }
}
