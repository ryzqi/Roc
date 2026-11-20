"""Independent saved-source/SQLite readback. No TypeScript production imports or model judgments."""
import hashlib
import json
import re
import sqlite3
import struct
import sys
from pathlib import Path


def sha(data):
    return hashlib.sha256(data).hexdigest()


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def pinned(path, expected):
    data = Path(path).read_bytes()
    assert sha(data) == expected, path
    return data


report_path, output_path = map(Path, sys.argv[1:3])
report_bytes = report_path.read_bytes()
report = json.loads(report_bytes)
assert report["kind"] == "scientific-generations-saved-ir-storage-regression"
assert len(report["trials"]) == 2
inputs = report["inputs"]
for item in inputs:
    pinned(item["path"], item["sha256"])
    assert str(Path(item["path"]).stat().st_mtime_ns) == item["mtimeNs"]
previous = json.loads(pinned(report["sourceReport"]["path"], report["sourceReport"]["sha256"]))
results = []
for trial in report["trials"]:
    path = trial["database"]["path"]
    pinned(path, trial["database"]["sha256"])
    source_rows = json.loads(pinned(trial["sources"]["path"], trial["sources"]["sha256"]))
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    totals = {"sources": len(source_rows), "failedSources": 0, "chunks": 0, "retrieval": 0,
              "partialVectors": 0, "retainedHistory": 0}
    queried = 0
    try:
        assert db.execute("PRAGMA integrity_check").fetchall()[0][0] == "ok"
        assert not db.execute("PRAGMA foreign_key_check").fetchall()
        assert db.execute("SELECT current_version FROM schema_metadata").fetchone()[0] == 72
        assert not db.execute("SELECT 1 FROM research_scientific_index_generations WHERE status='building'").fetchall()
        for source in source_rows:
            if source["status"] != "parsed":
                totals["failedSources"] += 1
                assert source["generations"] is None
                continue
            original = json.loads(pinned(source["sourceChunks"]["path"], source["sourceChunks"]["sha256"]))
            ir = json.loads(pinned(Path(previous["irRoot"]) / source["ir"]["path"], source["ir"]["sha256"]))
            original_relations = {r["id"]: r for r in ir["relations"]}
            retrieval = [c for c in original if c["retrieval"]]
            for state, generation_id in source["generations"].items():
                g = db.execute("SELECT * FROM research_scientific_index_generations WHERE id=?", (generation_id,)).fetchone()
                assert g["status"] == state
                assert g["project_id"] is None
                assert g["document_id"] == ir["identity"]["documentId"]
                for field, key in [("source_hash", "sourceHash"), ("parse_id", "parseId"), ("parse_hash", "parseHash")]:
                    assert g[field] == ir["identity"][key]
                assert g["paper_ir_version"] == ir["version"]
                assert g["chunk_version"] == "roc-scientific-chunks/1"
                snapshot = json.loads(g["snapshot_json"])
                assert sha(g["snapshot_json"].encode()) == g["snapshot_hash"]
                assert snapshot["paperIR"] == source["ir"]
                assert snapshot["source"] == {"kind": "library"}
                assert g["scope_key"] == sha(compact([None, ir["identity"]["documentId"]]).encode())
                assert g["embedding_model"] == "deterministic-one-hot-test-vector"
                assert g["embedding_config_id"] == "storage-replay-only"
                revision = 1 if state == "retired" else 2
                assert g["embedding_config_revision"] == revision
                assert g["dimensions"] == 3
                rows = db.execute("SELECT * FROM research_scientific_chunks WHERE generation_id=? ORDER BY ordinal",
                                  (generation_id,)).fetchall()
                assert [json.loads(row["chunk_json"]) for row in rows] == original
                serialized = "[" + ",".join(row["chunk_json"] for row in rows) + "]"
                assert sha(serialized.encode()) == g["chunks_hash"]
                assert g["chunk_count"] == len(original)
                assert g["retrievable_count"] == len(retrieval)
                for ordinal, (row, c) in enumerate(zip(rows, original)):
                    assert row["ordinal"] == ordinal
                    for field, key in [("id", "id"), ("document_id", "documentId"), ("paper_id", "paperId"),
                                       ("object_id", "objectId"), ("parent_id", "parentId"), ("chunk_type", "chunkType"),
                                       ("content", "content"), ("embedding_text", "embeddingText"),
                                       ("input_version", "inputVersion"), ("content_hash", "contentHash"),
                                       ("embedding_text_hash", "embeddingTextHash")]:
                        assert row[field] == c[key]
                    assert row["project_id"] is None
                    assert bool(row["retrieval"]) == c["retrieval"]
                    assert json.loads(row["section_path"]) == c["sectionPath"]
                    assert json.loads(row["semantic_roles"]) == c["semantic"]["roles"]
                    assert json.loads(row["locator_json"]) == c["sourceLocator"]
                    assert sha(row["chunk_json"].encode()) == row["chunk_hash"]
                    assert sha(c["content"].encode()) == c["contentHash"]
                    assert sha(c["embeddingText"].encode()) == c["embeddingTextHash"]
                fts = db.execute("SELECT chunk_id,content FROM research_scientific_fts WHERE generation_id=?",
                                 (generation_id,)).fetchall()
                assert len(fts) == len(retrieval)
                assert dict((r["chunk_id"], r["content"]) for r in fts) == dict((c["id"], c["embeddingText"]) for c in retrieval)
                relation_rows = [dict(row) for row in db.execute(
                    "SELECT chunk_id,relation_id,relation_json FROM research_scientific_chunk_relations WHERE generation_id=?",
                    (generation_id,))]
                relation_rows.sort(key=lambda row: (row["chunk_id"], row["relation_id"]))
                assert sha(compact(relation_rows).encode()) == g["relations_hash"]
                assert {(r["chunk_id"], r["relation_id"]) for r in relation_rows} == {
                    (c["id"], rid) for c in original for rid in c["relationIds"]}
                for r in relation_rows:
                    assert json.loads(r["relation_json"]) == original_relations[r["relation_id"]]
                vectors = db.execute("SELECT * FROM research_scientific_embeddings WHERE generation_id=?",
                                     (generation_id,)).fetchall()
                expected = retrieval[:1] if state == "failed" and len(retrieval) > 1 else ([] if state == "failed" else retrieval)
                assert len(vectors) == len(expected)
                expected_by_id = {c["id"]: c for c in expected}
                for v in vectors:
                    c = expected_by_id[v["chunk_id"]]
                    assert v["config_id"] == g["embedding_config_id"] and v["config_revision"] == revision
                    assert v["model"] == g["embedding_model"] and v["dimensions"] == 3
                    assert v["input_hash"] == c["embeddingTextHash"] and v["input_version"] == c["inputVersion"]
                    assert sha(v["embedding"]) == v["embedding_hash"]
                    axis = int(c["embeddingTextHash"][:2], 16) % 3
                    assert struct.unpack("<fff", v["embedding"]) == tuple(float(i == axis) for i in range(3))
                if state == "failed":
                    totals["partialVectors"] += len(vectors)
                    assert g["error"] == "simulated_provider_failure"
                if state == "active":
                    assert g["published_at"] is not None
                    # Exercise actual FTS postings against the active scope, independently of the publisher.
                    for c in retrieval[:1]:
                        terms = re.findall(r"[A-Za-z]{3,}", c["embeddingText"])
                        if terms:
                            hits = db.execute("""SELECT f.chunk_id,g.id FROM research_scientific_fts f
                              JOIN research_scientific_index_generations g ON g.id=f.generation_id
                              WHERE research_scientific_fts MATCH ? AND g.scope_key=? AND g.status='active'""",
                                              ('"' + terms[0] + '"', g["scope_key"])).fetchall()
                            assert c["id"] in {row[0] for row in hits}
                            assert all(row[1] == generation_id for row in hits)
                            queried += 1
            totals["chunks"] += len(original)
            totals["retrieval"] += len(retrieval)
            totals["retainedHistory"] += 1
        assert totals == trial["totals"]
        assert db.execute("SELECT count(*) FROM research_scientific_index_generations").fetchone()[0] == totals["retainedHistory"] * 3
        assert db.execute("SELECT count(*) FROM research_scientific_chunks").fetchone()[0] == totals["chunks"] * 3
        assert db.execute("SELECT count(*) FROM research_scientific_fts").fetchone()[0] == totals["retrieval"] * 3
        assert db.execute("SELECT count(*) FROM research_scientific_embeddings").fetchone()[0] == totals["retrieval"] * 2 + totals["partialVectors"]
    finally:
        db.close()
    pinned(path, trial["database"]["sha256"])
    results.append({"totals": totals, "activePostingQueries": queried})
assert results[0] == results[1]
for item in inputs:
    pinned(item["path"], item["sha256"])
    assert str(Path(item["path"]).stat().st_mtime_ns) == item["mtimeNs"]
result = {"schemaVersion": 1, "status": "verified", "report": str(report_path),
          "reportSha256": sha(report_bytes), "trials": results, "unchangedInputs": len(inputs),
          "limitations": ["Storage/config/publication only; test vectors have no semantic-quality meaning."]}
with output_path.open("x") as stream:
    json.dump(result, stream, indent=2, ensure_ascii=False)
    stream.write("\n")
print(json.dumps(result, ensure_ascii=False))
