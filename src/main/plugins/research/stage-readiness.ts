import {researchToolchainStatusSchema} from '../../../shared/schemas/research-production';
import {researchFigureRendererEnvironmentSchema} from '../../../shared/schemas/research-figures';
import type {ResearchStageRun} from '../../../shared/types';
import type {RocCapabilityRegistry} from '../../kernel/types';
import type {ResearchRepository} from './repository';
import {researchSkills} from './research-skills';
import {researchCapabilityToolNames} from './role-profiles';

/** Only declarations in the frozen stage skill select probes; this does not add model tools. */
export class ResearchStageReadinessService {
  constructor(private readonly repository: ResearchRepository, private readonly capabilities: RocCapabilityRegistry) {}

  async check(run: ResearchStageRun, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const context = this.repository.runs.getContext(run.id);
    const skill = researchSkills.load(run.stage, context.skillPin);
    const available = new Set(this.capabilities.list().map(capability => capability.name));
    for (const capability of skill.manifest.requiredCapabilities) {
      if (!run.toolNames.includes(researchCapabilityToolNames[capability]) || !available.has(capability)) {
        throw new Error(`research_skill_capability_unavailable:${capability}`);
      }
    }
    for (const check of skill.manifest.readiness) {
      signal.throwIfAborted();
      const name = check === 'figure_renderer' ? 'research.figure.environment' : 'research.toolchain.status';
      if (!available.has(name)) throw new Error(`research_skill_capability_unavailable:${name}`);
      const report = await this.capabilities.invoke(name, check === 'figure_renderer' ? {projectId: run.projectId} : {}, signal);
      if (check === 'figure_renderer') researchFigureRendererEnvironmentSchema.parse(report);
      else {
        const status = researchToolchainStatusSchema.parse(report);
        if (!status.available || status.versions === null) {
          throw new Error(`research_skill_runtime_unavailable:${status.error !== null && /^research_[a-z0-9_]+$/u.test(status.error)
            ? status.error : 'export_toolchain'}`);
        }
      }
    }
    signal.throwIfAborted();
    this.repository.runs.assertInputsCurrent(run);
  }
}
