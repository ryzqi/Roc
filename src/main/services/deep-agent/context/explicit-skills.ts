import type { RunCapabilityManifestSkillV1 } from '../../../../shared/types';

export type ExplicitSkillContext = {
  id: string;
  name: string;
  path: string;
};

export function loadExplicitSkillContexts(input: {
  explicitSkillIds: readonly string[];
  manifestSkills: readonly RunCapabilityManifestSkillV1[];
}): ExplicitSkillContext[] {
  if (input.explicitSkillIds.length === 0) {
    return [];
  }

  const contexts: ExplicitSkillContext[] = [];
  for (const skillId of input.explicitSkillIds) {
    const skill = input.manifestSkills.find((item) => item.canonicalIdentity === `skill:${skillId}`);
    if (skill === undefined) {
      throw new Error(`run_explicit_skill_not_authorized:${skillId}`);
    }
    contexts.push({
      id: skillId,
      name: skill.name,
      path: `/skills/${skillId}/SKILL.md`
    });
  }
  return contexts;
}
