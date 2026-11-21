import {createHash} from 'node:crypto';
import {posix} from 'node:path';
import {z} from 'zod';
import {researchSkillManifestSchema, researchSkillPinSchema,
  type ResearchSkillManifest, type ResearchSkillPin} from '../../../shared/schemas/research-skills';
import {researchStageSchema} from '../../../shared/schemas/research';
import {researchStageRunStartRequestSchema, researchStageOutputSchema} from '../../../shared/schemas/research-runs';
import {getResearchStageRoleProfile, researchCapabilityToolNames} from './role-profiles';

export const researchSkillHash = (value: string): string => createHash('sha256').update(value).digest('hex');
export const researchSkillContractHashes = () => ({
  inputs: researchSkillHash(JSON.stringify(z.toJSONSchema(researchStageRunStartRequestSchema))),
  outputs: researchSkillHash(JSON.stringify(z.toJSONSchema(researchStageOutputSchema)))
});
const bundleSchema = z.object({schemaVersion: z.literal(1), manifests: z.array(researchSkillManifestSchema),
  resources: z.record(z.string(), z.string())}).strict();
export type ResearchSkillBundle = z.infer<typeof bundleSchema>;
export type LoadedResearchSkill = {manifest: ResearchSkillManifest; pin: ResearchSkillPin; instructions: string};

/** Only approved, hash-bound resources enter the prompt. The build produces this closed bundle. */
export class ResearchSkillRegistry {
  private readonly bundle: ResearchSkillBundle;
  constructor(value: unknown, private readonly acceptedLicenses: readonly string[] = ['LicenseRef-Roc-Internal', 'MIT', 'Apache-2.0']) {
    this.bundle = bundleSchema.parse(value);
    const stages = this.bundle.manifests.map(manifest => manifest.stage);
    const ids = this.bundle.manifests.map(manifest => manifest.id);
    if (stages.length !== researchStageSchema.options.length || new Set(stages).size !== stages.length ||
        new Set(ids).size !== ids.length) throw new Error('research_skill_catalog_incomplete');
  }

  catalog(): Array<Pick<ResearchSkillManifest, 'id' | 'stage' | 'version' | 'description'>> {
    return this.bundle.manifests.map(({id, stage, version, description}) => ({id, stage, version, description}));
  }

  load(stage: ResearchSkillManifest['stage'], expected?: ResearchSkillPin): LoadedResearchSkill {
    const manifest = this.bundle.manifests.find(entry => entry.stage === stage);
    if (manifest === undefined) throw new Error('research_skill_missing');
    const pin: ResearchSkillPin = {id: manifest.id, stage, version: manifest.version,
      manifestHash: researchSkillHash(JSON.stringify(manifest)), runtimeContract: manifest.runtimeContract};
    if (expected !== undefined && JSON.stringify(researchSkillPinSchema.parse(expected)) !== JSON.stringify(pin)) {
      throw new Error('research_skill_version_changed');
    }
    const role = getResearchStageRoleProfile(stage);
    if (role.skillIds.length !== 1 || role.skillIds[0] !== manifest.id || role.outputKind !== manifest.outputs.artifactKind) {
      throw new Error('research_skill_role_mismatch');
    }
    const contracts = researchSkillContractHashes();
    if (manifest.inputs.hash !== contracts.inputs || manifest.outputs.hash !== contracts.outputs) {
      throw new Error('research_skill_schema_changed');
    }
    if (!this.acceptedLicenses.includes(manifest.license.id)) throw new Error('research_skill_license_not_accepted');
    this.assertCapabilities(manifest, role.allowedCapabilities);
    const read = (resource: {path: string; hash: string}, scope = stage as string): string => {
      const content = this.bundle.resources[scope ? `${scope}/${resource.path}` : resource.path];
      if (content === undefined || researchSkillHash(content) !== resource.hash) throw new Error('research_skill_resource_changed');
      return content;
    };
    read(manifest.license.resource);
    for (const shared of manifest.sharedReferences) {
      if (!this.acceptedLicenses.includes(shared.license.id)) throw new Error('research_skill_license_not_accepted');
      if (shared.license.id === 'LicenseRef-Roc-Internal' && manifest.source.kind !== 'project') {
        throw new Error('research_skill_internal_license_requires_project_origin');
      }
      read(shared.license.resource, '');
    }
    for (const evaluation of manifest.evalCases) {
      const cases = z.object({schemaVersion: z.literal(1), stage: researchStageSchema,
        cases: z.array(z.object({id: z.string().min(1), requirement: z.string().min(1)}).strict()).min(1)}).strict().parse(JSON.parse(read(evaluation)));
      if (cases.stage !== stage) throw new Error('research_skill_eval_stage_mismatch');
    }
    const resources = [manifest.entry, ...manifest.references].map(resource => ({path: `${stage}/${resource.path}`, content: read(resource)}));
    resources.push(...manifest.sharedReferences.map(resource => ({path: resource.path, content: read(resource, '')})));
    const approved = new Set(resources.map(resource => resource.path));
    for (const resource of resources) {
      for (const match of resource.content.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
        const target = posix.normalize(posix.join(posix.dirname(resource.path), match[1]));
        if (!approved.has(target) || match[1].startsWith('/') || /[:\\]/u.test(match[1])) {
          throw new Error('research_skill_reference_unapproved');
        }
      }
    }
    const instructions = resources.map(resource => resource.content).join('\n\n');
    return {manifest: structuredClone(manifest), pin, instructions};
  }

  assertCapabilities(manifest: ResearchSkillManifest, capabilities: readonly string[]): void {
    const role = getResearchStageRoleProfile(manifest.stage);
    if (capabilities.some(capability => researchCapabilityToolNames[capability] === undefined || !role.allowedCapabilities.includes(capability)) ||
        manifest.requiredCapabilities.some(capability => !capabilities.includes(capability))) {
      throw new Error('research_skill_capability_denied');
    }
    const forbidden = new Set(manifest.forbiddenEffects);
    for (const capability of capabilities) {
      if ((forbidden.has('evidence_write') && capability === 'research.evidence.capture') ||
          (forbidden.has('workspace_write') && ['research.workspace.saveFile', 'research.template.saveOwned'].includes(capability)) ||
          (forbidden.has('production_execute') && /\.(startOwned|compileOwned|prepareOwned)$/u.test(capability))) {
        throw new Error('research_skill_forbidden_effect');
      }
    }
  }

  validateAll(): void { for (const {stage} of this.catalog()) this.load(stage); }
}
