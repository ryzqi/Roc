# Roc 0.1.0 Windows Release Candidate Notes

## Candidate

- Package version: `0.1.0`
- Windows artifact path: `F:\Code\Roc\release\win-unpacked\Roc.exe`
- Package format: Windows unpacked directory package

## Verification Evidence

- Electron smoke artifact: `F:\Code\Roc\.artifacts\wave1\electron-smoke.json`
- Electron smoke checked at: `2026-06-05T06:32:22.104Z`
- Electron smoke target: `packaged-exe`, `F:\Code\Roc\release\win-unpacked\Roc.exe`
- Performance smoke artifact: `F:\Code\Roc\.artifacts\wave1\performance-smoke.json`
- Performance smoke checked at: `2026-06-05T06:32:41.345Z`
- Performance smoke target: `packaged-exe`, `F:\Code\Roc\release\win-unpacked\Roc.exe`
- Native module probe: `betterSqlite3` loaded; diagnostics sample `perf_eb4d3454-a2c4-42b5-8ff5-774a052e8048`
- Performance initial sample: RSS `258.2 MB`, heap used `31.3 MB`, renderer loaded `279.1393 ms`, ready to show `423.9507 ms`

## Migration Evidence

- Migration requirements file: `F:\Code\Roc\docs\release\microkernel-migration.md`
- Migration completion marker path to capture for a user profile: `<Roc data root>\plugin-data\.migration-complete.json`
- Runtime readiness evidence reports `microkernelRuntime` as `present`.
- Runtime readiness evidence reports `pluginDataMigration` as `present`.

## Known Release Gaps

- `appProtocol`: absent. No system app protocol is registered; `roc-preview` remains internal only.
- `fileAssociation`: absent. `electron-builder.yml` has no `fileAssociations` block.
- `windowsToast`: absent. No main-process Notification or toast click handler is registered.
- `taskbarJumpList`: absent. No Jump List or taskbar progress API is wired.
- `installerSigningUpdater`: absent. Windows target is `dir`, `signAndEditExecutable` is `false`, and no updater dependency is declared.
- `crashReporter`: absent. Electron `crashReporter` is not started; diagnostic package/logs remain the local fallback.
- `nativeClipboard`: partial. Native context menu writes selected text through main-process clipboard; renderer copy paths remain plain text.
- `nativeFileDialogs`: partial. Open dialogs are native; no save/export dialog is exposed yet.
- `fileDragDrop`: absent. No renderer drop zone accepts file path payloads.
- `accessibility`: manual-required. ARIA/focus tests exist; Narrator, large font, and high contrast remain manual checks.

## Deferred Release Work

Installer, updater, signing, Sentry, website, macOS, Linux, and announcement work are not included in this release candidate evidence.
