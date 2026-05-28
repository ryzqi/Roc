import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildReleaseReadinessSnapshot, readReleaseIdentity } from '../smoke/lib/release-readiness.mjs';

describe('release readiness evidence', () => {
  it('reports unsupported Windows release integrations as absent instead of implied', () => {
    const builderConfigText = readFileSync(new URL('../../electron-builder.yml', import.meta.url), 'utf8');
    const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const snapshot = buildReleaseReadinessSnapshot({
      builderConfigText,
      packageJson,
      sourceTexts: {
        main: readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8'),
        windowsHost: readFileSync(new URL('../../src/main/windows-host-service.ts', import.meta.url), 'utf8'),
        nativeContextMenu: readFileSync(new URL('../../src/main/native-context-menu.ts', import.meta.url), 'utf8')
      }
    });

    expect(snapshot.identity).toEqual(readReleaseIdentity({ builderConfigText, packageJson }));
    expect(snapshot.identity).toEqual({
      appId: 'com.roc.desktop',
      productName: 'Roc',
      executableName: 'Roc',
      version: '0.1.0'
    });
    expect(snapshot.integrations).toEqual({
      appProtocol: {
        status: 'absent',
        evidence: 'No system app protocol is registered; roc-preview remains an internal protocol only.'
      },
      fileAssociation: {
        status: 'absent',
        evidence: 'electron-builder.yml has no fileAssociations block.'
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
        status: 'absent',
        evidence: 'Windows target is dir, signAndEditExecutable is false, and no updater dependency is declared.'
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
    });
  });

  it('does not report absent when release APIs are wired in source or config', () => {
    const snapshot = buildReleaseReadinessSnapshot({
      builderConfigText: [
        'appId: com.example.changed',
        'productName: Changed',
        'win:',
        '  executableName: ChangedExe',
        '  signAndEditExecutable: true',
        '  target:',
        '    - nsis',
        'fileAssociations:',
        '  - ext: roc'
      ].join('\n'),
      packageJson: {
        version: '9.8.7',
        dependencies: {
          'electron-updater': '1.0.0'
        }
      },
      sourceTexts: {
        main: [
          'app.setAsDefaultProtocolClient("roc")',
          'new Notification({ title: "ready" })',
          'crashReporter.start({ submitURL: "https://example.invalid" })',
          'mainWindow.setProgressBar(0.5)'
        ].join('\n'),
        windowsHost: 'app.setUserTasks([{ program: "Roc.exe" }])',
        nativeContextMenu: 'clipboardApi.writeText("copy")',
        renderer: 'window.addEventListener("drop", () => undefined)'
      }
    });

    expect(snapshot.identity).toEqual({
      appId: 'com.example.changed',
      productName: 'Changed',
      executableName: 'ChangedExe',
      version: '9.8.7'
    });
    expect(snapshot.integrations.appProtocol.status).toBe('present');
    expect(snapshot.integrations.fileAssociation.status).toBe('present');
    expect(snapshot.integrations.windowsToast.status).toBe('present');
    expect(snapshot.integrations.taskbarJumpList.status).toBe('present');
    expect(snapshot.integrations.installerSigningUpdater.status).toBe('partial');
    expect(snapshot.integrations.crashReporter.status).toBe('present');
    expect(snapshot.integrations.nativeClipboard.status).toBe('partial');
    expect(snapshot.integrations.fileDragDrop.status).toBe('partial');
  });
});
