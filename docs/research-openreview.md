# OpenReview public observations

Roc captures independent project-scoped observations of anonymous OpenReview API v2 Note and Edit pages. No provider writes, login, tokens, literature creation, evidence acceptance or workflow changes.

## Fixed provider contract

Checked 2026-11-06 against the [official API v2 Note fields](https://docs.openreview.net/reference/api-v2/entities/note/fields), [Edit entity](https://docs.openreview.net/reference/api-v2/entities/edit), [OpenAPI definition](https://docs.openreview.net/reference/api-v2/openapi-definition) and [official Python v2 client](https://github.com/openreview/openreview-py/blob/master/openreview/api/client.py). The contract uses API v2 only.

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

Current observations live in `research_openreview_observations`; prior observations are not synthesized. Database initialization and incompatible-store handling follow [database storage](database-storage.md).

## Reader controls

`PaperReader` lazily loads the panel on explicit disclosure, with project/item keys resetting transient state and observation keys resetting local entry pages. It shares the existing 55% height scroller with the other source panels. No route or shell was added.

The reader accepts four explicit query kinds and manual target identifiers. History pages contain 20 observations; saved entry pages contain 20 entries. A full 50-entry provider page offers an explicit next-page capture with a new request ID and the saved cursor. Each page remains a separate observation.

Dirty inputs, active captures and uncertain replies lock collapse, history selection and provider continuation. Users can discard edits, cancel an actual capture, or retry the exact original request after a lost reply. Cancel acknowledgement is separate from the capture outcome. Readonly projects retain history and read retries while new queries remain disabled. Late responses from an unmounted project/item panel cannot change its replacement.

Note details show source role, wrapped content, field visibility, venue/domain, signatures, license and source dates. Edit details retain original delta JSON and state that no complete historical Note was reconstructed. Content is mounted only after disclosure. No control accepts public opinions as reviewed scientific facts.

Live provider interoperability and scientific interpretation require independent acceptance; see [verification boundaries](verification.md).
