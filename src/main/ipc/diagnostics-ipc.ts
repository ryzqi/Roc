import { ipcChannels } from '../../shared/ipc';
import type { DiagnosticsService } from '../services/diagnostics-service';
import type { TaskSchedulerService } from '../services/task-scheduler-service';
import { wrapIpc } from '../services/errors';
import type { TimedHandle } from './ipc-common';

export function registerDiagnosticsIpc(
  timedHandle: TimedHandle,
  diagnosticsService: DiagnosticsService,
  taskSchedulerService: TaskSchedulerService
): void {
  timedHandle(ipcChannels.diagnosticsSamplePerformance, (_event, request) =>
    wrapIpc(() => diagnosticsService.samplePerformance(request))
  );
  timedHandle(ipcChannels.diagnosticsCreatePackage, (_event, request) =>
    wrapIpc(() => diagnosticsService.createDiagnosticPackage(request))
  );
  timedHandle(ipcChannels.diagnosticsRunChecks, () =>
    wrapIpc(() => diagnosticsService.runChecks(taskSchedulerService.getStatus()))
  );
}
