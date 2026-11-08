import { z } from 'zod';
import type { RunCapabilityManifestV1 } from '../../src/shared/types';
import { compileRunCapabilityManifest, createRunCapabilityManifestHash } from '../../src/main/plugins/agent/run-capability-manifest';

// Agent-visible runtime contract only. No dataset, references or verifier imports.
export const benchmarkKindSchema = z.enum(['qasper', 'scienceagentbench']);
export type BenchmarkKind = z.infer<typeof benchmarkKindSchema>;
export function benchmarkManifest(kind: BenchmarkKind): RunCapabilityManifestV1 {
  const compiled = compileRunCapabilityManifest({ mode: kind === 'scienceagentbench' ? 'task' : 'chat', deleteFileApprovalMode: 'default',
    mcpApprovalMode: 'default', mcpServers: [], skills: [], workflowHint: null,
    shellAllowedCommands: kind === 'scienceagentbench' ? ['python solution.py'] : undefined,
    requestedCapabilities: { mcpServers: [], skills: [] } });
  const names = new Set(kind === 'qasper' ? ['ls', 'read_file']
    : ['ls', 'read_file', 'write_file', 'edit_file', 'run_shell_command']);
  const { manifestHash: _hash, ...base } = compiled.manifest;
  const manifest = { ...base, tools: base.tools.filter(tool => names.has(tool.modelVisibleName)) };
  return { ...manifest, manifestHash: createRunCapabilityManifestHash(manifest) };
}
