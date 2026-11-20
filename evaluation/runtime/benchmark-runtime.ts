import { z } from 'zod';
import type { RunCapabilityManifestV1 } from '../../src/shared/types';
import { bindMcpToolContracts, compileRunCapabilityManifest, createRunCapabilityManifestHash } from '../../src/main/plugins/agent/run-capability-manifest';
import { capabilityMcpToolName, createCapabilityMcpServer, createCapabilityMcpToolContract } from './capability-mcp';
import type { CapabilityMcpEnvironment } from './capability-mcp';

// Agent-visible runtime contract only. No dataset, references or verifier imports.
export const benchmarkKindSchema = z.enum([
  'qasper', 'scienceagentbench', 'rag-paper-qa', 'roc-capability', 'roc-e2e-research', 'roc-security'
]);
export type BenchmarkKind = z.infer<typeof benchmarkKindSchema>;
const capabilityKinds: readonly BenchmarkKind[] = ['roc-capability', 'roc-e2e-research', 'roc-security'];
export function isCapabilityBenchmark(kind: BenchmarkKind): boolean { return capabilityKinds.includes(kind); }
export function benchmarkMode(kind: BenchmarkKind, toolNames?: readonly string[], runMode?: 'task' | 'chat'): 'task' | 'chat' {
  if (runMode !== undefined) {
    if (!isCapabilityBenchmark(kind) || !['task', 'chat'].includes(runMode)) throw new Error('benchmark_run_mode_invalid');
    return runMode;
  }
  return kind === 'scienceagentbench' || isCapabilityBenchmark(kind) && toolNames?.includes('run_shell_command') === true ? 'task' : 'chat';
}
export function benchmarkManifest(kind: BenchmarkKind, toolNames?: readonly string[], runMode?: 'task' | 'chat',
  mcp?: CapabilityMcpEnvironment): RunCapabilityManifestV1 {
  const capability = isCapabilityBenchmark(kind);
  if (mcp !== undefined && !capability) throw new Error('benchmark_mcp_kind_invalid');
  const mcpServers = mcp === undefined ? [] : [createCapabilityMcpServer(mcp)];
  const mode = benchmarkMode(kind, toolNames, runMode);
  const compiled = compileRunCapabilityManifest({ mode, deleteFileApprovalMode: 'default',
    mcpApprovalMode: mcp === undefined ? 'default' : 'fully_automatic', mcpServers, skills: [], workflowHint: null,
    shellAllowedCommands: mode === 'task' ? ['python solution.py'] : undefined,
    requestedCapabilities: { mcpServers: mcpServers.map(server => server.id), skills: [] },
    researchProjectId: kind === 'rag-paper-qa' || capability && toolNames?.some(name => name.startsWith('research_')) === true ? 'evaluation-project' : null });
  const available = new Set(capability ? [
    'write_todos', 'ls', 'read_file', 'write_file', 'edit_file', 'glob', 'grep',
    'session_search', 'memory_search', 'remember', 'read_context_artifact',
    'research_search_knowledge', 'research_read_knowledge_context',
    ...(mcp === undefined ? [] : [capabilityMcpToolName]),
    ...(mode === 'task' ? ['run_shell_command'] : [])
  ] : kind === 'qasper' ? ['ls', 'read_file'] : kind === 'rag-paper-qa'
    ? ['research_search_knowledge', 'research_read_knowledge_context']
    : ['ls', 'read_file', 'write_file', 'edit_file', 'run_shell_command']);
  if (toolNames && (!capability && !toolNames.length || new Set(toolNames).size !== toolNames.length || toolNames.some(name => !available.has(name)))) {
    throw new Error('benchmark_tool_subset_invalid');
  }
  const names = toolNames ? new Set(toolNames) : available;
  const { manifestHash: _hash, ...base } = compiled.manifest;
  const manifest = { ...base, tools: base.tools.filter(tool => names.has(tool.modelVisibleName)) };
  if (toolNames && toolNames.some(name => !manifest.tools.some(tool => tool.modelVisibleName === name))) {
    throw new Error('benchmark_tool_not_compiled');
  }
  const preview = { ...manifest, manifestHash: createRunCapabilityManifestHash(manifest) };
  return preview.tools.some(tool => tool.provenance.kind === 'mcp')
    ? bindMcpToolContracts(preview, [createCapabilityMcpToolContract()]) : preview;
}
