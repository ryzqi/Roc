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
