import { CompositeBackend, FilesystemBackend, StateBackend } from 'deepagents';
import type { RocPaths } from '../paths';
import type { WorkspaceService } from '../workspace-service';

export function createBackend(workspaceService: WorkspaceService, paths: RocPaths): CompositeBackend {
  const workspace = workspaceService.getCurrentWorkspace();
  return new CompositeBackend(
    new StateBackend(),
    workspace === null
      ? {
          '/skills/': new FilesystemBackend({
            rootDir: paths.skillsDir,
            virtualMode: true
          })
        }
      : {
          '/workspace/': new FilesystemBackend({
            rootDir: workspace.path,
            virtualMode: true
          }),
          '/skills/': new FilesystemBackend({
            rootDir: paths.skillsDir,
            virtualMode: true
          })
        }
  );
}
