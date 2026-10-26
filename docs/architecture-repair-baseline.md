# Architecture Repair Baseline

This is the reproducible starting point for [`architecture-repair-plan.md`](architecture-repair-plan.md). It records the source revision, locked toolchain, current contracts, dependency use points, and the regression corpus before implementation starts.

## Source and build baseline

| Input | Baseline |
| --- | --- |
| Source revision | `ad13d611a02fc8568cd7ff58e244de08fe6d00c8` |
| `package.json` version | `0.1.0` |
| Host Node.js | `v26.12.1` |
| Package manager | `pnpm 12.5.1` (`packageManager` pin) |
| Electron | `45.0.0` |
| TypeScript / Vite | `7.0.2` / `8.3.5` |
| `pnpm-lock.yaml` SHA-256 | `3266c637d57b74732eaed3d7d9ec61e8cf913aa9945d09727cb384b9beaf6424` |

Run from the repository root with the committed lockfile and dependencies installed:

| Command | Baseline result |
| --- | --- |
| `pnpm build` | Pass; includes `pnpm typecheck` and production Electron/Vite build. Renderer graph: 2,947 modules. |
| `pnpm check:renderer-chunks` | Pass; 1,076,870 eager JavaScript bytes across 6 files. |
| `pnpm test:unit` | Pass; 333 passed, 0 failed, 0 skipped. |

The exact command outputs from this run are retained in `.planning/2026-10-27-roc-architecture-repair-plan/artifacts/` for the active repair session. Re-run the commands above against each committed repair when its affected contract requires them. The host Node version is not the Electron embedded Node version.

## Contract and dependency use points

The left side of each boundary is the contract to preserve. The right side records the implementation/dependency actually in use at this baseline; a candidate library is not considered installed merely because the repair plan names it.

| Area | Contract and primary consumers | Current implementation and pinned dependency use |
| --- | --- | --- |
| Bibliography | `researchBibliographyEntrySchema`; library import, citation validation, and export | `src/main/plugins/research/bibliography.ts` owns parsing/name/LaTeX logic and serialization. No BibTeX parser library is installed. |
| ZIP | `ResearchExportFile`, export manifest/hash, template limits, cancellation and safe path handling | `export-archive.ts` hand-writes ZIP with Node `zlib`; `template-archive.ts` parses ZIP. Template import caps: 5,000 members, 64 MiB/file, 256 MiB total. Export caps: 10,000 files, 64 MiB/file, 512 MiB total, 600 MiB archive. No `yazl`/`yauzl` is installed. |
| Git | `src/shared/types/git.ts` results and workspace Git capabilities | `git-service.ts` and `git-service-helpers.ts` call Node child processes; `simple-git` is not installed. |
| Markdown | Static and streaming views preserve GFM, safe links/images, focus, and `.roc-prose` | `react-markdown 10.1.0`, `remark-gfm 4.0.1`, `streamdown 2.7.1`; static and streaming implementations are separate. |
| Syntax highlighting | Render only React text/spans; unknown languages and hostile markup remain text | `highlight.js 11.12.0` plus custom HTML tokenization in `syntax-highlight.ts`; `lowlight` is not installed. |
| Checkpoint storage | LangGraph checkpoint tuple, pending-write ordering, namespace isolation, backup/restore, retention and recovery | `sqlite-checkpointer.ts` over `better-sqlite3 13.0.3`; `@langchain/langgraph 1.5.2`, checkpoint package pinned by workspace override to `1.2.1`. No official SQLite saver is in use. |
| Context tokens | Budget counts carry the `estimated` signal and account for model/provider identity | `js-tiktoken 1.0.21`; Roc cache/selection lives in `context-token-budget.ts`. |
| Experiment CSV | `writeCsv(path, rows)` output path, column order, values and byte cap | Input uses `csv-parse 7.0.3`; runtime also allowlists `d3-dsv 3.0.1`; output is currently custom buffered serialization. No `csv-stringify` is installed. |
| File-name search | `fileNameSearchRequestSchema` / `fileNameSearchResultSchema`, ignore rules, symlink exclusion, 20,000-file cap, top 20 and truncation | `file-service.ts` scans paths; `workspace-change-watcher-service.ts` uses Node `fs.watch`. Content search uses bundled ripgrep and is a separate contract. |
| Logging | Main and plugin JSONL schemas, separate paths, redaction, rotation/query behavior | `log-service.ts` and `infrastructure-logger.ts` use Roc-owned writers; Pino is not installed. |
| Provider retry | Four total attempts, 1/2/4 second delays, error classes, abort and per-attempt telemetry | `provider-request-retry.ts` owns retry behavior. `p-retry 7.1.1` appears transitively in the lockfile but is not a direct dependency or current implementation. |
| TIFF | `researchParsedDocumentSchema`, page order, pixel ceiling, OCR/output asset limits | `UTIF 3.1.0`; current raster guard is 25,000,000 pixels. `decodeImage()` currently precedes that guard. |
| PDF/OCR | Parsed-document schema, page evidence/assets, source hash, cancellation and bounded image work | `pdfjs-dist 6.4.299`, `@napi-rs/canvas 1.0.13`, `paddleocr 1.2.0`, `onnxruntime-node 1.22.0-rev`; parsed results are checked against `researchParsedDocumentSchema`. |
| OCR lifecycle | One OCR service reused per document; every created ONNX session disposed on every exit path | `document-parser.ts` plus Paddle/ONNX adapters; native runtime is `onnxruntime-node 1.22.0-rev`. |
| Persisted history | Event id/sequence reconciliation, 400-event window, generation guard, prepend/trim scroll anchor | `use-persisted-thread-history.ts` is a Roc React hook; no query library is used for this contract. |
| Context compaction | Tool result persistence/recovery, paired tool messages, pinned user constraints, audit events and hard budget | `context-compaction-pipeline.ts` uses LangGraph context editing and the Roc `TokenCounter` seam; keep the domain pipeline. |
| Workspace watcher | Workspace changes invalidate indexes; watcher errors and lost events must reconcile | `workspace-change-watcher-service.ts` uses native Node `fs.watch`; Chokidar is not installed. |

Other named core components retained by the plan are Electron, React, LangGraph/DeepAgents, `better-sqlite3`, sqlite-vec, Zod, PDF.js, `@napi-rs/canvas`, Vega/Vega-Lite, CodeMirror 6, xterm/node-pty, react-virtuoso, Tectonic, Typst, safeStorage, and bundled ripgrep.

## Regression corpus

`tests/fixtures/architecture-repair/corpus.json` is the deterministic input manifest for the repair sequence. `bibliography-semantics.bib` provides actual UTF-8 BibTeX/BibLaTeX source. `materialize.mjs` creates the archive, TIFF, PDF, 420-event JSONL, and file-tree inputs from the manifest. Run `node tests/fixtures/architecture-repair/materialize.mjs "$(mktemp -d /tmp/roc-architecture-corpus.XXXXXX)"` from the repository root to produce all inputs, including 1k/10k/50k file trees, outside the checkout. The output directory must already exist and be empty. Custom `--file-counts=` values are limited to 50,000 files per tree, and the materializer rejects output paths that resolve into the repository. The focused corpus test uses a temporary directory and a 3-file tree while checking archive directory entries/CRC, TIFF pages and malformed dimensions, persisted event schemas, generated paths, CLI execution, and output-boundary checks.

Existing corpus seeds include:

- `tests/unit/literature-import.test.mjs`: literature provenance, cancellation, restart and deduplication; does not exercise the BibTeX parser.
- `tests/unit/checkpoint-write-order.test.mjs`: pending-write order and old backup shape.
- `tests/unit/file-tree-window.test.mjs`: 10k-row virtualization and keyboard anchors; does not exercise filesystem indexing.
- `tests/smoke/lib/assets/p5-paper.pdf`: fixed PDF fixture (`ee02484891e45e98e89d5682f6dc90562302e1fe5ee5a15f9cad9f0b4d18ddd5`).

Before a replacement, add or extend a focused regression check using this manifest. Keep generated files in temporary directories and preserve the exact input definition and command in the test source. No new runtime dependency is introduced by this baseline.
