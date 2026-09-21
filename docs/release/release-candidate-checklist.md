# Release Candidate Checklist

## Verification Commands

- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test`
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc typecheck`
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc build`
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc package:dir`
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc verify:native-packaging`
- [ ] packaged app contains `Contents/Resources/research-toolchain/manifest.json` and `licenses/python-packages.json` for the current architecture
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc verify:paths`
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc smoke:electron`
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc smoke:performance`

- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc package:mac`
- [ ] `package:mac` 产出当前架构 `Roc.app`（Apple Silicon：`release/mac-arm64/Roc.app`；Intel：`release/mac/Roc.app`），不生成 zip/dmg
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc smoke:mac`

## Owner Approval

Get owner approval before:

- tagging a release
- pushing to `main`
- publishing the packaged `.app`
- changing supported macOS architecture targets
- adding signing certificates or update server config
