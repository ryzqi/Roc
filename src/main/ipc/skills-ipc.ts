import { ipcChannels } from '../../shared/ipc';
import { wrapIpc } from '../services/errors';
import type { SkillService } from '../services/skill-service';
import type { TimedHandle } from './ipc-common';

export function registerSkillsIpc(timedHandle: TimedHandle, skillService: SkillService): void {
  timedHandle(ipcChannels.skillsList, () => wrapIpc(() => skillService.list()));
  timedHandle(ipcChannels.skillsImport, (_event, request) => wrapIpc(() => skillService.importSkill(request)));
  timedHandle(ipcChannels.skillsSetEnabled, (_event, request) =>
    wrapIpc(() => skillService.setEnabled(request.id, request.enabled))
  );
  timedHandle(ipcChannels.skillsDelete, (_event, id: string) =>
    wrapIpc(() => {
      skillService.deleteSkill(id);
      return { deleted: true as const };
    })
  );
  timedHandle(ipcChannels.skillsListFiles, (_event, request) => wrapIpc(() => skillService.listFiles(request)));
  timedHandle(ipcChannels.skillsReadFile, (_event, request) => wrapIpc(() => skillService.readFile(request)));
}
