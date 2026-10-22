import type { RunCapabilityManifestToolV1, RunCapabilityManifestV1 } from '../../../shared/schemas/agent';
import type { PilotProfile } from '../../../shared/schemas/harness-pilot';
import {
  isEffectAllowedForProfile,
  isGrantAllowedForProfile,
  type PilotRequest
} from '../../services/deep-agent/pilot-gate';
import { createRunCapabilityManifestHash } from './run-capability-manifest';

/**
 * P6-04: the pilot's capability request is *derived from the frozen manifest*, never declared by
 * the caller. Every manifest tool maps to the grants it needs and the effect classes it produces,
 * so the gate decides about the run the harness will actually assemble.
 *
 * The same mapping filters the manifest when a pilot starts: a profile that denies a grant or an
 * effect must not leave the tool bound, otherwise the gate would be a label rather than a boundary.
 */

/** Grants implied by one manifest tool. Unknown scope/effect pairs fall back to a name no profile allows. */
export function pilotGrantsForTool(tool: RunCapabilityManifestToolV1): string[] {
  const research = tool.canonicalIdentity.startsWith('research:');
  switch (tool.effectClass) {
    case 'workspace_mutation':
      return research ? ['research.read', 'research.artifact.write'] : ['workspace.read', 'workspace.write'];
    case 'host_execution':
      // A host shell can read and write the workspace; the profile decision is made on the effect.
      return ['workspace.read', 'workspace.write'];
    case 'network_read':
      return research && tool.resourceScope === 'memory' ? ['memory.read', 'research.read'] : ['network.read'];
    case 'external_call':
      // Reading is not what gets denied here: the effect class is.
      return ['workspace.read'];
    case 'none':
      return readOnlyGrantsForTool(tool);
    default:
      return [`unknown.grant:${String(tool.effectClass)}`];
  }
}

function readOnlyGrantsForTool(tool: RunCapabilityManifestToolV1): string[] {
  const research = tool.canonicalIdentity.startsWith('research:');
  switch (tool.resourceScope) {
    case 'workspace':
      return ['workspace.read'];
    case 'memory':
      return research ? ['memory.read', 'research.read'] : ['memory.read'];
    case 'app':
      return research ? ['research.read'] : ['files.preview'];
    case 'network':
      return ['network.read'];
    case 'external':
      return ['external.call'];
    default:
      return [`unknown.grant:${String(tool.resourceScope)}`];
  }
}

export function pilotEffectsForTool(tool: RunCapabilityManifestToolV1): string[] {
  return tool.effectClass === 'none' ? [] : [tool.effectClass];
}

/**
 * The whole run's request: the model call itself plus everything the manifest would bind.
 * Sorted so the decision is deterministic for a given manifest.
 */
export function derivePilotRequest(manifest: RunCapabilityManifestV1, taskId: string): PilotRequest {
  const grants = new Set<string>(['provider.model']);
  const effectClasses = new Set<string>();
  for (const tool of manifest.tools) {
    for (const grant of pilotGrantsForTool(tool)) grants.add(grant);
    for (const effect of pilotEffectsForTool(tool)) effectClasses.add(effect);
  }
  return {
    taskId,
    grants: [...grants].sort(),
    effectClasses: [...effectClasses].sort()
  };
}

export function pilotToolAllowedForProfile(profile: PilotProfile, tool: RunCapabilityManifestToolV1): boolean {
  return pilotGrantsForTool(tool).every((grant) => isGrantAllowedForProfile(profile, grant))
    && pilotEffectsForTool(tool).every((effect) => isEffectAllowedForProfile(profile, effect));
}

/**
 * Drops every tool the profile would deny and re-seals the manifest hash.
 *
 * Returns the original object when nothing is removed, so a non-pilot run keeps the exact manifest
 * that was previewed and hashed.
 */
export function restrictManifestForPilot(
  manifest: RunCapabilityManifestV1,
  profile: PilotProfile
): { manifest: RunCapabilityManifestV1; removedTools: string[] } {
  const removedTools: string[] = [];
  const tools = manifest.tools.filter((tool) => {
    if (pilotToolAllowedForProfile(profile, tool)) return true;
    removedTools.push(tool.modelVisibleName);
    return false;
  });
  if (removedTools.length === 0) return { manifest, removedTools };
  const { manifestHash: _previousHash, ...withoutHash } = manifest;
  return {
    manifest: { ...withoutHash, tools, manifestHash: createRunCapabilityManifestHash({ ...withoutHash, tools }) },
    removedTools
  };
}
