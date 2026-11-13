# Dependency experiment decisions

The unadopted prototypes below were removed during repository cleanup. Their code remains in Git history. These experiments did not change the application dependency graph.

| Candidate | Decision and reason |
| --- | --- |
| `gpt-tokenizer@4.1.0` | Rejected. U+FEFF whitespace counts differ from `js-tiktoken` and can change context-budget decisions. Historical synthetic timings lacked complete provenance. Any future trial needs real contexts and exact-count checks. |
| `@langchain/langgraph-checkpoint-sqlite@1.1.0` | Not adopted. Candidate tables fail Roc schema validation, and the trial native driver has a Node/Electron ABI mismatch. Migration would also need data conversion, backup rollback, retention and packaging verification. |
| `execa@10.2.1` | Rejected. Adapting the single `scutil --proxy` call adds code and a second Execa major without removing the existing timeout, output-cap or fallback requirements. |
| `fuzzysort` | Not adopted. File-name matcher prototypes were isolated from production and required a separate candidate installation. The application's existing search benchmarks and verification scripts remain available. |
