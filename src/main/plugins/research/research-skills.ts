import discovery from '../../../../resources/research-skills/discovery/SKILL.md?raw';
import retrieval from '../../../../resources/research-skills/retrieval/SKILL.md?raw';
import reading from '../../../../resources/research-skills/reading/SKILL.md?raw';
import ideation from '../../../../resources/research-skills/ideation/SKILL.md?raw';
import planning from '../../../../resources/research-skills/planning/SKILL.md?raw';
import experiment from '../../../../resources/research-skills/experiment/SKILL.md?raw';
import figure from '../../../../resources/research-skills/figure/SKILL.md?raw';
import writing from '../../../../resources/research-skills/writing/SKILL.md?raw';
import review from '../../../../resources/research-skills/review/SKILL.md?raw';
import revision from '../../../../resources/research-skills/revision/SKILL.md?raw';
import exportSkill from '../../../../resources/research-skills/export/SKILL.md?raw';
import type { ResearchStageState } from '../../../shared/types';

const skills: Record<ResearchStageState['stage'], string> = {
  discovery, retrieval, reading, ideation, planning, experiment, figure, writing, review, revision, export: exportSkill
};

export function getResearchSkillInstructions(stage: ResearchStageState['stage']): string {
  return skills[stage];
}
