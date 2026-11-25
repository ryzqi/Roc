# Ovis page source boundary

`src/main/plugins/research/ovis-document-adapter.ts` is an isolated adapter for the
future complete parser. It is not registered in the production parser. P3 full
347-page quality qualification and P4 downstream integration remain required.

The caller supplies a verified installation identity, source hash, hash of the
actual inference image and measured page frame. A version1 completion envelope
must match them exactly, bind the unmodified UTF8 output by SHA256 and provide
the generated token IDs. Only a completed sequence ending in official EOS is
accepted. Truncation, count mismatch, an earlier EOS, changed source/image/model,
invalid UTF8, malformed JSON, duplicate keys (including escaped spellings),
unknown fields/categories or invalid coordinates reject the entire page. Nothing
is repaired or silently coerced. Raw output is bounded at4MiB,4096regions and
16384generated tokens. These are resource ceilings, not quality claims.

The 8-bit identity includes official revision, group size64, BF16 vision weights,
Metal device, installation receipt hash, inference source hash and task prompt
hash. The adapter verifies equality to the caller's identity; the future model
store/Worker must establish that identity through actual file verification. An
envelope alone does not prove installed bytes or model quality.

Each region retains exact generated content, category, raw array index and
normalized box. Boxes use the official `[0,1000)` basis and the actual image
dimensions. For PDF input, the captured viewport projects candidates back to PDF
user space, including CropBox, rotation and UserUnit. Candidates are not clipped,
stretched or rewritten. Spatial column/band ordering supplies the output order;
the raw index remains available for diagnosis.

Every generated region has `verification: unverified`. `candidateRegion` holds
its proposed geometry for inspection, while `citationLocations` contains only
the page number and null geometry. The adapter does not promote generated text,
LaTeX, HTML or a plausible box into verified source evidence. Model image paths
are retained only as raw content, never followed. Production integration must
create image crops from the captured raster, propagate verification into Paper
IR and retrieval, and permit precise citations only after independent source
validation. Multi-page table stitching is not performed; cell/page evidence may
not be inferred from a generated table string.

Validation from the repository root:

```sh
node --test tests/unit/research-ovis-document-adapter.test.mjs tests/unit/research-pdf-reading-order.test.mjs
pnpm typecheck
node scripts/research/verify-ovis-source-adapter.mjs \
  --inference .artifacts/research-toolchain-p3/smoke-8bit \
  --output /absolute/new-report.json
```

Ten tests cover malformed completion/source bindings, raw preservation, generated
path handling, all four right-angle PDF rotations, crop/UserUnit projection and
double-column ordering. Replaying the three saved MLX8bit PNG sources preserved
all60regions and their exact raw content, with page-only citations for every
region. This is a replay of existing inference, not a new runtime inference or
full PDF/application qualification. Evidence is retained under
`.artifacts/research-toolchain-p3/ovis-source-adapter-*`.

## Isolated Worker wrapper

`ovis-worker.ts` consumes a model-store installation lease and verified page
bindings. It hashes the receipt and inference source before launch; the isolated
Python bootstrap rechecks them and verifies the installed runtime/model before
importing MLX. It then calls the unchanged, pinned inference implementation once
for the document's pages. Installed Python packages are reachable only through
the explicit private runtime path; `-I -S -B` disables project/user startup and
bytecode writes. Request values travel through JSON stdin, never interpolated
code or shell commands.

The existing process supervisor provides global parse/GPU admission, network
denial, cancellation, timeout, process-group cleanup and6GiB monitored RSS. A
private Darwin cache enables Metal compilation with narrowly scoped extensions.
The4GiB MLX memory limit is a guideline; Apple compiler-service memory is outside
Worker RSS monitoring. Ordinary Python experiment permissions do not change.

The wrapper requires the entire requested page sequence and verifies report
identity, image hashes, raw output and EOS before returning any page. It rejects
invalid/partial documents and changed image bytes. Owned temporary output/cache
directories are removed after confirmed completion or cancellation. If process
exit cannot be proved, directories remain for recovery rather than being removed
under a possibly live process. The caller must retain the returned raw output,
token evidence and source bindings in its atomic parse artifact before publishing.
There is no production parser registration or package/download integration yet.

```sh
node --test tests/unit/research-ovis-worker.test.mjs tests/unit/research-ovis-document-adapter.test.mjs tests/unit/research-pdf-reading-order.test.mjs
node scripts/research/verify-ovis-worker.mjs \
  --installation /Users/Apple_501/.roc/research-models/ovisocr3-mlx-8bit \
  --reference-inference .artifacts/research-toolchain-p3/smoke-8bit \
  --output /absolute/new-evidence-directory
pnpm build
```

Fourteen boundary/ordering tests pass, including corrupted/partial reports,
source mutation, output symlinks and unproven cleanup. The real supervised8bit
wrapper replayed the chart page with all11regions and byte-identical raw output;
both owned directories were removed. Mixed-load generation30.918s, supervisor
hold41.283s, sampled peakRSS1,773,273,088B. This does not establish isolated
performance, cross-document model reuse or full application qualification.
Evidence: `.artifacts/research-toolchain-p3/worker-wrapper/` and
`ovis-worker-boundary-tests.log`, `ovis-worker-build.log` in the same parent.

## Installation inspection and leases

`ovis-model-store.ts` provides a read-only integrity boundary and counted leases.
It requires a receipt hash supplied by a trusted preparation transaction; reading
an arbitrary local receipt and trusting its own hash is not supported. It checks
every recorded entry, mode, regular-file hash/size, link target, interpreter and
shared library, inference source, model revision and8-bit conversion metadata.
Missing/extra entries, unexpected external links and changed files are refused.
No package import, model load, network download or user-profile write occurs.
Cancellation and failed inspection unwind the reservation; release is idempotent.
Future download/removal integration must respect active reservations.

The existing installation passed a fresh inspection:16,561entries and
3,538,535,671regular-file bytes excluding the receipt and external interpreter.
`qualityQualified` remains false; full-cohort quality and product qualification
are separate gates. Four fixture tests cover integrity failures, invalid roots,
inventory paths and lease cleanup. `pnpm typecheck` also passes. Evidence:
`.artifacts/research-toolchain-p3/ovis-model-store-inspection.json`.

```sh
node --test tests/unit/research-ovis-model-store.test.mjs
```

## PDF and image source artifacts

`ovis-source-artifact.ts` prepares source evidence for the future parser without
registering a production route. It renders the selected actual PDF pages at
scale2 through the existing bounded PDF.js6.5.438 path, records the measured
rotation/CropBox/UserUnit frame and binds each PNG hash to the source PDF hash.
One Worker processes the document's pages. Native text/items remain separate
from generated content; neither matching words nor a plausible box implicitly
verifies the generated region. Images use the shared `research-raster.ts` codec:
PNG, JPEG, BMP, WebP and multi-page TIFF preserve their measured pixels and actual
page numbers. The codec consumes the source bytes already pinned by the capture.
Both the basic parser and Ovis use it; Ovis does not initialize Paddle to decode
an image. Image evidence has an image coordinate frame and no native text layer.

The artifact retains exact raw output, token sequence, input image, model
identity, candidate geometry and source page. Figure/table crops are copied from
the captured page pixels, never from model-generated paths. The integer crop
rectangle uses outward rounding and is recorded separately from the unchanged
candidate box. Crops remain unverified and citations remain page-only. This does
not reconstruct cross-page table cells or establish PDF quality against gold.

An exclusively created directory and final atomic `manifest.json` marker keep
existing output intact. Source changes, incomplete output and cancellation
prevent publication and remove owned output. Unproven Worker termination retains
the input rasters without a completion marker for recovery. A512MiB total budget
includes rasters, crops and evidence; each page raster remains bounded by the
existing renderer. Cancellation during a raster waits for that bounded render
to settle before cleanup.

The real frozen PDF slice completed with11regions and2source crops. Generation
took30.910s, supervised hold38.862s, sampled peakRSS1,581,547,520B under mixed host
load. Worker temporary job/cache directories were removed and the installation
lease released. Evidence is retained in
`.artifacts/research-toolchain-p3/pdf-artifact/`; this is one PDF plumbing check,
not full application, quality or isolated performance qualification.

From the repository root,27boundary/rendering tests and the full `pnpm build`
(including typecheck and renderer chunk checks) passed:

```sh
node --test tests/unit/research-ovis-pdf-artifact.test.mjs \
  tests/unit/research-ovis-worker.test.mjs \
  tests/unit/research-ovis-document-adapter.test.mjs \
  tests/unit/research-pdf-raster-lifetime.test.mjs \
  tests/unit/research-pdf-native-text.test.mjs
node scripts/research/verify-ovis-source-artifact.mjs \
  --installation /Users/Apple_501/.roc/research-models/ovisocr3-mlx-8bit \
  --source-relative ori_pdfs/docstructbench_llm-raw-scihub-o.O-ajhb.10190.pdf_5.pdf \
  --output /absolute/new-evidence-directory
```


## Page-only Paper IR contract

Parse contract6 / derivation12 / Paper IR2.2 accept explicit page-only locations
in blocks, equations, tables, figures, and their evidence. Coordinates and origin
are either both null or a finite positive-area rectangle and its origin. HTML
also emits page-only locations. Earlier parse contracts and scientific object version1 are
rejected; there is no zero-box conversion or legacy reader.

Object and relation locations must match their source object/block. A table with
unknown source geometry cannot assert cell rectangles. Caption geometry, adjacent
equation numbering, native/OCR overlap and cross-page paragraph continuation do
not infer spatial relationships when coordinates are absent. Explicit LaTeX tags
and original text remain available. The PDF reader opens the actual page and
shows its page-only notice without drawing a region; evidence and scientific Wiki
keep the captured source identity and reject changed locations.

This contract prepares the downstream boundary. It does not register Ovis as a
production parser or qualify the pending347-page evaluation.

## Captured output to Paper IR

`ovis-paper-content.ts` reads a completed PDF or image capture using the caller's pinned
manifest hash, source hash and model identity. Every raster, raw-evidence file and
crop must have the exact generated relative path, size and hash. Missing markers,
changed files, symlinks, duplicate/out-of-range pages, mismatched crop identities
and incomplete token sequences reject assembly. Saved derived blocks are ignored;
the adapter reconstructs them from the original raw output. The reader does not
start a Worker, change the capture or register a production parser.

Prose and LaTeX retain their generated text. HTML tables retain their raw HTML and
produce mechanical cell text; invalid structures stay explicit invalid objects.
Figure content cannot supply a filesystem path or an invented textual description;
only the source raster crops become image assets. Candidate geometry may suggest
caption/reference relations, all of which remain candidates with page-only
locations. No object number is inferred from a candidate caption. Original PDF
text quadrilaterals are projected through the captured viewport for native-area
coverage. OCR-area coverage and reading-order quality remain unknown, and the
overall quality remains `review` with an explicit unverified-content warning.
Images cannot claim native text observations or PDF viewport transforms. A capture
cannot mix PDF and image frames. Image reading-order quality remains unknown.

The content includes its capture hash and complete 8-bit model identity in the
parse payload. The existing Paper IR builder and repository publish and reread
its scientific objects without a separate IR format or legacy conversion. Raw
capture evidence must remain alongside this derived content for inspection.

Validation from the repository root:

```sh
node --test tests/unit/research-ovis-paper-content.test.mjs \
  tests/unit/research-ovis-pdf-artifact.test.mjs \
  tests/unit/research-ovis-document-adapter.test.mjs \
  tests/unit/research-paper-ir-v2.test.mjs
node scripts/research/verify-ovis-paper-content.mjs \
  --capture .artifacts/research-toolchain-p3/pdf-artifact \
  --output /absolute/new-evidence-directory
pnpm build
```

The 26 boundary/IR regressions pass, including references to a formula on another
actual page while keeping table cells separate by page. Replay of the actual 8-bit
chart capture published 11 blocks, 2 figures and 5 candidate caption relations,
and reread 14 IR objects with page-only locations. A second actual scientific PDF
capture published 30 blocks, 7 equations and 1 table with 27 cells, and reread 70 IR
objects. Both source captures remained unchanged. This verifies assembly and
persistence, not full-cohort quality or production RAG adoption.

The shared image path passed 6 image boundary tests and 26 existing PDF/content/
corpus regressions. PNG, JPEG, BMP and WebP pixels round-trip through the captured
PNG; TIFF selection retains page 2 and rejects malformed or oversized pages
before inference. A real frozen scientific JPEG completed 8-bit Worker inference
and published/reread 14 IR objects (11 blocks, 2 figures, 5 candidate captions).
Its source stayed unchanged, and Worker job/cache directories were removed.
Evidence: `.artifacts/research-toolchain-p3/image-artifact/` and
`.artifacts/research-toolchain-p3/paper-content-image/`. Full `pnpm build` passed.


## Application result and storage boundary

Contract6 discriminates `paddleocr.js` and `ovisocr3-mlx` explicitly. Ovis results
require complete/ocr/Metal, the fixed 8-bit model identity, CPython/MLX/MLX-VLM
versions, a source capture manifest hash, structure and quality. Installation
receipt identity must equal `modelManifest`. Mixed engines, missing evidence and
older contracts are rejected without conversion. `research-ovis.ts` owns the
shared model identity; there is no former adapter export alias.

`ovis-parsed-document.ts` reconstructs a result from the caller-pinned capture,
then exclusively creates its three derived artifacts. Existing artifacts remain
untouched. Cancellation/failure removes only the artifacts directory this call
created. The original capture remains available. Parser fingerprints include the
result contract, Ovis parser/runtime versions and the content derivation identity.

Before collection, the original raw output, EOS, model, images, crops and page
frames are rechecked and scientific objects rebuilt. The entire result, middle
JSON, Markdown and structured JSON must match this reconstruction. Equal forged
copies do not count as evidence. Collection also binds its own asset reads to the
verified hashes and sizes, and its coordinate artifact to the verified structured
hash. Stored results preserve model/capture identity while replacing image paths
with asset IDs; the existing SQLite/Paper IR publication consumes this result.
No Ovis production parser route is registered by this change.

Real PDF and JPEG captures passed collection, SQLite publication/readback,
coordinate binding and Paper IR publication/readback. The PDF contains30blocks,
7equations and1table/27cells; the image contains11blocks and2figures. Original
captures were unchanged. Evidence is retained in
`.artifacts/research-toolchain-p3/document-storage-pdf/` and
`.artifacts/research-toolchain-p3/document-storage-image/`. These are storage
checks using prior actual 8-bit inference, not a new inference or quality claim.

Reproduce from the repository root:

```sh
node --test tests/unit/research-ovis-parsed-document.test.mjs
node scripts/research/verify-ovis-document-storage.mjs \
  --capture .artifacts/research-toolchain-p3/pdf-artifact-formula \
  --output /absolute/new-evidence-directory
```

For this contract change, `pnpm test:unit` passed2869 with1skip and0failures;
`node --test --test-concurrency=1 tests/renderer/artifact-inspector.test.mjs
tests/renderer/paper-reader.test.mjs` passed93. The focused Ovis result suite
passed6, including cancellation after a derived file was written and preserving
the previous successful parse after a later capture failed. Final `pnpm build`,
`pnpm check:ipc` and `git diff --check` passed from the repository root.

## Source-to-result transaction and exit ownership

`ovis-document-parser.ts` composes model acquisition, source capture, result
reconstruction and a final source hash check under one deadline. It releases the
verified model lease only after the transaction settles. Cancellation and ordinary
failures remove this transaction's output; directory identity checks prevent
cleanup from deleting an existing or replaced directory. The document service also
passes cancellation through result collection and preserves the previous successful
publication after a later parse fails.

`process-exit-state.ts` follows causes and aggregate errors, including cycles.
Unconfirmed Worker termination retains both the diagnostic inputs and model lease;
model deletion or reinstallation remains blocked. The installation manager also
keeps a durable operation marker across host restarts; see the
[lifecycle recovery contract](research-ovis-lifecycle.md). This parser remains
unregistered while the full P3 quality evaluation is pending.

From the repository root, both focused batches passed22 tests each:

```sh
node --test tests/unit/research-ovis-document-parser.test.mjs \
  tests/unit/research-ovis-parsed-document.test.mjs \
  tests/unit/research-ovis-worker.test.mjs \
  tests/unit/research-ovis-pdf-artifact.test.mjs
node --test tests/unit/research-document-process-lifecycle.test.mjs \
  tests/unit/literature-document-pipeline.test.mjs \
  tests/unit/research-document-coordinates.test.mjs
node scripts/research/verify-ovis-document-parser.mjs \
  --installation /absolute/verified-8bit-installation \
  --source-relative ori_pdfs/docstructbench_llm-raw-scihub-o.O-ajhb.10190.pdf_5.pdf \
  --output /absolute/new-evidence-directory
pnpm build
```

The real transaction produced11blocks and2crops, passed collection and Paper IR
publication/readback, released its model lease and removed its private Worker
directories. Evidence is in `.artifacts/research-toolchain-p3/document-parser/`.
Observed generation was23.820s, supervised admission hold32.845s and sampled peak
RSS1,580,662,784B under mixed host load. These observations do not qualify isolated
performance or the full quality gate. Build and both focused test batches passed.

## Saved-output structural replay

`verify-ovis-structural-replay.mjs` accepts a completed 8-bit inference report,
checks its pinned model identity and each original input/raw/token binding, then
uses that saved output to exercise image capture, collection and Paper IR
publication/readback. The capture envelopes in this harness are explicitly
synthetic because image normalization may change raster bytes. This checks
structural preservation, not inference equivalence, source-binding qualification
or gold quality. It never starts a Worker or adopts a model.

```sh
node scripts/research/verify-ovis-structural-replay.mjs \
  --inference .artifacts/research-toolchain-p3/smoke-8bit \
  --output /absolute/new-evidence-directory
```

The completed three-page smoke report passed: 60blocks, 7equations, 4tables,
441cells, 3figures, 11candidate caption relations and521IR objects. Original
content survived the applicable raw text/LaTeX/HTML fields; every citation remained
page-only. Per-page hashes and counts are retained in
`.artifacts/research-toolchain-p3/structural-replay-smoke/report.json`.
All synthetic captures and temporary publications were removed. The same harness
is ready for the completed347-page8-bit report when inference finishes.
