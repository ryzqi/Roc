import type { LogService } from './services/log-service';

type ShellLike = {
  openExternal: (url: string) => void | Promise<void>;
};

export type ExternalNavigationPolicyInput = {
  shell: ShellLike;
  logService: Pick<LogService, 'warn'>;
};

const allowedExternalSchemes = new Set(['http:', 'https:']);

export function handleExternalNavigation(
  url: string,
  input: ExternalNavigationPolicyInput
): { action: 'deny' } {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    input.logService.warn('Blocked invalid top-level navigation.', {
      service: 'external-link-policy',
      component: 'handleExternalNavigation'
    });
    return { action: 'deny' };
  }

  if (!allowedExternalSchemes.has(parsedUrl.protocol)) {
    input.logService.warn('Blocked top-level navigation with unsupported scheme.', {
      service: 'external-link-policy',
      component: 'handleExternalNavigation',
      metadata: {
        scheme: parsedUrl.protocol
      }
    });
    return { action: 'deny' };
  }

  const reportFailure = (error: unknown): void => {
    input.logService.warn('Failed to open the external OS browser.', {
      service: 'external-link-policy',
      component: 'handleExternalNavigation',
      metadata: {
        error: error instanceof Error ? error.message : String(error)
      }
    });
  };
  try {
    void Promise.resolve(input.shell.openExternal(parsedUrl.toString())).catch(reportFailure);
  } catch (error) {
    reportFailure(error);
  }
  return { action: 'deny' };
}
