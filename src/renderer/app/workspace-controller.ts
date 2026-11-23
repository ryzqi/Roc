import {useEffect, useMemo} from 'react';
import type {RocClient} from '../shared/roc-client';
import type {AppRoute} from './routes';
import {useCurrentProject} from '../project/use-projects';
import {useProjectList} from '../project/use-project-list';
import {useProjectWorkspace} from '../project/use-project-workspace';
import {isProjectWritable} from '../project/project-store';
import {useBoundWorkspace} from '../workspace/use-bound-workspace';
import {useGitSummary} from '../shell/use-git-summary';
import {useLiteratureStore} from '../literature/use-literature-store';
import {wikiConceptRows} from '../literature/wiki-concepts';
import {recordProjectVisit} from './ui-state';

/** Owns shared project resources; file/Git consumers receive only the bound workspace path. */
export function useWorkspaceController(client: RocClient, route: AppRoute) {
  const currentProject = useCurrentProject(client, route.projectId);
  const projects = useProjectList(client).data ?? [];
  const project = currentProject.data;
  useEffect(() => {
    if (project !== null && project.id === route.projectId) recordProjectVisit(project.id);
  }, [project?.id, route.projectId]);
  const workspaceBinding = useProjectWorkspace(client, project, currentProject.reload);
  const boundWorkspace = useBoundWorkspace(client, project);
  const gitSummary = useGitSummary(client, boundWorkspace.path, route.tool === 'git');
  // One store serves the context drawer, retained canvas and object-opening commands.
  const literature = useLiteratureStore(client, route.projectId);
  const conceptRows = useMemo(() => {
    if (literature.claims === null || literature.evidence === null) return [];
    return wikiConceptRows(literature.claims, literature.evidence, literature.wikiSnapshot?.relations);
  }, [literature.claims, literature.evidence, literature.wikiSnapshot]);
  return {currentProject, projects, project, workspaceBinding, boundWorkspace, gitSummary, literature, conceptRows,
    projectName: project?.title ?? null, projectWritable: isProjectWritable(project),
    inProject: route.projectId !== null, projectLoadFailed: route.projectId !== null && currentProject.status === 'error'};
}

export type WorkspaceController = ReturnType<typeof useWorkspaceController>;
