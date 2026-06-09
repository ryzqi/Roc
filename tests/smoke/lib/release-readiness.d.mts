export type ReleaseIntegrationStatus = 'absent' | 'partial' | 'manual-required' | 'present';

export type ReleaseReadinessIntegration = {
  status: ReleaseIntegrationStatus;
  evidence: string;
};

export type ReleaseReadinessSnapshot = {
  identity: {
    appId: string | null;
    productName: string | null;
    executableName: string | null;
    version: string | undefined;
  };
  runtime: {
    microkernelRuntime: ReleaseReadinessIntegration;
    legacyMonolithDataCleanup: ReleaseReadinessIntegration;
  };
  integrations: {
    appProtocol: ReleaseReadinessIntegration;
    fileAssociation: ReleaseReadinessIntegration;
    windowsToast: ReleaseReadinessIntegration;
    taskbarJumpList: ReleaseReadinessIntegration;
    installerSigningUpdater: ReleaseReadinessIntegration;
    crashReporter: ReleaseReadinessIntegration;
    nativeClipboard: ReleaseReadinessIntegration;
    nativeFileDialogs: ReleaseReadinessIntegration;
    fileDragDrop: ReleaseReadinessIntegration;
    accessibility: ReleaseReadinessIntegration;
  };
};

export function readReleaseIdentity(input: {
  builderConfigText: string;
  packageJson: { version?: string };
}): ReleaseReadinessSnapshot['identity'];

export function buildReleaseReadinessSnapshot(input: {
  builderConfigText: string;
  packageJson: {
    version?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  sourceTexts?: Record<string, string>;
}): ReleaseReadinessSnapshot;
