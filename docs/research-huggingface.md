# Hugging Face fixed revision resources

A4A captures anonymous model/dataset metadata in the current project. This is a metadata observation, not permission to download, proof of file use, license approval or evidence of scientific quality.

## Official contract

Contract checked on 2026-11-06 against the official [Hub SDK](https://github.com/huggingface/huggingface_hub/blob/main/src/huggingface_hub/hf_api.py), [Hub API](https://huggingface.co/docs/hub/api), [model cards](https://huggingface.co/docs/hub/model-cards) and [rate limits](https://huggingface.co/docs/hub/rate-limits).

Requests select `model` or `dataset`, the exact repository ID and a required lowercase 40-character commit SHA. Branches, tags and abbreviated revisions are refused. The only request is:

```text
GET https://huggingface.co/api/{models|datasets}/{repo}/revision/{sha}?blobs=true
```

The returned `id` and `sha` must match the request. `siblings` provides the complete file inventory for that revision. Every file requires `rfilename`, `size` and `blobId`; optional `lfs` preserves `size`, `sha256` and `pointerSize`. LFS size must match file size. The siblings contract uses `sha256`; the separate tree API's `oid` is not accepted as that field. Git blob SHA-1 and LFS raw SHA-256 are different identities; A4A verifies metadata structure and does not verify content bytes. Paths must be unique, relative and free of traversal/control characters.

The selected response fields preserve `private`, `gated` (`false`, `auto`, `manual`), `disabled`, `lastModified` and card `license`, `license_name`, `license_link`. Absent fields remain null. A reported empty inventory remains empty; a failed or incomplete inventory has null count. License text/link is a provider observation. Fixed revision content and current repository access conditions are separate facts. Anonymous 403/404 cannot establish global repository nonexistence. There is no token, resolve request, gated acceptance or inference endpoint in A4A.

The official source currently documents anonymous API limits of 500 per five-minute window and says they may change. Roc uses the existing stricter per-host governor: one request per second, 300 per hour, circuit cooldown and at most three GET attempts for 429/5xx. Transport admission shares cancellation and the 15-second total timeout. JSON is bounded to 4 MiB and inventory to 10,000 files; exceeding either fails the observation. Validated responses use the shared project/URL/accept cache (32 entries, 8 MiB, five minutes). Invalid responses do not enter cache. GET receipts preserve attempts, HTTP status, Retry-After, response hash and original fetched time. A cache hit preserves that time and records zero new GETs.

## Storage and capabilities

Migration 55 adds only `research_hf_observations`. Append-only snapshots bind observation ID, project, exact request ID, kind/repo/revision, endpoint, provider host, receipt and canonical content hash to the physical row. Rehashing a substituted snapshot cannot change row identity. Successful snapshots must retain matching returned repository/revision and fetch/hash receipts.

`research.huggingface.capture`, `cancel`, `history`, `read` are the four capabilities, with corresponding strict generated IPC methods `captureHuggingFace`, `cancelHuggingFaceCapture`, `getHuggingFaceHistory`, `getHuggingFaceObservation`. Summary replies omit inventory; history is limited to 50 and file pages to 100. Reads enforce project ownership. Exact stored requests replay without a new GET, including after archive. Changed parameters with the same request ID fail. Concurrent exact requests share one job. Archive refuses new observations, including archive during a query. Cancellation and plugin shutdown prevent late saves.

No DOI resource, literature item, experiment or approval is created or changed. File download and the existing reader UI are the following increments.

## Verification

Working directory: `/Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc`.

A4A status: **Verified passing**. Core16/16, related129/129, full unit1360/1360, native16/16, Harness94/94, related renderer57/57 and startup13/13 passed. Build (including typecheck), generated IPC and renderer chunk checks passed; eager graph1134468bytes in six files. Startup reported zero renderer errors.

```bash
node --test --test-timeout=30000 tests/unit/research-huggingface.test.mjs
pnpm build
node --test --test-concurrency=1 tests/unit/research-huggingface.test.mjs tests/unit/research-resources.test.mjs tests/unit/literature-import.test.mjs tests/unit/database-migrations.test.mjs
pnpm test:unit
node scripts/run-research-p0.mjs
pnpm harness:eval
node --test --test-concurrency=1 --test-timeout=180000 tests/renderer/research-resources.test.mjs tests/renderer/scholarly-relations.test.mjs tests/renderer/paper-reader.test.mjs tests/renderer/artifact-production.test.mjs
node scripts/smoke-electron.mjs
pnpm check:ipc
pnpm check:renderer-chunks
git diff --check
```

Logs: `.artifacts/research-optimization/hf-a4a-*.log`. The native Electron SQLite fixture retains database and receipts in `hf-a4a-native/`, with 101 files, 100+1 pagination, exact replay and reopen. All fixtures use synthetic responses. Live provider and downloaded bytes are **Blocked, not run** for this increment; no scientific or license conclusion is claimed.

## A4B reviewed content downloads

Contract checked against the official SDK [payload verifier](https://github.com/huggingface/huggingface_hub/blob/main/src/huggingface_hub/utils/_verification.py), [Git blob hashing](https://github.com/huggingface/huggingface_hub/blob/main/src/huggingface_hub/utils/sha.py) and [file download implementation](https://github.com/huggingface/huggingface_hub/blob/main/src/huggingface_hub/file_download.py). Ordinary Git files verify SHA1(`blob {size}\0` + payload); LFS payloads verify raw SHA256 against `lfs.sha256`. Both record actual raw SHA256 and verified size. A Git pointer blob ID is never compared to LFS payload bytes.

`startHuggingFaceDownload` requires a distinct main-process human context bound to the validated IPC sender and project. Requests select an existing successful observation ID/content hash, unique paths (1..20), total byte limit (0..512 MiB), wall timeout (1..120 seconds) and nonempty license review. Private/gated observations must explicitly be false; disabled=true refuses access, absent disabled remains an observed unknown for human review. Missing access fields are never inferred to allow download. Each file is limited to 256 MiB; selected sizes must fit the explicit total limit before any GET. No token, gated terms acceptance, provider write, model loading or execution exists.

Migration56 creates `research_hf_downloads`. The initial running receipt commits before GET and start returns its ID immediately. Fixed authorization JSON binds actor, request, observation, selection and creation identity independently of the evolving receipt. Updates use revision CAS and physical-row readback; prior verified files and transferred-byte observations cannot regress. Exact repeated requests return the existing state without network, even after archive; changed parameters sharing an ID refuse. New requests constitute explicit attempts. Archive prevents new work and file commit. Reads/history enforce project ownership, including missing-project refusal; history is paginated to50 records. Cancel is project scoped. Project deletion drains download jobs before deleting rows.

Downloads use only HTTPS Hub resolve URLs containing the approved complete commit SHA, individually encoded path segments and manual redirects (maximum5). Redirects are restricted to huggingface.co and its subdomains or hf.co subdomains; nondefault ports, URL userinfo and fragments refuse. Anonymous GETs omit cookies/credentials and authorization. CDN signed URLs and Location/query values never enter persisted receipts, error output or artifacts. Per-attempt receipts contain only file identity, actual host, timestamps, HTTP status, Retry-After and safe error codes. Shared metadata/download admission uses one aggregate huggingface.co governor (1RPS/300hour). HTTP429/5xx has at most3 attempts per hop, bounded by the total timeout; transport/partial stream failure never resumes or automatically retries payload bytes. Error responses are not downloaded as files.

Production stores resources under main-owned `research-resources/{sha256(projectId)}/{downloadId}/file-{index}`. Remote paths stay metadata, so case/Unicode names cannot collide in macOS storage. Directories reject symlinks; partial files are exclusive and no-follow, private mode0600. One file handle streams size and hashes; bounds are checked before writes. Verified files sync, close and rename before their receipt is committed. Failure/cancel clears only the active task's partial file and preserves previously verified files in an explicit partial outcome. Observed transferred bytes may exceed the write limit when an oversized chunk arrives; no truncation is used to disguise failure. `lastRecordedTransferredBytes` is the last durable observation, not a claim about unobserved network bytes after a crash. Periodic1MiB and boundary checkpoints retain real progress.

States are running/completed/failed/cancelled/interrupted. Cancellation reports signal acceptance separately from terminal status. Shutdown aborts and drains; restart removes known partials and marks persisted running rows interrupted without resume. Persistence failure remains an explicit degraded read/history/shutdown failure rather than reporting successful transfer. `getHuggingFaceDownload`, `getHuggingFaceDownloads`, `cancelHuggingFaceDownload` complete the four strict generated IPC methods. Renderer UI belongs to A4C.

A4B status: **Verified passing**. Final related133/133 (18 download cases), full unit1378/1378, native17/17 and Harness94/94 passed. Build (including typecheck), startup13/13 with zero renderer errors, generated IPC and renderer chunk checks passed; eager graph1134468bytes in six files. The full unit run completed with exit0 in348054ms.

```bash
node --test --test-concurrency=1 --test-timeout=60000 tests/unit/research-huggingface-downloads.test.mjs tests/unit/research-huggingface.test.mjs tests/unit/literature-import.test.mjs tests/unit/database-migrations.test.mjs tests/unit/plugin-capability-adapter.test.mjs
pnpm test:unit
pnpm build
node scripts/run-research-p0.mjs
pnpm harness:eval
node scripts/smoke-electron.mjs
pnpm check:ipc
pnpm check:renderer-chunks
git diff --check
```

Logs: `.artifacts/research-optimization/hf-a4b-*.log`; native database and physical-file hash receipt: `hf-a4b-native/`. All HTTP responses and payloads are synthetic; the native scenario uses actual Electron SQLite and filesystem. Live Hub access, gated acceptance and independent scientific/license assessment remain **Blocked, not run**. Initial checks found the string-only fetch fixture type mismatch, a migration55 test incorrectly tied to latest schema version, and a missing governor export in the new native fixture; each is recorded and corrected before final acceptance.

The first full unit run loaded the old migration55 assertion and failed1376/1377; the corrected final run passed1378/1378. Native setup first exposed a missing governor export and a duplicated foreign workspace path. A subsequent native run competed with the full unit process and timed out in the new download case and three existing scenarios (13/17); the unchanged final native source and assertions passed17/17 when run alone. No timeouts or assertions were weakened. Failing logs remain alongside final acceptance logs.

## A4C reader controls

The existing PaperReader lazily loads three Hugging Face modules under `reader-hf-toggle`. They share the reader's bounded 55% scroller with scholarly/resource disclosures. No route or shell is added. Explicit model/dataset, repository and complete lowercase commit SHA capture metadata; history has 20 records per page, inventory 50 files per page. Unknown access/rights fields remain unreported. Cross-page selections retain exact paths and sizes with the main-service 20-file/256 MiB limits.

Download review requires explicit selected files, total byte limit, timeout and license review. Dirty review locks observation/history switching and panel closure. An uncertain capture/download reply retains the exact request ID and parameters until exact retry or explicit discard, including readonly discard. New writes require current writable scope and matching ready source hash. Cancellation reports main-process signal acceptance; terminal state comes from persisted receipts. Actual running receipts refresh every second and stop on failure, completion or unmount. The last stored receipt remains visible beside read errors. Main actor, transferred/verified bytes, file SHA256, fixed authorization and revision remain inspectable. Project/item/observation keys and Effect cleanup discard late scoped replies.

A4C status: **Verified passing**. Final combined real Electron renderer suite passed65/65; focused HF cases8/8. Build including typecheck, startup13/13 with zero renderer errors, IPC generation check and eager chunk check passed (1134468 bytes, six files). Eight light/dark disclosure audits report cut0/hidden0; 650px screenshots retain keyboard focus, reachable actions and document content. HTTP data is synthetic while main services/repositories, sender74, strict IPC and downloaded physical bytes are exercised. Live Hub, gated access and independent scientific/license acceptance are unrun.

```bash
pnpm typecheck
pnpm build
node --test --test-concurrency=1 --test-timeout=180000 tests/renderer/research-huggingface.test.mjs tests/renderer/research-resources.test.mjs tests/renderer/scholarly-relations.test.mjs tests/renderer/paper-reader.test.mjs tests/renderer/artifact-production.test.mjs
node --test --test-concurrency=1 --test-timeout=180000 --test-name-pattern='650px' tests/renderer/research-huggingface.test.mjs
node scripts/smoke-electron.mjs
pnpm check:ipc
pnpm check:renderer-chunks
git diff --check
```

Working directory is the same physical repository path above. Logs: `hf-a4c-*.log`; screenshots/accessibility snapshots/audits: `hf-a4c/`. Initial fixtures called a nonexistent import API and shadowed a metadata argument; corrected before focused acceptance. Two assertions raced the parent's lock effect; Playwright waits now assert the same unlock condition. The first combined run passed64/65: fully expanded CSS height173.039px compared against DOM173.0390625px. The final predicate compares both at the CSS serialization precision, preserving full-height and opacity checks; the corrected combined run passed65/65. No product geometry or assertion requirement was relaxed.
