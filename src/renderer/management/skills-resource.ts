import type { SkillSnapshot } from '../../shared/types';
import { unwrapIpcResource } from '../app/ipc-resource';
import type { RocClient } from '../shared/roc-client';
import { listSkills } from './management-store';

/** All renderer consumers share the same global skills snapshot. */
export const SKILLS_LIST_RESOURCE_KEY = ['management', 'skills', 'list'] as const;

export async function loadSkillsList(client: RocClient): Promise<SkillSnapshot[]> {
  return unwrapIpcResource(await listSkills(client));
}
