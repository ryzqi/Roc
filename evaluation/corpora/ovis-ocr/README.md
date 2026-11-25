# OvisOCR3 8-bit evaluation inputs

This corpus contains independently produced upstream annotations for a fixed scientific-page component cohort and associated original PDF slice candidates. Acquired bytes are reproducible; model quality, PDF geometry, native text layers, complete-document identity, training holdout independence and local human review are **not yet qualified**.

Run from the repository root:

```sh
node scripts/prepare-ovis-evaluation-corpus.mjs
node scripts/prepare-ovis-evaluation-corpus.mjs --verify
```

Acquisition uses at most four concurrent requests, a 90-second request deadline and three attempts per transient failure. `--workers 1` lowers concurrency. `--verify` is read-only and performs no network requests. Existing mismatching files are rejected rather than overwritten. Newly written files are validated before atomic promotion, partial files are removed, and interrupted complete files can be independently verified on the next run. A concurrent acquisition is rejected; an abruptly killed process can leave an ownership marker requiring inspection before removal.

## Frozen selection

- Dataset: [opendatalab/OmniDocBench](https://huggingface.co/datasets/opendatalab/OmniDocBench), revision `aa1ee96d106dbe53d0ae59474d75c6e6d9b53fec`.
- Select every page with `data_source` equal to `academic_literature` or `research_report`, sorted lexically by the full upstream image path. This produces **347** pages: 215 academic-literature and 132 research-report pages, including 591 nonignored isolated formulas with LaTeX on 56 pages and 323 nonignored tables with HTML on 227 pages.
- Original PDF candidates: `ori_pdfs/` at revision `f5f559bddf50e36f7f9899d842d0006f13ce8afc`. Remove only the image's final `.jpg`/`.png` extension and append `.pdf`. Exactly **210** files match, and each historical image's Git OID and size equals the current image's identity. These are a subset of the 347 pages, not an additional 210 pages.
- The original slices include 129 academic-literature and 81 research-report pages, with 48 nonignored formulas on 10 pages and 194 nonignored tables on 137 pages. No selected page is declared `fuzzy_scan`.
- The full upstream labels contain 1,651 pages. The local derived gold retains selected objects without field edits; it changes only page order and JSON serialization.

[sources.lock.json](sources.lock.json) records immutable URLs, revisions, sizes, upstream OIDs/LFS SHA-256, actual raw SHA-256, metadata response identities and derived-gold identity. [selection.json](selection.json) records page and annotation IDs, declared attributes, original-slice associations and explicit qualification gaps.

All raw inputs, metadata envelopes and derived gold stay under the ignored `evaluation/local/sources/ovis-ocr/` directory. Original binary images/PDFs and gold are not redistributed with the application. The preparer can copy already acquired P0 inputs only after validating them; it never modifies P0's source lock or inputs.

The acquired snapshot has **560 source files / 274,701,265 bytes**: images 190,412,656 bytes, original PDF slices 42,054,677 bytes, full annotations 42,208,096 bytes and two upstream READMEs 25,836 bytes. Derived selected gold is 4,434,470 bytes with SHA-256 `e7007c63200caed9bd50c3c187feecf42e3175d8f4199d8adfc96b0289ebf3c0`. Metadata-response envelopes are retained separately. Acquisition and offline verification passed on 2026-11-25; this establishes byte identity only.

## Integrity and provenance

For LFS payloads, the preparer checks size and SHA-256 against the upstream LFS record. For ordinary Git objects it checks size and `SHA1("blob " + byteLength + NUL + bytes)` against the upstream Git blob OID, then records the independent raw SHA-256. A Git OID for an LFS pointer is never mistaken for the payload's SHA-256. PNG/JPEG/PDF signatures are checked; PDF parsing and rendering are deferred. Image media type is detected from the payload: an upstream `.png` name with verified JPEG bytes is retained unchanged and explicitly marked `filenameExtensionMatchesMediaType: false` in the lock.

The local provenance READMEs preserve both dataset revisions' licensing and source descriptions. The upstream dataset is **research-only and noncommercial**; evaluator code licensing does not grant broader data rights. Annotation method: [OmniDocBench paper](https://arxiv.org/abs/2412.07626), published manual and assisted annotations checked by experts.

Local independent reviewer count is **0**. Upstream annotator headcount and verified unique original-document count are unknown. No reviewer identities, review attestations, cross-page gold, source-to-page geometry or training-set independence are inferred from file names or hashes.

These acquired inputs do not complete P3/P6. Next steps are actual PDF page/geometry/text-layer verification, original multi-page and scanned-scientific coverage, independent review, an isolated official CDM/TEDS evaluator, and paired original/8-bit model runs with frozen quality and resource gates. The broader scientific-RAG 45-PDF/200-question contract remains separate.
