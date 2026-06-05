# Release Candidate Checklist

## Automated Gates

Run these commands from `F:\Code\Roc` before preparing a Windows release candidate.

```powershell
pnpm test
pnpm typecheck
pnpm build
pnpm package:dir
pnpm verify:native-packaging
pnpm verify:paths
pnpm smoke:electron
pnpm smoke:performance
```

## Evidence Required

- `release/win-unpacked/Roc.exe` exists after `pnpm package:dir`.
- The Electron smoke artifact records renderer readiness, native module probe, IPC evidence, release readiness, and packaged executable path.
- The performance smoke artifact records measured startup and memory values.
- Release readiness keeps installer, updater, and signing as absent or manual-required until an approved plan adds them.
