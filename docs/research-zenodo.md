# Reviewed Zenodo publication

## Local preparation contract

The main process prepares an immutable review receipt from an approved export. This increment performs no network requests and stores no credentials.

The user selects 1–20 exact archive or public bundle paths and distinct upload names. Source tuples and case-insensitive upload names must be unique. Names are ASCII identifiers, bounded to 200 characters. Each file and the whole upload are limited to 512 MiB. The main process verifies the complete export, current source versions, scientific review and export approval, then streams the selected bytes through SHA256 and MD5. MD5 is the checksum used by Zenodo; SHA256 remains the local byte identity. Files are opened without following symlinks, read in 1 MiB blocks, and checked for size, modification time and digest changes.

The upload metadata explicitly declares publication type, title, description, publication date, open access, license ID, creators and version. The supported publication types are article, preprint and report. Public text uses the export layer's existing private-value rejection. No missing author, license or access choice is filled in.

`research.zenodo.prepare` requires the main IPC human sender for the exact project. Privacy, file licenses and authors each require an explicit true declaration. Wire requests cannot supply an actor or grant themselves authority. The receipt preserves the selected environment, exact request, main sender, upload bytes, export/source hashes and creation time.

SQLite migration 59 adds `research_zenodo_preparations`, with project ownership and one immutable preparation per project/request ID. An identical retry returns the original receipt; a different request with that ID fails. Concurrent retries return one receipt. Historical reads remain available after a project is archived, while new preparation and current-source validation fail.

Readback checks the physical row identity, project, request ID, timestamp, exact selected file tuples and both receipt hashes. Hashes are calculated after schema normalization, so real export consumer field ordering cannot change the sealed identity. The export repository also verifies the physical export ID, project, request, artifact and status before a publication consumer can use it.

The four generated IPC methods are `getZenodoInputs`, `prepareZenodo`, `getZenodoPreparation` and `getZenodoPreparations`. History pages contain at most 20 receipts. Outputs expose public file identities and hashes; workspace and storage roots remain in the main process.

## Provider contract for the next increment

The official developer documentation was inspected on 2026-11-06: [Zenodo REST API](https://developers.zenodo.org/).

Production uses `https://zenodo.org/api/`; the sandbox uses `https://sandbox.zenodo.org/api/` and has separate accounts and tokens. Authentication uses a Bearer header. Draft writes need `deposit:write`; publication actions need `deposit:actions`. A draft create returns 201. Upload uses the returned bucket URL and the new files API, whose checksum is prefixed with `md5:`. A publish response of 202 represents acceptance, and requires a subsequent remote state query before public completion can be reported.

The documentation does not establish a server idempotency-key contract. Unknown create or publish outcomes must be queried before any further mutation. The future connector must persist operation identity before a remote write, save the remote ID and verified file checksums, and require a separate human final publication decision bound to the local preparation and remote draft snapshot.

## Verification

All commands run in the repository root. Local preparation is **Verified passing**: related units 47/47, the repaired monitor migration suite 14/14, Harness 94/94, renderer 16/16, native P0 19/19 and startup 13/13 with no renderer errors. Build/typecheck, generated IPC, renderer chunk bounds (1,134,468 eager bytes in six files) and whitespace checks pass. The complete unit run passed 1418/1419; its sole failure was the monitor fixture asserting the newest schema version was 58. The repaired fixture now exercises the actual 57-to-58 upgrade and retains original observations and migration receipts; its final 14/14 focused run passed.

```sh
node --test tests/unit/research-zenodo-preparation.test.mjs \
  tests/unit/research-export-publication.test.mjs \
  tests/unit/research-export-public-files.test.mjs \
  tests/unit/research-export-public-projection.test.mjs \
  tests/unit/research-export-body-gate.test.mjs \
  tests/unit/research-task-identity.test.mjs \
  tests/unit/database-migrations.test.mjs
pnpm build
node scripts/run-research-p0.mjs
pnpm test:unit
node --test tests/unit/research-monitors.test.mjs
pnpm harness:eval
node --test tests/renderer/export-publication.test.mjs \
  tests/renderer/artifact-production.test.mjs
node scripts/smoke-electron.mjs
pnpm check:ipc
pnpm check:renderer-chunks
git diff --check
```

The focused preparation regressions cover strict human IPC, exact/concurrent retry, source and approval changes, archive during capture, project isolation, bounded history, receipt corruption, transactional rollback and real multi-block hashing/cancellation.

The native standard research workflow verifies a real approved ZIP and compiled PDF through the production export consumer, main capability registry and generated IPC adapter. It checks actual SHA256/MD5/size identities, replay, missing selection, swapped export identity, archive tampering, and a backed-up/reopened SQLite receipt. These are local engineering fixtures. They do not establish live sandbox success, publication permission, license validity for real research, or scientific quality.

Initial native acceptance exposed a consumer field-order hashing defect; the final implementation normalizes inputs before sealing them. The initial unit fixture also attempted to start an export-stage run without an approved manuscript; its project ownership fixture now starts in reading, while the native consumer retains the complete approved export workflow.

Evidence and exact command logs live under `.artifacts/research-optimization/zenodo-a7a-*`. The native receipt is stored under `p0-production/<task-id>/zenodo-preparation.json` beside its SQLite backup.

Live sandbox and production publication are **Blocked, not run** until isolated credentials and authorization covering the remote target are supplied.
