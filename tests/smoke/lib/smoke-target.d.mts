export type SmokeTarget =
  | {
      kind: 'packaged-exe';
      path: string;
      executablePath: string;
      launchArgs: [];
    }
  | {
      kind: 'dist-main-fallback';
      path: string;
      executablePath: undefined;
      launchArgs: [string];
    };

export function resolveSmokeTarget(input?: {
  env?: Record<string, string | undefined>;
  packagedExe?: string;
  distMainPath?: string;
  exists?: (path: string) => boolean;
}): SmokeTarget;
