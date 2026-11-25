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

## PDF source artifacts

`ovis-pdf-artifact.ts` prepares PDF evidence for the future parser without
registering a production route. It renders the selected actual PDF pages at
scale2 through the existing bounded PDF.js6.5.438 path, records the measured
rotation/CropBox/UserUnit frame and binds each PNG hash to the source PDF hash.
One Worker processes the document's pages. Native text/items remain separate
from generated content; neither matching words nor a plausible box implicitly
verifies the generated region.

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
node scripts/research/verify-ovis-pdf-artifact.mjs \
  --installation /Users/Apple_501/.roc/research-models/ovisocr3-mlx-8bit \
  --source-relative ori_pdfs/docstructbench_llm-raw-scihub-o.O-ajhb.10190.pdf_5.pdf \
  --output /absolute/new-evidence-directory
```


## Page-only Paper IR contract

Parse contract5 / derivation11 / Paper IR2.2 accept explicit page-only locations
in blocks, equations, tables, figures, and their evidence. Coordinates and origin
are either both null or a finite positive-area rectangle and its origin. HTML
also emits page-only locations. Contract4 and scientific object version1 are
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
