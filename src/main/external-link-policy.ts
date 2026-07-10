import type { LogService } from './services/log-service';

type ShellLike = {
  openExternal: (url: string) => unknown;
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

  void input.shell.openExternal(parsedUrl.toString());
  return { action: 'deny' };
}
