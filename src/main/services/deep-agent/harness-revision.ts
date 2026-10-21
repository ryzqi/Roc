import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ClientTool } from '@langchain/core/tools';
import { z } from 'zod';
import { dependencies } from '../../../../package.json';
import type { RunExecutionSnapshot } from '../../../shared/types';
import { hashToolInput } from './tool-effect-store';

// Hash the executing bundle once. Restoring a run never silently switches implementation bytes.
export const harnessImplementationHash = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');

export function describeHarnessTools(tools: readonly ClientTool[]): unknown[] {
  return [...tools].sort((left, right) => left.name.localeCompare(right.name, 'en')).map(tool => ({ name: tool.name, description: tool.description,
    schema: 'schema' in tool ? (tool.schema instanceof z.ZodType ? z.toJSONSchema(tool.schema) : tool.schema) : null }));
}

export function memoryApplicability(input: { model: RunExecutionSnapshot['model']; toolContracts: RunExecutionSnapshot['capabilityManifest']['tools'] }, tools: readonly ClientTool[]): string {
  return hashToolInput({ implementation: harnessImplementationHash, model: input.model, frameworkVersions: dependencies, contextPolicyVersion: 2,
    tools: describeHarnessTools(tools), manifest: input.toolContracts });
}
