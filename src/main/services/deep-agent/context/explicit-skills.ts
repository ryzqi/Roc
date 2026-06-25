import type { SkillFilePreviewResult, SkillSnapshot } from '../../../../shared/types';
import type { RocCapabilityRegistry } from '../../../kernel/types';

export type ExplicitSkillContext = {
  id: string;
  name: string;
  path: string;
  content: string;
};

export async function loadExplicitSkillContexts(input: {
  capabilities: RocCapabilityRegistry;
  explicitSkillIds: readonly string[] | undefined;
}): Promise<ExplicitSkillContext[]> {
  if (input.explicitSkillIds === undefined || input.explicitSkillIds.length === 0) {
    return [];
  }

  const skills = await input.capabilities.invoke<{}, SkillSnapshot[]>('skills.list', {});
  const contexts: ExplicitSkillContext[] = [];
  for (const skillId of input.explicitSkillIds) {
    const skill = skills.find((item) => item.id === skillId);
    if (skill === undefined) {
      throw new Error(`skill_not_found:${skillId}`);
    }
    if (!skill.enabled) {
      throw new Error(`skill_disabled:${skillId}`);
    }
    if (skill.status !== 'ready') {
      throw new Error(`skill_invalid:${skillId}`);
    }
    const file = await input.capabilities.invoke<{ id: string; relativePath: string }, SkillFilePreviewResult>(
      'skills.file.read',
      {
        id: skillId,
        relativePath: 'SKILL.md'
      }
    );
    if (file.kind !== 'text' || file.truncated) {
      throw new Error(`explicit_skill_read_failed:${skillId}`);
    }
    contexts.push({
      id: skill.id,
      name: skill.name,
      path: `/skills/${skill.id}/SKILL.md`,
      content: file.content
    });
  }
  return contexts;
}
