# Phase 6 tokenizer comparison

**Decision: no-go.** The original corpus missed U+FEFF whitespace cases. Independent review found exact-count differences between `js-tiktoken` and the candidate that can change context-budget decisions. Roc retains its current tokenizer and does not depend on the candidate. Reproduce the counterexample after the isolated installation below:

```sh
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/benchmarks/phase-6-tokenizer/incompatibility.mjs
```

The historical performance results are exploratory and are not fully reproducible evidence: the comparison spliced a candidate loader into the baseline source, not a production build; its long tool result was synthetic; and the archived results identify only the baseline source and lockfile, not the benchmark script or installed dependency graph. Future adoption requires a new real-context benchmark with complete provenance. The candidate also differs in failure recovery: a failed encoder module evaluation is cached by the runtime, so a subsequent import cannot retry it. This limitation belongs to the rejected prototype; the retained implementation keeps its existing retry behavior.

This development-only comparison installs a separate, pinned copy of `gpt-tokenizer` for the candidate, independent of the application dependency graph. From the repository root:

```sh
npm install --prefix .runtime/phase6-tokenizer --no-save --no-package-lock --ignore-scripts --workspaces=false gpt-tokenizer@4.1.0
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/benchmarks/phase-6-tokenizer/compare.mjs
ROC_TOKENIZER_MERGE_CACHE=off ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/benchmarks/phase-6-tokenizer/compare.mjs
```

The comparison now includes the known whitespace counterexamples and exits nonzero on the first mismatch, writing `.runtime/phase6-tokenizer/semantic-rejection.json`; it does not overwrite the archived historical timing results. An example rejection is committed as `semantic-rejection.json`. The commands above are therefore expected to reject the candidate before performance sampling.

The experiment compiles `ContextTokenCounter` from baseline commit `5f80ed9cc81fc11c26bc536e5ec0a33289e49308` and a variant that replaces its tokenizer loader, preserving the original model-to-encoding mapping, byte fallback, message projection, text cache and budget calculation. Both encode special-token strings as ordinary text. The historical corpus covered all six existing encodings, including a deterministic 256-string Unicode/special-token corpus, a published Chinese and English abstract, an existing generated English PDF fixture, repository TypeScript, a representative tool schema, and a generated long tool result. These fixtures are not a representative sample of private user documents.

Each timing sample in the historical runs started a separate Electron-as-Node process. The two frequently used encodings are measured in alternating baseline/candidate order; each process measures the first count, first budget and message count, repeated cached and uncached calls, event-loop timer delay and peak RSS. `results-default-cache.json` uses the candidate library's default 100,000-entry merge cache. `results-no-merge-cache.json` disables it before the first count; Roc's own per-counter cache remains enabled in both modes. Peak RSS includes the common process baseline; timer delay measures responsiveness during the named operation, not total application startup. The raw process samples and provenance are recorded in the result files.

The published abstract is from 刘晓华、樊景豪、赵体召, “自动气象站观测场的防雷工程综述” (2015), [DOI 10.12677/ccrl.2015.42006](https://doi.org/10.12677/ccrl.2015.42006), licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); its attribution and text are in `tests/fixtures/architecture-repair/tokenizer-paper-excerpts.json`. The PDF is `tests/smoke/lib/assets/p5-paper.pdf`; the TypeScript fixture comes from the baseline version of `src/main/services/deep-agent/context/context-token-budget.ts`. The baseline source hash, fixture hashes, lockfile hash, runtime versions, CPU and base commit are included with each run. The evaluation does not claim that message framing or non-OpenAI provider counts are exact.
