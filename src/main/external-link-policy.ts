import type { LogService } from './services/log-service';

type ShellLike = {
  openExternal: (url: string) => unknown;
};

type ExternalLinkPolicyInput = {
  shell: ShellLike;
  logService: Pick<LogService, 'append'>;
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
    input.logService.append({
      level: 'warn',
      message: 'Blocked invalid external link.',
      data: {
        url
      }
    });
    return { action: 'deny' };
  }

  if (!allowedExternalSchemes.has(parsedUrl.protocol)) {
    input.logService.append({
      level: 'warn',
      message: 'Blocked external link with unsupported scheme.',
      data: {
        scheme: parsedUrl.protocol
      }
    });
    return { action: 'deny' };
  }

  void input.shell.openExternal(parsedUrl.toString());
  return { action: 'deny' };
}
