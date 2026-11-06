# Research task facts

Task facts are bounded, immutable revisions in the agent identity database (migration 18). Each entry stores a kind, content, lifecycle state and one to eight typed source references. Supported kinds are confirmed constraints, source versions, human decisions, unverified hypotheses, todos, counterevidence, evaluation conditions and user corrections. Facts are research data and never grant capabilities or replace approval.

`research.getTaskFacts`, `research.saveTaskFacts` and `research.getTaskFactsHistory` require explicit project/task identity. Saving requires the main process human context for `research.task.facts.save`; the actor comes from the submitting window, with no actor or approval fields on the wire. `expectedRevision` enforces optimistic concurrency. The store seals normalized snapshots, checks their SHA256 and physical task/revision identity, refuses updates, and retains old revisions when new entries correct or supersede them. Task deletion cascades.

Limits are 100 entries, 2,000 characters per content, eight references per entry and 32,000 serialized characters across entries. History pages contain at most 50 revisions. The management drawer supports user entries, explicit completion/replacement and the latest 50 history revisions. Full history remains available through the bounded cursor API. Failed saves preserve the draft; refresh reads the current revision.

Artifact references bind the inspector version. Documents bind the source SHA256 and committed parse identity. Execution references bind a task-owned execution and its manifest hash. Reads compare each reference to current state and explicitly report changed, unlinked or deleted sources without rewriting history. Active entries with expired references cannot be saved; completing or replacing them preserves their old reference. Storage corruption and scope mismatches fail.

Stage execution and retries reconstruct the task goal and latest facts from durable storage. The main assistant harness uses the read-only scoped `research.task.facts.forChat` capability before each model call, including checkpoint continuation and compaction. A transient `HumanMessage` carries the task context; it does not accumulate in checkpoint state or modify the system message. It wraps the budget observer, so the injected data contributes to the model reservation. The same task context accompanies harness subagent model calls.

Status: `Verified passing` for local engineering. Final focused suite 30/30, full unit 1463/1463, Harness 94/94, Electron task UI 13/13 and startup 13/13 passed. Build/TypeScript, IPC generation and renderer chunk checks passed. The earlier full-suite failure used a stale test API bundle; its log is retained and the fresh full-suite run passed.

Verification from `/Users/Apple_501/Desktop/Roc/Roc`:

- `node --test tests/unit/research-task-facts.test.mjs tests/unit/research-task-budget.test.mjs tests/unit/database-migrations.test.mjs`: real SQLite backup/reopen, immutable revisions, source/parse deletion and drift, foreign identity, human IPC, revision conflicts, limits, provider message boundaries and transient recovery.
- `pnpm build`: renderer/main/preload build and TypeScript contracts.
- `node --test tests/renderer/research-tasks.test.mjs`: actual Electron keyboard save, history, expiry, conflict drafts, pending locks, cross-project late responses, light/dark layouts and clipping.
- `pnpm test:unit`, `pnpm harness:eval`, `node scripts/smoke-electron.mjs`, `pnpm check:ipc`, `pnpm check:renderer-chunks`: repository gates.

Logs and screenshots are retained under `.artifacts/research-optimization/facts-*` and `.artifacts/research-optimization/task-ui/`. These are local engineering checks. Independent long-context scientific quality, prompt-injection success rates and the reviewed PR-03 task-family corpus remain unrun; no live provider quality result is claimed.
