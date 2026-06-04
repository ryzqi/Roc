# Phase 6 Release Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 验证微内核重构可发布，准备 Windows release candidate 和迁移说明。

**Architecture:** 发布以当前仓库真实脚本和 Windows packaged smoke 为验收源。Installer、auto-updater、代码签名、官网、社媒发布不在本计划中默认执行；如果产品 owner 要求这些发布面，执行者必须先停下询问。

**Tech Stack:** pnpm, Vitest, electron-vite, electron-builder, existing smoke scripts.

---

## Dependencies

- Phase 1-5 已完成。
- `pnpm package:dir`, `pnpm smoke:electron`, `pnpm smoke:performance`, `pnpm verify:native-packaging`, `pnpm verify:paths` 均存在于 `package.json`。
- No release step may commit secrets, `.env.production`, signing certificates, or update server credentials.

## File Structure

- Create: `docs/release/microkernel-migration.md`
- Create: `docs/release/release-candidate-checklist.md`
- Create: `docs/release/rollback.md`
- Modify: `tests/main/release-readiness.test.ts`
- Modify: `tests/main/native-packaging.test.ts`
- Modify: `tests/main/package-scripts.test.ts`
- Optional after owner approval only: installer/updater/signing docs.

## Task 1: Release Readiness Gates

**Files:**
- Modify: `tests/main/release-readiness.test.ts`
- Modify: `tests/main/package-scripts.test.ts`
- Create: `docs/release/release-candidate-checklist.md`

- [ ] **Step 1: Update readiness tests**

Assert release readiness reports:
- microkernel runtime present.
- plugin migration complete marker present in smoke setup.
- installer/updater/signing remains `absent` or `manual-required` unless a separate approved plan adds it.
- package scripts referenced by release docs exist.

Run: `pnpm test -- tests/main/release-readiness.test.ts tests/main/package-scripts.test.ts`
Expected: FAIL until docs and readiness helper are updated.

- [ ] **Step 2: Write checklist**

Checklist must contain only commands that exist:

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

Run: `pnpm test -- tests/main/release-readiness.test.ts tests/main/package-scripts.test.ts`
Expected: PASS.

## Task 2: Migration Dry Run Documentation

**Files:**
- Create: `docs/release/microkernel-migration.md`
- Create: `docs/release/rollback.md`
- Test: `tests/main/migration/runtime-activation.test.ts`

- [ ] **Step 1: Write migration evidence requirements**

Document:
- source database path.
- backup path.
- target plugin data path.
- `.migration-complete.json` fields.
- row count and checksum evidence.
- rollback procedure using the backup copy.

Run: `pnpm test -- tests/main/migration/runtime-activation.test.ts`
Expected: PASS from Phase 5.

- [ ] **Step 2: Add rollback doc**

Rollback doc must say: close Roc, restore backup database, remove `plugin-data`, restart previous version. It must not say rollback happens automatically.

Run: `pnpm test -- tests/main/release-readiness.test.ts`
Expected: PASS.

## Task 3: Full Regression

**Files:**
- Modify only tests needed to make current release gates reflect microkernel behavior.

- [ ] **Step 1: Run unit and integration tests**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 2: Run typecheck and build**

Run: `pnpm typecheck`
Expected: PASS.

Run: `pnpm build`
Expected: PASS.

## Task 4: Packaged Verification

**Files:**
- Modify: `tests/main/native-packaging.test.ts` only if packaging contract changed.

- [ ] **Step 1: Build packaged directory**

Run: `pnpm package:dir`
Expected: PASS and `release/win-unpacked/Roc.exe` exists.

- [ ] **Step 2: Verify packaging contracts**

Run: `pnpm verify:native-packaging`
Expected: PASS.

Run: `pnpm verify:paths`
Expected: PASS.

- [ ] **Step 3: Run smoke tests**

Run: `pnpm smoke:electron`
Expected: PASS and smoke artifact records renderer ready, native module probe, IPC evidence, release readiness, and packaged executable path.

Run: `pnpm smoke:performance`
Expected: PASS and smoke artifact records actual startup and memory values.

## Task 5: Release Candidate Notes

**Files:**
- Create: `docs/release/rc-notes.md`

- [ ] **Step 1: Write notes from evidence**

Include:
- exact package version from `package.json`.
- exact smoke artifact paths.
- migration evidence file path.
- known release gaps from readiness snapshot.
- Windows artifact path.

Do not claim macOS, Linux, installer, updater, signing, Sentry, website, or social announcement unless separate evidence exists.

Run: `pnpm test -- tests/main/release-readiness.test.ts`
Expected: PASS.

## Task 6: Owner Approval Gate

**Files:**
- Modify: `docs/release/release-candidate-checklist.md`

- [ ] **Step 1: Add manual approval section**

Add a final section requiring owner approval before:
- tagging a release.
- pushing to `main`.
- publishing installer artifacts.
- changing `electron-builder.yml` targets beyond current Windows directory package.
- adding signing certificates or update server config.

Run: `pnpm test -- tests/main/package-scripts.test.ts tests/main/release-readiness.test.ts`
Expected: PASS.

## Phase 6 Verification

- [ ] `pnpm test`
- [ ] `pnpm typecheck`
- [ ] `pnpm build`
- [ ] `pnpm package:dir`
- [ ] `pnpm verify:native-packaging`
- [ ] `pnpm verify:paths`
- [ ] `pnpm smoke:electron`
- [ ] `pnpm smoke:performance`

## Phase 6 Exit Criteria

- Release candidate is backed by current tests, packaged smoke, and migration evidence.
- Release docs do not reference nonexistent scripts, credentials, certs, websites, or update servers.
- Any installer/updater/signing work is explicitly deferred behind owner approval.
