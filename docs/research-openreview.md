# OpenReview public observations

A5A scope: independent project-scoped observations of anonymous OpenReview API v2 Note and Edit pages. No provider writes, login, tokens, literature creation, evidence acceptance or workflow changes.

Status: **Verified passing** for the local A5A contract.

## Fixed provider contract

Checked 2026-11-06 against the [official API v2 Note fields](https://docs.openreview.net/reference/api-v2/entities/note/fields), [Edit entity](https://docs.openreview.net/reference/api-v2/entities/edit), [OpenAPI definition](https://docs.openreview.net/reference/api-v2/openapi-definition) and [official Python v2 client](https://github.com/openreview/openreview-py/blob/master/openreview/api/client.py). Exact OpenAPI was saved at `/tmp/roc-openreview-api.yml`. Context7 contains mixed v1/v2 material; only explicitly v2 results were used.

The only endpoints are `https://api2.openreview.net/notes` and `/notes/edits`. Four explicit queries select a Note ID, forum ID, invitation or edits for a Note ID. Requests use `sort=id:asc`, `count=true`, an explicit limit and optional `after` cursor. The provider ignores Edit offsets; Roc sends no provider offset. Local history and saved-entry reads use separate offsets.

Current Notes are mutable provider state. Every local capture stores a new immutable observation with Note identity, dates, source hash and whole observation hash. It does not claim a provider immutable historical version. `id == forum` identifies the submission; `replyto` and invitations retain the source role. Replies are not automatically classified as reviews. Missing venue, license or dates remain unknown.

Note content retains API v2 value wrappers and field readers. Top readers must explicitly include `everyone`, nonreaders must not exclude `everyone`, and content field readers must be public or inherit the public Note. A malformed or private entry rejects the entire page. Edit readers must be public; its own content, invitation, replacement and exact Note delta are saved. A public Edit may contain ACL operations or deletions. These are change instructions, not proof of the resulting Note visibility, a complete historical Note, or a scientifically accepted claim.

Provider response selection ignores unrelated fields while the raw response hash records the response identity. Stored and IPC contracts are strict. Each normalized entry has a canonical `sourceHash`; the observation includes all request and transport facts in `contentHash`. Reads verify physical row ID, project, request, query, endpoint, governor host and both hashes.

## Bounds, lifecycle and failure

- One capture reads one page, at most 50 entries; direct Note queries request one.
- IDs, invitation strings, field names, groups and JSON values have explicit bounds. Edit Note deltas are bounded to 1 MiB.
- Shared metadata transport bounds response bytes to 4 MiB, timeout to 15 seconds, validated cache to 8 MiB/32 entries/5 minutes and 429 attempts to three. OpenReview uses the shared conservative host policy of 1 request/second and 300/hour, not a claim about the provider's current quota.
- Cache keys include project and URL. Cached values are revalidated. Cache hits retain original fetch time while creating a separate observation.
- Returned IDs must be strictly ascending and beyond the requested cursor. A full page exposes the last ID as a possible next cursor, even if count equals page length. Counts do not prove that a later page is empty.
- Successful empty pages return zero entries. Failed queries persist `page=null`, unknown entry count, error code and actual receipts. 403/404 do not certify global Note absence.
- Exact request replay returns its original saved receipt. An active exact replay shares one query; changed parameters conflict. Cancel and shutdown reject late writes even if transport ignores abort.
- Archive preserves history and exact replay but refuses new captures, including in-flight commit. Save verifies scope before and after insertion in a transaction and reads back the actual stored row. Trigger-induced archive or snapshot corruption rolls back the entire insertion.
- There is no v1 adapter, token field, actor field, legacy IPC alias or automatic literature/evidence approval.

Migration 57 adds `research_openreview_observations` without synthesizing prior observations. Production plugin declaration, capability registration and shutdown all include the service.

## Verification

All commands run in `/Volumes/Macintosh HD/Users/Apple_501/Desktop/Roc/Roc`. HTTP payloads are synthetic; transport, governor, capability schemas, SQLite and Electron runtime are actual.

```bash
pnpm generate:ipc
pnpm typecheck
node --test --test-concurrency=1 tests/unit/research-openreview.test.mjs tests/unit/research-huggingface.test.mjs tests/unit/research-huggingface-downloads.test.mjs tests/unit/research-resources.test.mjs tests/unit/literature-import.test.mjs tests/unit/database-migrations.test.mjs
pnpm build
node scripts/run-research-p0.mjs
pnpm test:unit
pnpm harness:eval
node --test --test-concurrency=1 --test-timeout=180000 tests/renderer/research-huggingface.test.mjs tests/renderer/research-resources.test.mjs tests/renderer/scholarly-relations.test.mjs tests/renderer/paper-reader.test.mjs tests/renderer/artifact-production.test.mjs
node scripts/smoke-electron.mjs
pnpm check:ipc
pnpm check:renderer-chunks
git diff --check
```

Initial generation passed; initial typecheck failed the draft's incorrect `readOpenReviewMetadata` import. Corrected to `readOpenReviewPage(request.query, payload)`; subsequent typecheck passed. Initial focused run passed 16/17 and failed a fixture's nonexistent `research_scholarly_observations` table. Corrected to actual `research_scholarly_snapshots`, retaining zero effects on literature, resources, relations, Evidence and workflow. Final related suite passed 164/164, including all 17 OpenReview cases.

Logs: `.artifacts/research-optimization/openreview-a5a-*.log`. Native SQLite backup, entry pages and runtime receipts: `.artifacts/research-optimization/openreview-a5a-native/`.

Final acceptance: related unit 164/164 (OpenReview 17/17), full unit 1395/1395, native production 18/18, Harness 94/94, related renderer 65/65, startup 13/13 with zero renderer errors, build/typecheck, current IPC generation, eager renderer 1,134,468 bytes in six files and diff whitespace checks all passed. Each runner returned exit code zero.

Live provider connectivity, private access, independent scientific interpretation and public review acceptance remain **Blocked, not run**. This local implementation does not establish those external outcomes.
