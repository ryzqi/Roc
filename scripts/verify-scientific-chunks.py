"""Independent stdlib readback of original IR fields, UTF-16 spans, cells and chunk content."""
import hashlib
import json
import pathlib
import sys


def digest(data):
    return hashlib.sha256(data).hexdigest()


def text_hash(text):
    return digest(text.encode("utf-8"))


def utf16_slice(text, start, end):
    return text.encode("utf-16-le")[start * 2:end * 2].decode("utf-16-le")


def read_json(path, sha=None):
    data = pathlib.Path(path).read_bytes()
    if sha is not None:
        assert digest(data) == sha, path
    return json.loads(data)


def verify(ir, chunks):
    objects = {o["id"]: o for key in ["blocks", "sections", "tables", "figures", "equations", "algorithms"]
               for o in ir[key]}
    objects.update({c["id"]: c for t in ir["tables"] for c in t["cells"]})
    objects.update({s["id"]: s for a in ir["algorithms"] for s in a["steps"]})
    blocks = {b["blockId"]: b for b in ir["blocks"]}
    by_id = {c["id"]: c for c in chunks}
    assert len(by_id) == len(chunks)
    for chunk in chunks:
        selection = chunk["selection"]
        obj = objects[chunk["objectId"]]
        block = blocks[obj["blockId"]]
        locator = chunk["sourceLocator"]
        assert locator["objectId"] == obj["id"]
        assert {k: v for k, v in locator.items() if k != "textSpan"} == {
            k: v for k, v in obj["sourceLocator"].items() if k != "textSpan"}
        for field in ["paperId", "documentId", "parseId"]:
            assert chunk[field] == ir["identity"][field]
        assert chunk["contentHash"] == text_hash(chunk["content"])
        assert chunk["embeddingTextHash"] == text_hash(chunk["embeddingText"])
        assert chunk["relationIds"] == [r["id"] for r in ir["relations"]
                                       if r["fromId"] == obj["id"] or r["toId"] == obj["id"]]
        if chunk["parentId"]:
            parent = by_id[chunk["parentId"]]
            # The OCR fallback belongs to the table, but its exact text belongs to the raw block.
            assert parent["objectId"] == obj["id"] or parent["sourceLocator"]["blockId"] == block["blockId"]
        for part in chunk["sources"]:
            source = objects[part["locator"]["objectId"]]
            original = source["sourceLocator"]
            assert {k: v for k, v in part["locator"].items() if k != "textSpan"} == {
                k: v for k, v in original.items() if k != "textSpan"}
            field, text = part["field"], part["text"]
            if field in ["text", "caption", "context", "variable"]:
                span = part["locator"].get("textSpan")
                assert text == (utf16_slice(source["text"], span["start"], span["end"]) if span else source["text"])
            elif field in ["header", "cell", "step"]:
                assert text == source["text"]
                assert part["locator"] == original
            elif field == "latex":
                assert text == (source["data"]["rawLatex"] if source["data"]["rawLatex"] is not None
                                else blocks[source["blockId"]]["text"])
            elif field == "footnote":
                assert text in source["data"]["footnotes"]
            elif field == "html-caption":
                assert text == source["data"]["caption"]
            else:
                raise AssertionError(field)
        kind = chunk["chunkType"]
        if kind in ["paragraph", "caption"]:
            span = selection.get("span")
            expected = utf16_slice(block["text"], span["start"], span["end"]) if span else block["text"]
        elif kind in ["table", "table_row_group"]:
            rows = selection.get("rows", [r["index"] for r in obj["data"]["rows"]])
            cells = [(r["index"], c) for r in obj["data"]["rows"] for c in r["cells"]
                     if any(r["index"] <= row < r["index"] + c["rowSpan"] for row in rows)]
            expected = "\n".join(f'Row {r}, column {c["column"]}, span {c["rowSpan"]}x{c["colSpan"]}: {c["text"]}'
                                 for r, c in cells)
            selected_sources = {p["locator"]["objectId"] for p in chunk["sources"] if p["field"] in ["cell", "header"]}
            original_to_ir = {c["originalId"]: c["id"] for c in obj["cells"]}
            for _, cell in cells:
                assert original_to_ir[cell["id"]] in selected_sources
            for column in obj["data"]["columns"]:
                for cell_id in column["headerCellIds"]:
                    assert original_to_ir[cell_id] in selected_sources
            for caption in obj.get("visual", {}).get("captions", []):
                if caption["status"] == "linked":
                    assert any(p["text"] == caption["evidence"]["text"] and p["field"] == "caption"
                               for p in chunk["sources"])
        elif kind == "equation":
            expected = obj["data"]["rawLatex"] if obj["data"]["rawLatex"] is not None else block["text"]
            assert expected in chunk["embeddingText"]
        elif kind == "figure":
            expected = "\n".join(p["text"] for p in chunk["sources"])
        elif kind == "algorithm":
            expected = "\n".join(objects[s]["text"] for s in selection["steps"]) if "steps" in selection else obj["text"]
        else:
            raise AssertionError(kind)
        assert chunk["content"] == expected, chunk["id"]
    # Full paragraph ranges reconstruct raw blocks, child ranges reconstruct each parent.
    for block in ir["blocks"]:
        parents = [c for c in chunks if c["objectId"] == block["id"] and c["chunkType"] == "paragraph"
                   and c["parentId"] is None]
        if parents:
            assert "".join(c["content"] for c in parents) == block["text"]
            for parent in parents:
                children = [c for c in chunks if c["parentId"] == parent["id"]]
                if children:
                    assert "".join(c["content"] for c in children) == parent["content"]
    for algorithm in ir["algorithms"]:
        children = [c for c in chunks if c["chunkType"] == "algorithm" and c["objectId"] == algorithm["id"]
                    and c["parentId"] is not None]
        if children:
            assert [s["locator"]["objectId"] for c in children for s in c["sources"]] == [s["id"] for s in algorithm["steps"]]


report_path = pathlib.Path(sys.argv[1])
report = read_json(report_path)
counts = None
for trial in range(2):
    rows = read_json(pathlib.Path(report["root"]) / f"trial-{trial}.json")
    totals = {"sources": len(rows), "failedSources": 0, "chunks": 0, "retrieval": 0, "oversized": 0,
              "sourceParts": 0, "types": {}}
    for row in rows:
        if row["status"] != "parsed":
            assert row["failure"] is not None and row["ir"] is None
            totals["failedSources"] += 1
            continue
        ir = read_json(pathlib.Path(report["irRoot"]) / row["ir"]["path"], row["ir"]["sha256"])
        chunks = read_json(pathlib.Path(report["root"]) / row["path"], row["sha256"])
        verify(ir, chunks)
        if trial:
            original = pathlib.Path(report["root"]) / row["path"].replace("trial-1/", "trial-0/")
            assert original.read_bytes() == (pathlib.Path(report["root"]) / row["path"]).read_bytes()
        totals["chunks"] += len(chunks)
        for chunk in chunks:
            totals["types"][chunk["chunkType"]] = totals["types"].get(chunk["chunkType"], 0) + 1
            totals["retrieval"] += int(chunk["retrieval"])
            totals["oversized"] += int(chunk["oversized"])
            totals["sourceParts"] += len(chunk["sources"])
    assert totals == report["counts"]
    if counts is None:
        counts = totals
    else:
        assert counts == totals
for pin in report["inputs"]:
    assert digest(pathlib.Path(pin["path"]).read_bytes()) == pin["sha256"]
    assert str(pathlib.Path(pin["path"]).stat().st_mtime_ns) == pin["mtimeNs"]
result = {"status": "verified", "reportSha256": digest(report_path.read_bytes()), "counts": counts,
          "trials": 2, "inputs": len(report["inputs"])}
pathlib.Path(sys.argv[2]).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps(result))
