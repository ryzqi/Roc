# Release Candidate Checklist

## Verification Commands

- `pnpm test`
- `pnpm typecheck`
- `pnpm build`
- `pnpm package:dir`
- `pnpm verify:native-packaging`
- `pnpm verify:paths`
- `pnpm smoke:electron`
- `pnpm smoke:performance`

## Owner Approval

Get owner approval before:

- tagging a release
- pushing to `main`
- publishing installer artifacts
- changing `electron-builder.yml` targets beyond the current Windows directory package
- adding signing certificates or update server config
