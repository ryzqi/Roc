# Reviewed Zenodo publication

## Local preparation contract

The main process prepares an immutable review receipt from an approved export. Local preparation performs no network requests and stores no credentials. The separately authorized connector below handles remote operations.

The user selects 1–20 exact archive or public bundle paths and distinct upload names. Source tuples and case-insensitive upload names must be unique. Names are ASCII identifiers, bounded to 200 characters. Each file and the whole upload are limited to 512 MiB. The main process verifies the complete export, current source versions, scientific review and export approval, then streams the selected bytes through SHA256 and MD5. MD5 is the checksum used by Zenodo; SHA256 remains the local byte identity. Files are opened without following symlinks, read in 1 MiB blocks, and checked for size, modification time and digest changes.

The upload metadata explicitly declares publication type, title, description, publication date, open access, license ID, creators and version. The supported publication types are article, preprint and report. Public text uses the export layer's existing private-value rejection. No missing author, license or access choice is filled in.

`research.zenodo.prepare` requires the main IPC human sender for the exact project. Privacy, file licenses and authors each require an explicit true declaration. Wire requests cannot supply an actor or grant themselves authority. The receipt preserves the selected environment, exact request, main sender, upload bytes, export/source hashes and creation time.

SQLite migration 59 adds `research_zenodo_preparations`, with project ownership and one immutable preparation per project/request ID. An identical retry returns the original receipt; a different request with that ID fails. Concurrent retries return one receipt. Historical reads remain available after a project is archived, while new preparation and current-source validation fail.

Readback checks the physical row identity, project, request ID, timestamp, exact selected file tuples and both receipt hashes. Hashes are calculated after schema normalization, so real export consumer field ordering cannot change the sealed identity. The export repository also verifies the physical export ID, project, request, artifact and status before a publication consumer can use it.

The four generated IPC methods are `getZenodoInputs`, `prepareZenodo`, `getZenodoPreparation` and `getZenodoPreparations`. History pages contain at most 20 receipts. Outputs expose public file identities and hashes; workspace and storage roots remain in the main process.

## Main-process remote connector

The official developer documentation was inspected on 2026-11-06: [Zenodo REST API](https://developers.zenodo.org/).

Production uses `https://zenodo.org/api/`; the sandbox uses `https://sandbox.zenodo.org/api/` and has separate accounts and tokens. Authentication uses a Bearer header. Draft writes need `deposit:write`; publication actions need `deposit:actions`. A draft create returns 201. Upload uses the returned bucket URL and the new files API, whose checksum is prefixed with `md5:`. A publish response of 202 represents acceptance, and requires a subsequent remote state query before public completion can be reported.

The documentation does not establish a server idempotency-key contract. Unknown create or publish outcomes must be queried before any further mutation. The connector persists operation identity before a remote write, saves the remote ID and verified file checksums, and requires a separate human final publication decision bound to the local preparation and complete remote draft snapshot.

The current formal deposition representation uses `inprogress`, `done`, and `error`, integer file sizes, and ISO modified timestamps with timezone offsets. The official new-files API PUT returns 200; its upload receipt contains `key`, integer `size`, and an `md5:` checksum. The deposition read uses filename, integer filesize and raw MD5. The old Quickstart's `unsubmitted` and string filesize examples are not accepted. The current primary [Invenio files REST implementation](https://raw.githubusercontent.com/inveniosoftware/invenio-files-rest/master/invenio_files_rest/views.py) was also inspected on 2026-11-06 to confirm the documented PUT status.

Tokens use the plugin's existing `context.secrets` facade backed by `SecretManager`; sandbox and production use separate encrypted keys. Credential status returns only `stored`. Save, clear, start, resume, final approve, publish, and cancel require the exact main human capability and project. Credentials are never returned, logged, placed in query parameters, persisted in operation receipts or forwarded through redirects. A response echoing the actual credential is rejected. Storage failures return a fixed safe error.

Transport requests reject redirects and bound response JSON to 4 MiB, with a 30-second ordinary timeout and 180-second upload timeout. Cancellation interrupts response reads. Shared admission governs each origin at 1 request/second and 300/hour, with 429 cooldown and a circuit breaker. There is no automatic retry loop.

Migration 60 adds operation and append-only final approval tables. Each preparation has at most one operation. Its UUID is persisted before create, with `urn:uuid:<UUID>` added to public metadata as `isAlternateIdentifier`. Unknown creates have no resend path: a user-requested collection scan reads up to ten pages of 100 depositions with `all_versions=1`. Only a complete scan with exactly one marker match may bind the remote ID, followed by a deposition read. Known reads require the exact ID, stable owner and operation marker.

Uploads use a verified private staged copy, created with 0700 directory and 0600 file permissions. One-MiB blocks check source size, SHA256, MD5 and modification time. The completed file is made readonly, opened readonly and unlinked before transmission. Current approval and source identities are checked again before sending. PUT supplies content length and octet-stream; both upload and subsequent deposition receipts must match. Unknown uploads query the deposition first; matching files are never uploaded again.

Complete public remote metadata and all files are sealed in the snapshot. Metadata or file drift preserves the new snapshot and requires review again. Independent final approval binds the preparation hash, full remote hash, revision and main actor. Exact approval replay returns the original immutable grant. Publish rechecks source approval and actual bytes, queries the remote review, rechecks local sources, and persists `publish_requested` before POST. Only `done` plus submitted, DOI, record ID and verified record URL establishes publication. A 202 alone or lost reply remains unknown; the same grant cannot resend publication after a requested, unknown or completed result.

Project archive/release and plugin shutdown cancel ongoing requests. Restart marks interrupted mutations unknown and performs no automatic network work. Physical row identity, nested hashes, project ownership, revisions and approval records are validated on reads; failed transactional writes roll back rather than producing a success receipt.

The eleven connector IPC methods are `saveZenodoCredential`, `clearZenodoCredential`, `getZenodoCredentialStatus`, `startZenodoOperation`, `getZenodoOperation`, `getZenodoOperations`, `refreshZenodoOperation`, `resumeZenodoOperation`, `approveZenodoPublication`, `publishZenodo` and `cancelZenodoOperation`.

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


## Connector verification

A7B focused regressions pass 21/21 and fresh build/typecheck passes. Native P0 passes 19/19, including the standard approved ZIP and compiled PDF consumer through real staging, generated strict IPC, main sender, actual SHA256/MD5/size checks, independent grant/replay, a lost publish reply with zero duplicate POST, queried DOI completion, and backed-up/reopened operation and approval SQLite records. The SecretManager integration verifies ciphertext excludes plaintext, environment separation, and encrypted SQLite backup/reopen with an isolated AES-GCM port. This does not establish live native safeStorage plus live Zenodo acceptance.

A7B is **Verified passing** for local connector engineering: full unit 1440/1440, Harness 94/94, related renderer 16/16, startup 13/13 with zero renderer errors, generated IPC current, eager renderer 1,134,468 bytes in six files, and whitespace checks pass. Commands in the repository root:

```sh
node --test tests/unit/research-zenodo-publication.test.mjs
pnpm build
node scripts/run-research-p0.mjs
pnpm test:unit
pnpm harness:eval
node --test tests/renderer/export-publication.test.mjs tests/renderer/artifact-production.test.mjs
node scripts/smoke-electron.mjs
pnpm check:ipc
pnpm check:renderer-chunks
git diff --check
```

Logs are `.artifacts/research-optimization/zenodo-a7b-*`; native evidence includes `p0-production/<task-id>/zenodo-publication.json`, the publication SQLite backup and encrypted secret SQLite backup. Live remote writes and independent scientific acceptance remain **Blocked, not run** for the authorization and credential limits above.
