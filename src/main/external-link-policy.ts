import type { LogService } from './services/log-service';

type ShellLike = {
  openExternal: (url: string) => unknown;
};

type ExternalLinkPolicyInput = {
  shell: ShellLike;
  logService: Pick<LogService, 'warn'>;
};

const allowedExternalSchemes = new Set(['http:', 'https:']);

export function handleExternalWindowOpen(
  url: string,
  input: ExternalLinkPolicyInput
): { action: 'deny' } {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    input.logService.warn('Blocked invalid external link.', {
      service: 'external-link-policy',
      component: 'handleExternalWindowOpen',
      metadata: {
        url
      }
    });
    return { action: 'deny' };
  }

  if (!allowedExternalSchemes.has(parsedUrl.protocol)) {
    input.logService.warn('Blocked external link with unsupported scheme.', {
      service: 'external-link-policy',
      component: 'handleExternalWindowOpen',
      metadata: {
        scheme: parsedUrl.protocol
      }
    });
    return { action: 'deny' };
  }

  void input.shell.openExternal(parsedUrl.toString());
  return { action: 'deny' };
}
