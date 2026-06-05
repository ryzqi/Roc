export function readReleaseIdentity(input) {
  return {
    appId: readTopLevelScalar(input.builderConfigText, 'appId'),
    productName: readTopLevelScalar(input.builderConfigText, 'productName'),
    executableName: readNestedScalar(input.builderConfigText, 'win', 'executableName'),
    version: input.packageJson.version
  };
}

export function buildReleaseReadinessSnapshot(input) {
  const dependencies = {
    ...(input.packageJson.dependencies ?? {}),
    ...(input.packageJson.devDependencies ?? {})
  };
  const sourceText = Object.values(input.sourceTexts ?? {}).join('\n');
  const hasUpdater = Object.prototype.hasOwnProperty.call(dependencies, 'electron-updater');
  const hasFileAssociations = /\bfileAssociations\s*:/u.test(input.builderConfigText);
  const isDirOnlyTarget = /\btarget\s*:\s*\r?\n\s*-\s*dir\b/u.test(input.builderConfigText);
  const signingDisabled = /\bsignAndEditExecutable\s*:\s*false\b/u.test(input.builderConfigText);
  const hasAppProtocol = /\bsetAsDefaultProtocolClient\s*\(/u.test(sourceText);
  const hasWindowsToast = /\bnew\s+Notification\s*\(|\bNotification\s*\./u.test(sourceText);
  const hasTaskbarIntegration = /\bsetJumpList\s*\(|\bsetUserTasks\s*\(|\bsetProgressBar\s*\(/u.test(sourceText);
  const hasCrashReporter = /\bcrashReporter\s*\.\s*start\s*\(/u.test(sourceText);
  const hasNativeClipboard = /\b(?:clipboard|clipboardApi)\s*\.\s*write/u.test(sourceText);
  const hasFileDrop = /\baddEventListener\s*\(\s*['"]drop['"]|\bonDrop\s*=|\bondrop\s*=/u.test(sourceText);
  const hasMicrokernelRuntime =
    /\bcreateMainKernelBootstrap\b/u.test(sourceText) &&
    /\bnew\s+KernelRuntime\s*\(/u.test(sourceText) &&
    /\brootDir\s*:\s*pluginDataDir\b/u.test(sourceText);
  const hasPluginDataMigrationMarker =
    /\bactivatePluginDataMigration\b/u.test(sourceText) &&
    /\bwriteMigrationMarker\b/u.test(sourceText) &&
    /\.migration-complete\.json/u.test(sourceText);

  return {
    identity: readReleaseIdentity(input),
    runtime: {
      microkernelRuntime: {
        status: hasMicrokernelRuntime ? 'present' : 'absent',
        evidence: hasMicrokernelRuntime
          ? 'Main process starts KernelRuntime through createMainKernelBootstrap.'
          : 'Main process microkernel runtime activation evidence was not included in release readiness.'
      },
      pluginDataMigration: {
        status: hasPluginDataMigrationMarker ? 'present' : 'absent',
        evidence: hasPluginDataMigrationMarker
          ? 'Plugin data migration writes .migration-complete.json before runtime activation completes.'
          : 'Plugin data migration completion marker evidence was not included in release readiness.'
      }
    },
    integrations: {
      appProtocol: {
        status: hasAppProtocol ? 'present' : 'absent',
        evidence: hasAppProtocol
          ? 'Main process registers a system app protocol.'
          : 'No system app protocol is registered; roc-preview remains an internal protocol only.'
      },
      fileAssociation: {
        status: hasFileAssociations ? 'present' : 'absent',
        evidence: hasFileAssociations
          ? 'electron-builder.yml declares fileAssociations.'
          : 'electron-builder.yml has no fileAssociations block.'
      },
      windowsToast: {
        status: hasWindowsToast ? 'present' : 'absent',
        evidence: hasWindowsToast
          ? 'Main process uses Electron Notification APIs.'
          : 'No main-process Notification or toast click handler is registered.'
      },
      taskbarJumpList: {
        status: hasTaskbarIntegration ? 'present' : 'absent',
        evidence: hasTaskbarIntegration ? 'Windows taskbar integration API is wired.' : 'No Jump List or taskbar progress API is wired.'
      },
      installerSigningUpdater: {
        status: isDirOnlyTarget && signingDisabled && !hasUpdater ? 'absent' : 'partial',
        evidence:
          isDirOnlyTarget && signingDisabled && !hasUpdater
            ? 'Windows target is dir, signAndEditExecutable is false, and no updater dependency is declared.'
            : 'Release packaging is partially configured; installer, signing, or updater evidence needs review.'
      },
      crashReporter: {
        status: hasCrashReporter ? 'present' : 'absent',
        evidence: hasCrashReporter
          ? 'Electron crashReporter.start is wired.'
          : 'Electron crashReporter is not started; diagnostic package/logs remain the local fallback.'
      },
      nativeClipboard: {
        status: hasNativeClipboard ? 'partial' : 'absent',
        evidence: hasNativeClipboard
          ? 'Native context menu writes selected text through main-process clipboard; renderer copy paths remain plain text.'
          : 'No main-process clipboard API usage was found.'
      },
      nativeFileDialogs: {
        status: 'partial',
        evidence: 'Open dialogs are native; no save/export dialog is exposed yet.'
      },
      fileDragDrop: {
        status: hasFileDrop ? 'partial' : 'absent',
        evidence: hasFileDrop ? 'Renderer drop handling exists; payload validation needs review.' : 'No renderer drop zone accepts file path payloads.'
      },
      accessibility: {
        status: 'manual-required',
        evidence: 'ARIA/focus tests exist; Narrator, large font, and high contrast remain manual checks.'
      }
    }
  };
}

function readTopLevelScalar(text, key) {
  const match = new RegExp(`^${escapeRegExp(key)}\\s*:\\s*([^\\r\\n#]+)`, 'mu').exec(text);
  return match?.[1]?.trim() ?? null;
}

function readNestedScalar(text, section, key) {
  const lines = text.split(/\r?\n/u);
  let inSection = false;
  for (const line of lines) {
    if (/^\S/u.test(line)) {
      inSection = line.trim() === `${section}:`;
      continue;
    }
    if (!inSection) {
      continue;
    }
    const match = new RegExp(`^\\s+${escapeRegExp(key)}\\s*:\\s*([^\\r\\n#]+)`, 'u').exec(line);
    if (match !== null) {
      return match[1].trim();
    }
  }
  return null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
