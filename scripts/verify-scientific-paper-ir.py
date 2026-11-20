"""Independent original JSON/HTML/LaTeX and immutable Paper IR readback."""
import hashlib
import importlib.util
import json
import re
import sys
from pathlib import Path
from urllib.parse import quote


def read(path):
    return json.loads(Path(path).read_text())


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


tables = load("verify-scientific-tables")


def oid(kind, parse_id, source_id):
    return ":".join([kind, quote(parse_id, safe="~!*'()-_."), quote(source_id, safe="~!*'()-_.")])


def span_text(text, span):
    return text.encode("utf-16-le")[span["start"] * 2:span["end"] * 2].decode("utf-16-le")


def verify(path):
    report = read(path)
    for file, sha in report["codeHashes"].items():
        assert digest(file) == sha, file
    for pin in report["inputs"]:
        assert digest(pin["path"]) == pin["sha256"]
        assert Path(pin["path"]).stat().st_mtime_ns == int(pin["mtimeNs"])
    root = Path(report["root"])
    trials = [read(root / f"trial-{trial}.json") for trial in range(2)]
    assert trials[0] == trials[1]
    for trial, rows in enumerate(trials):
        canonical = json.dumps(rows, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
        assert hashlib.sha256(canonical).hexdigest() == report["trials"][trial]["deterministicHash"]
    counts = dict(sources=0, failedSources=0, blocks=0, sections=0, tables=0, cells=0, figures=0,
                  equations=0, algorithms=0, citations=0, references=0, relations=0)
    for row in trials[0]:
        counts["sources"] += 1
        run = read(report["cohorts"][row["cohort"]]["run"])
        source = run["rows"][row["index"]]
        assert row["status"] == source["status"] and row["sourceHash"] == source["sourceHash"]
        assert row["failure"] == source["failure"]
        if row["status"] != "parsed":
            assert row["receipt"] is None and row["contentPath"] is None
            counts["failedSources"] += 1
            continue
        content = read(root / row["contentPath"])
        receipt = row["receipt"]
        artifact = root / receipt["path"]
        assert digest(artifact) == receipt["sha256"] and artifact.stat().st_size == receipt["size"]
        ir = read(artifact)
        assert ir["identity"] == receipt["identity"] and ir["metadata"] == receipt["metadata"]
        assert ir["identity"]["parseHash"] == digest(root / row["contentPath"])
        assert ir["identity"]["sourceHash"] == source["sourceHash"]
        assert ir["identity"]["parserFingerprint"] == content["parserFingerprint"]
        expected_paper = source.get("paperId") or f'raster:{row["index"]}'
        assert ir["identity"]["paperId"] == expected_paper
        parse_id = f'saved:{row["cohort"]}:{row["index"]}'
        assert ir["identity"]["parseId"] == parse_id
        scope = hashlib.sha256((expected_paper + "\n" + parse_id).encode()).hexdigest()
        assert receipt["path"] == f'paper-ir/{scope}/{ir["identity"]["parseHash"]}/{receipt["sha256"]}.json'
        original = read(Path(run["root"]) / source["result"])
        structured = read(Path(run["root"]) / source["structured"])
        blocks = {b["id"]: b for b in original["blocks"]}
        regions = {r["id"]: r for p in structured["pages"] for r in p["regions"]}
        for a, b in zip(content["blocks"], original["blocks"]):
            for key in ("id", "kind", "text", "locator", "locations", "imagePath"):
                assert a[key] == b[key]
        assert len(ir["blocks"]) == len(blocks)
        objects = ir["sections"] + ir["blocks"] + ir["tables"] + ir["figures"] + ir["equations"] + ir["algorithms"]
        objects += ir["citations"] + ir["references"]
        objects += [c for t in ir["tables"] for c in t["cells"]] + [s for a in ir["algorithms"] for s in a["steps"]]
        assert len({o["id"] for o in objects}) == len(objects)
        cells = {c["id"] for t in ir["tables"] for c in t["cells"]}
        ids = {o["id"] for o in objects}
        for obj in objects:
            locator = obj["sourceLocator"]
            block = blocks[obj["blockId"]]
            assert locator["blockId"] == locator["parentBlockId"] == block["id"]
            assert locator["objectId"] == obj["id"] and locator["rawLocator"] == block["locator"]
            for key in ("documentId", "knowledgeDocumentId", "parseId", "parseHash", "sourceHash", "parserFingerprint"):
                assert locator[key] == ir["identity"][key]
            if obj["id"] not in cells:
                assert locator["locations"] == block["locations"]
            if "textSpan" in locator and "text" in obj:
                assert span_text(block["text"], locator["textSpan"]) == obj["text"]
        for block in ir["blocks"]:
            assert block["text"] == blocks[block["blockId"]]["text"]
            assert block["id"] == oid("block", parse_id, block["blockId"])
        for table in ir["tables"]:
            raw = blocks[table["blockId"]]
            expected = tables.derive(raw, regions.get(raw["id"], {}))
            for key, value in expected.items():
                assert table["data"][key] == value, (raw["id"], key)
            anchors = [(r["index"], c) for r in table["data"]["rows"] for c in r["cells"]]
            assert len(anchors) == len(table["cells"])
            for obj, (row_index, cell) in zip(table["cells"], anchors):
                assert obj["id"] == oid("cell", parse_id, cell["id"]) and obj["text"] == cell["text"]
                assert obj["row"] == row_index and obj["column"] == cell["column"]
                assert obj["sourceLocator"]["locations"] == [dict(page=table["data"]["source"]["page"],
                    bbox=cell["bbox"], coordinateOrigin=table["data"]["source"]["coordinateOrigin"] if cell["bbox"] else None)]
            counts["cells"] += len(anchors)
        for equation in ir["equations"]:
            raw_latex = regions[equation["blockId"]].get("formula")
            assert equation["data"]["rawLatex"] == (raw_latex if raw_latex and raw_latex.strip() else None)
        for algorithm in ir["algorithms"]:
            assert algorithm["text"] == blocks[algorithm["blockId"]]["text"]
            lines = [line for line in algorithm["text"].split("\n") if line.strip()]
            assert [step["text"] for step in algorithm["steps"]] == lines
        for relation in ir["relations"]:
            assert relation["fromId"] in ids and relation["toId"] in ids and relation["fromId"] != relation["toId"]
            locator = relation["sourceLocator"]
            assert locator["objectId"] in ids
            start = str(locator["textSpan"]["start"]) if "textSpan" in locator else ""
            assert relation["id"] == oid("relation", parse_id,
                f'{relation["type"]}:{relation["fromId"]}:{relation["toId"]}:{start}')
            assert relation["type"] != "supports"
        for key in ("blocks", "sections", "tables", "figures", "equations", "algorithms", "citations", "references", "relations"):
            counts[key] += len(ir[key])
    assert counts == report["counts"]
    return dict(status="verified", reportSha256=digest(path), counts=counts, trials=2, inputs=len(report["inputs"]))


if __name__ == "__main__":
    result = verify(sys.argv[1])
    if len(sys.argv) > 2:
        with open(sys.argv[2], "x") as output:
            json.dump(result, output, indent=2)
    print(json.dumps(result))
