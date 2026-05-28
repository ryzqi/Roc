import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildReleaseReadinessSnapshot } from '../../src/main/release-readiness';

describe('release readiness evidence', () => {
  it('reports unsupported Windows release integrations as absent instead of implied', () => {
    const snapshot = buildReleaseReadinessSnapshot({
      appId: 'com.roc.desktop',
      productName: 'Roc',
      executableName: 'Roc',
      version: '0.1.0',
      builderConfigText: readFileSync(new URL('../../electron-builder.yml', import.meta.url), 'utf8'),
      packageJson: JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    });

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
});
