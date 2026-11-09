# Reviewed Zenodo publication

## Local preparation contract

The main process prepares an immutable review receipt from an approved export. Local preparation performs no network requests and stores no credentials. The separately authorized connector below handles remote operations.

The user selects 1–20 exact archive or public bundle paths and distinct upload names. Source tuples and case-insensitive upload names must be unique. Names are ASCII identifiers, bounded to 200 characters. Each file and the whole upload are limited to 512 MiB. The main process verifies the complete export, current source versions, scientific review and export approval, then streams the selected bytes through SHA256 and MD5. MD5 is the checksum used by Zenodo; SHA256 remains the local byte identity. Files are opened without following symlinks, read in 1 MiB blocks, and checked for size, modification time and digest changes.

The upload metadata explicitly declares publication type, title, description, publication date, open access, license ID, creators and version. The supported publication types are article, preprint and report. Public text uses the export layer's existing private-value rejection. No missing author, license or access choice is filled in.

`research.zenodo.prepare` requires the main IPC human sender for the exact project. Privacy, file licenses and authors each require an explicit true declaration. Wire requests cannot supply an actor or grant themselves authority. The receipt preserves the selected environment, exact request, main sender, upload bytes, export/source hashes and creation time.

`research_zenodo_preparations` stores receipts with project ownership and one immutable preparation per project/request ID. An identical retry returns the original receipt; a different request with that ID fails. Concurrent retries return one receipt. Historical reads remain available after a project is archived, while new preparation and current-source validation fail.

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

## Existing export drawer consumer

The export inspector provides lazy reviewed Zenodo publishing inside the existing approved export receipt. It does not add a route or shell. The editor requires explicit files, upload names, environment, metadata, authors and three public-sharing declarations. Preview reads actual file hashes before preparation; any edit invalidates the preview. Lost preparation and publication replies retain the exact request. A preparation-scoped readonly operation lookup prevents reopening history from creating a second operation.

Full local and remote metadata, files, ownership, marker, hashes and DOI receipts remain visible before the independent publish approval. Draft and pending states lock inspector closing, export switching and sibling actions. Credentials remain environment scoped and transient masked input; plaintext clears at dispatch and never enters a persisted retry. Archived projects retain history and prohibit write controls. Both histories page independently in groups of twenty. Cancel aborts the current transport and retains uncertain remote state; it does not withdraw a published record.

## Validation boundary

Local connector tests use controlled remote responses and an isolated encryption port. They do not establish live native safeStorage plus live Zenodo acceptance. See [verification](verification.md) for the required environment and target authorization.
