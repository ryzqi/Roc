export type ReleaseIntegrationStatus = 'absent' | 'partial' | 'manual-required' | 'present';

export type ReleaseReadinessIntegration = {
  status: ReleaseIntegrationStatus;
  evidence: string;
};

export type ReleaseReadinessSnapshot = {
  identity: {
    appId: string;
    productName: string;
    executableName: string;
    version: string;
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

export function buildReleaseReadinessSnapshot(input: {
  appId: string;
  productName: string;
  executableName: string;
  version: string;
  builderConfigText: string;
  packageJson: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
}): ReleaseReadinessSnapshot {
  const dependencies = {
    ...input.packageJson.dependencies,
    ...input.packageJson.devDependencies
  };
  const hasUpdater = Object.prototype.hasOwnProperty.call(dependencies, 'electron-updater');
  const hasFileAssociations = /\bfileAssociations\s*:/u.test(input.builderConfigText);
  const isDirOnlyTarget = /\btarget\s*:\s*\r?\n\s*-\s*dir\b/u.test(input.builderConfigText);
  const signingDisabled = /\bsignAndEditExecutable\s*:\s*false\b/u.test(input.builderConfigText);

  return {
    identity: {
      appId: input.appId,
      productName: input.productName,
      executableName: input.executableName,
      version: input.version
    },
    integrations: {
      appProtocol: {
        status: 'absent',
        evidence: 'No system app protocol is registered; roc-preview remains an internal protocol only.'
      },
      fileAssociation: {
        status: hasFileAssociations ? 'present' : 'absent',
        evidence: hasFileAssociations
          ? 'electron-builder.yml declares fileAssociations.'
          : 'electron-builder.yml has no fileAssociations block.'
      },
      windowsToast: {
        status: 'absent',
        evidence: 'No main-process Notification or toast click handler is registered.'
      },
      taskbarJumpList: {
        status: 'absent',
        evidence: 'No Jump List or taskbar progress API is wired.'
      },
      installerSigningUpdater: {
        status: isDirOnlyTarget && signingDisabled && !hasUpdater ? 'absent' : 'partial',
        evidence:
          isDirOnlyTarget && signingDisabled && !hasUpdater
            ? 'Windows target is dir, signAndEditExecutable is false, and no updater dependency is declared.'
            : 'Release packaging is partially configured; installer, signing, or updater evidence needs review.'
      },
      crashReporter: {
        status: 'absent',
        evidence: 'Electron crashReporter is not started; diagnostic package/logs remain the local fallback.'
      },
      nativeClipboard: {
        status: 'partial',
        evidence: 'Native context menu writes selected text through main-process clipboard; renderer copy paths remain plain text.'
      },
      nativeFileDialogs: {
        status: 'partial',
        evidence: 'Open dialogs are native; no save/export dialog is exposed yet.'
      },
      fileDragDrop: {
        status: 'absent',
        evidence: 'No renderer drop zone accepts file path payloads.'
      },
      accessibility: {
        status: 'manual-required',
        evidence: 'ARIA/focus tests exist; Narrator, large font, and high contrast remain manual checks.'
      }
    }
  };
}
