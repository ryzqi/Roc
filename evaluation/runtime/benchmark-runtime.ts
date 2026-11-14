import { z } from 'zod';
import type { RunCapabilityManifestV1 } from '../../src/shared/types';
import { compileRunCapabilityManifest, createRunCapabilityManifestHash } from '../../src/main/plugins/agent/run-capability-manifest';

// Agent-visible runtime contract only. No dataset, references or verifier imports.
export const benchmarkKindSchema = z.enum(['qasper', 'scienceagentbench', 'rag-paper-qa']);
export type BenchmarkKind = z.infer<typeof benchmarkKindSchema>;
export function benchmarkManifest(kind: BenchmarkKind, toolNames?: readonly string[]): RunCapabilityManifestV1 {
  const compiled = compileRunCapabilityManifest({ mode: kind === 'scienceagentbench' ? 'task' : 'chat', deleteFileApprovalMode: 'default',
    mcpApprovalMode: 'default', mcpServers: [], skills: [], workflowHint: null,
    shellAllowedCommands: kind === 'scienceagentbench' ? ['python solution.py'] : undefined,
    requestedCapabilities: { mcpServers: [], skills: [] },
    researchProjectId: kind === 'rag-paper-qa' ? 'evaluation-project' : null });
  const available = new Set(kind === 'qasper' ? ['ls', 'read_file'] : kind === 'rag-paper-qa'
    ? ['research_search_knowledge', 'research_read_knowledge_context']
    : ['ls', 'read_file', 'write_file', 'edit_file', 'run_shell_command']);
  if (toolNames && (!toolNames.length || new Set(toolNames).size !== toolNames.length || toolNames.some(name => !available.has(name)))) {
    throw new Error('benchmark_tool_subset_invalid');
  }
  const names = toolNames ? new Set(toolNames) : available;
  const { manifestHash: _hash, ...base } = compiled.manifest;
  const manifest = { ...base, tools: base.tools.filter(tool => names.has(tool.modelVisibleName)) };
  return { ...manifest, manifestHash: createRunCapabilityManifestHash(manifest) };
}
