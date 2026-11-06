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
