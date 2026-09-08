# Release Candidate Checklist

## Verification Commands

- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc test`
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc typecheck`
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc build`
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc package:dir`
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc verify:native-packaging`
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc verify:paths`
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc smoke:electron`
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc smoke:performance`

- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc package:mac`
- [ ] `rtk pnpm --dir /Users/Apple_501/Desktop/Roc/Roc smoke:mac`

## Owner Approval

Get owner approval before:

- tagging a release
- pushing to `main`
- publishing installer artifacts
- changing supported platform or architecture targets
- adding signing certificates or update server config
