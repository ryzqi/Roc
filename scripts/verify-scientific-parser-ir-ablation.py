"""Offline independent original-source verifier. Imports no production code.

Pass iff every locked source/failure is retained, both B representations resolve
to the same original parse, and current A resolves to raw PDF.js/native/OCR input.
Missing gold and the unavailable A off-arm remain explicit, never scored as zero.
"""
import copy
import hashlib
import importlib.util
import json
import math
import re
import statistics
import sys
from pathlib import Path
from urllib.parse import quote

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("independent_tables", Path(__file__).with_name("verify-scientific-tables.py"))
tables = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tables)


def read(path):
    return json.loads(Path(path).read_bytes())


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x") as output:
        json.dump(value, output, ensure_ascii=False, separators=(",", ":"))
    return {"path": str(path), "sha256": digest(path), "bytes": path.stat().st_size}


def oid(kind, parse_id, source_id):
    return ":".join([kind, quote(parse_id, safe="~!*'()-_."), quote(source_id, safe="~!*'()-_.")])


def utf16(text, span):
    assert 0 <= span["start"] < span["end"] <= len(text.encode("utf-16-le")) // 2
    return text.encode("utf-16-le")[span["start"] * 2:span["end"] * 2].decode("utf-16-le")


def close(a, b):
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(close(x, y) for x, y in zip(a, b))
    return isinstance(a, (float, int)) and isinstance(b, (float, int)) and abs(a - b) <= 1e-6


def clean(text):
    return re.sub(r"\n{3,}", "\n\n", re.sub("[ \t]+", " ", text.replace("\0", ""))).strip()


def compact(text):
    import unicodedata
    return re.sub(r"\s", "", unicodedata.normalize("NFC", clean(text)))


def area(b):
    return max(0, b[2] - b[0]) * max(0, b[3] - b[1])


def intersection(a, b):
    return max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))


def same_native(text, items):
    raw = [compact(i["text"]) for i in items]
    return sorted(compact(text)) == sorted("".join(raw)) and all(t in compact(text) for t in raw)


def verify_selection(locked, observed):
    assert len(locked) == len(observed) == 91, "locked denominator missing"
    assert [r["ordinal"] for r in observed] == [r["ordinal"] for r in locked]
    assert [r["sourceHash"] for r in observed] == [r["sourceHash"] for r in locked]


def verify_unavailable(value):
    assert value == {"status": "unavailable", "reason": "production_fusion_off_switch_absent", "output": None}


def similarity(a, b):
    from collections import Counter
    a, b = compact(a).lower(), compact(b).lower()
    if a == b:
        return 1 if a else 0
    if min(len(a), len(b)) < 2:
        return 0
    ca, cb = Counter(a[i:i+2] for i in range(len(a)-1)), Counter(b[i:i+2] for i in range(len(b)-1))
    return 2 * sum((ca & cb).values()) / (len(a) + len(b) - 2)


def verify_native_source(page, raw):
    assert raw["page"] == page["page"]
    frame = page["coordinateFrame"]
    assert frame["viewport"]["viewBox"] == raw["view"]
    assert frame["viewport"]["rotation"] == raw["rotate"] and frame["viewport"]["userUnit"] == raw["userUnit"]
    originals = [(index, item) for index, item in enumerate(raw["content"]["items"]) if "str" in item]
    assert len(originals) == len(page["nativeTextItems"])
    # PDF.js counters depend on document lifetime. Bind temporary handles by
    # the complete item-index/font-group bijection; preserve every style check.
    forward, reverse = {}, {}
    saved_documents, raw_documents = set(), set()
    for (index, source), item in zip(originals, page["nativeTextItems"]):
        style = raw["content"]["styles"].get(source["fontName"], {})
        left, right = item["fontName"], source["fontName"]
        saved_handle = re.fullmatch(r"(g_d\d+)_f\d+", left)
        raw_handle = re.fullmatch(r"(g_d\d+)_f\d+", right)
        assert saved_handle and raw_handle, "invalid PDF.js font handle"
        saved_documents.add(saved_handle[1])
        raw_documents.add(raw_handle[1])
        assert forward.setdefault(left, right) == right, "one saved font maps to two raw fonts"
        assert reverse.setdefault(right, left) == left, "one raw font maps to two saved fonts"
        assert item["id"] == f'page-{page["page"]}-native-item-{index+1}'
        assert item["itemIndex"] == index and item["page"] == page["page"]
        assert item["text"] == source["str"] and item["transform"] == source["transform"]
        assert item["width"] == source["width"] and item["height"] == source["height"]
        assert item["fontFamily"] == style.get("fontFamily")
        assert item["direction"] == source["dir"] and item["hasEOL"] == source["hasEOL"]
        assert item["vertical"] == (style.get("vertical") is True)
        ascent, descent = style.get("ascent"), style.get("descent")
        assert item["ascent"] == ascent and item["descent"] == descent
        a, b, c, d, x, y = source["transform"]
        size, baseline = math.hypot(c, d), math.hypot(a, b)
        assert close(item["fontSize"], size)
        if not size or not baseline:
            assert item["geometry"] == "unavailable"
            assert all(item[key] is None for key in ("pdfQuad", "pdfBbox", "bbox", "rasterBbox"))
            continue
        vertical = item["vertical"]
        advance = [-b / baseline, a / baseline] if vertical else [a / baseline, b / baseline]
        up = [a / baseline, b / baseline] if vertical else [c / size, d / size]
        length = abs(source["height"] if vertical else source["width"])
        lo, hi = size * (descent if descent is not None else 0), size * (ascent if ascent is not None else 1)
        quad = [[x + along * advance[0] + rise * up[0], y + along * advance[1] + rise * up[1]]
                for along, rise in [(0, lo), (length, lo), (length, hi), (0, hi)]]
        bounds = lambda points: [min(p[0] for p in points), min(p[1] for p in points),
                                 max(p[0] for p in points), max(p[1] for p in points)]
        va, vb, vc, vd, ve, vf = frame["viewport"]["transform"]
        raster = bounds([[va*px+vc*py+ve, vb*px+vd*py+vf] for px, py in quad])
        clipped = [max(0, raster[0]), max(0, raster[1]), min(frame["width"], raster[2]), min(frame["height"], raster[3])]
        visible = clipped if clipped[2] > clipped[0] and clipped[3] > clipped[1] else None
        assert close(item["pdfQuad"], quad) and close(item["pdfBbox"], bounds(quad))
        assert close(item["rasterBbox"], raster)
        assert item["bbox"] is None if visible is None else close(item["bbox"], visible)
        assert item["viewportClipped"] == (visible is None or visible != raster)
        assert item["geometry"] == ("font-box-fallback" if ascent is None or descent is None else "font-metrics")
    if originals:
        assert len(saved_documents) == len(raw_documents) == 1, "mixed PDF document font handles"
    return len(originals)


def verify_fusion(page, original_input, result):
    kind = lambda t: "table" if t == "table" else "formula" if t in ("formula", "equation") else (
        "figure" if t in ("figure", "image", "chart") else "heading" if t in ("title", "doc_title", "paragraph_title") else "paragraph")
    expected = {"page": page["page"], "width": page["coordinateFrame"]["width"],
                "nativeItems": page["nativeTextItems"], "regions": [
                    {"score": region["score"], "block": {
                        "id": region["id"], "kind": kind(region["type"]), "label": (region["label"] or "").strip() or kind(region["type"]),
                        "text": clean(region["text"]), "locator": f'page {page["page"]}', "imagePath": region["imagePath"],
                        "locations": [{"page": page["page"], "bbox": region["bbox"], "coordinateOrigin": "TOPLEFT"}]}}
                    for region in page["regions"]]}
    assert original_input == expected, "pre-fusion input differs from original regions/native"
    items = {item["id"]: item for item in page["nativeTextItems"]}
    regions = {value["block"]["id"]: value for value in expected["regions"]}
    blocks = {b["id"]: b for b in result["blocks"]}
    assert len(blocks) == len(result["blocks"])
    represented, primary = set(), set()

    def owner(item):
        if item["bbox"] is None:
            return None
        candidates = [v["block"] for v in regions.values()
                      if intersection(item["bbox"], v["block"]["locations"][0]["bbox"]) / max(area(item["bbox"]), 1) >= .65]
        candidates.sort(key=lambda b: area(b["locations"][0]["bbox"]))
        return candidates[0]["id"] if candidates else None

    for p in result["provenance"]:
        assert p["blockId"] in blocks
        block = blocks[p["blockId"]]
        assert len(set(p["nativeItemIds"])) == len(p["nativeItemIds"])
        native = [items[key] for key in p["nativeItemIds"]]
        represented.update(p["nativeItemIds"])
        if p["source"] == "native":
            assert native and p["confidence"] is None
            assert all(p["overlapGroupId"] == (f'overlap:{owner(i)}' if owner(i) else None) for i in native)
            text = next(a["text"] for a in p["alternatives"] if a["source"] == "native") if p["status"] == "duplicate" else block["text"]
            assert same_native(text, native), "native text changed"
            boxes = [i["bbox"] for i in native if i["bbox"] is not None]
            if p["status"] == "duplicate":
                assert len(boxes) == len(native) and block["locations"]
                box = [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]
                dest = block["locations"][0]["bbox"]
                common = intersection(box, dest)
                assert common / (area(box) + area(dest) - common) >= .65 and similarity(text, block["text"]) >= .9
            else:
                assert block["kind"] == "paragraph" and block["locator"] == f'page{page["page"]}'
                expected_locations = [] if not boxes else [{"page": page["page"], "bbox": [
                    min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)],
                    "coordinateOrigin": "TOPLEFT"}]
                assert block["locations"] == expected_locations
            continue
        assert p["blockId"] in regions and p["blockId"] not in primary
        primary.add(p["blockId"])
        source = regions[p["blockId"]]
        for key in ("kind", "label", "locator", "imagePath", "locations"):
            assert block[key] == source["block"][key], key
        assert set(p["nativeItemIds"]) == {i["id"] for i in items.values() if clean(i["text"]) and owner(i) == p["blockId"]}
        assert p["confidence"] == source["score"]
        assert p["overlapGroupId"] == (f'overlap:{p["blockId"]}' if native else None)
        native_text = ""
        if native:
            assert len(p["alternatives"]) == 2
            native_text = next(a["text"] for a in p["alternatives"] if a["source"] == "native")
            assert same_native(native_text, native)
            assert next(a["text"] for a in p["alternatives"] if a["source"] == "ocr") == source["block"]["text"]
        else:
            assert p["alternatives"] == []
        agrees = similarity(native_text, source["block"]["text"]) >= .75
        use_native = bool(native_text) and (not source["block"]["text"] or block["kind"] not in ("table", "figure", "formula") and agrees)
        assert p["source"] == ("merged" if use_native else "ocr")
        assert block["text"] == (native_text if use_native else source["block"]["text"]), "selection changed"
        disputed = bool(native_text and source["block"]["text"] and not agrees)
        assert p["status"] == ("disputed" if disputed else "selected")
        if disputed:
            assert f'recognition_disagreement:{p["blockId"]}' in result["warnings"]
            if block["kind"] not in ("table", "figure", "formula"):
                assert all(any(q["source"] == "native" and q["overlapGroupId"] == p["overlapGroupId"] and
                               i["id"] in q["nativeItemIds"] for q in result["provenance"]) for i in native)
    assert primary == set(regions)
    assert all(i["id"] in represented for i in items.values() if clean(i["text"]))
    assert all(any(p["blockId"] == key for p in result["provenance"]) for key in blocks)
    native = [i for i in items.values() if clean(i["text"])]
    text = "\n\n".join(b["text"] for b in result["blocks"])
    return {"nativeItems": len(native), "represented": sum(i["id"] in represented for i in native),
            "primaryTextSubstringPresence": sum(compact(i["text"]) in compact(text) for i in native),
            "regions": len(regions), "blocks": len(blocks),
            "disputedRecords": sum(p["status"] == "disputed" for p in result["provenance"])}


def verify_pair(row, original, structured, content, block_ir, ir, receipt):
    assert original["blocks"] == structured["blocks"]
    assert original["sourceHash"] == row["sourceHash"] == content["sourceHash"]
    assert len(content["blocks"]) == len(original["blocks"])
    for derived, raw in zip(content["blocks"], original["blocks"]):
        for key, value in original.items():
            if key not in ("blocks", "quality"):
                assert content[key] == value, key
        for key, value in raw.items():
            assert derived[key] == value, (raw["id"], key)
    blocks = {b["id"]: b for b in original["blocks"]}
    enriched = {b["id"]: b for b in content["blocks"]}
    regions = {r["id"]: r for p in structured["pages"] for r in p["regions"]}
    assert len(blocks) == len(original["blocks"])
    originals = {"blocks": len(blocks), "tables": 0, "cells": 0, "figures": 0, "equations": 0,
                 "rawAlgorithmBlocks": 0, "mappedCells": 0, "pageOnlyCells": 0}
    source_objects = []

    def evidence(e):
        block = blocks[e["blockId"]]
        assert e["locator"] == block["locator"] and e["locations"] == block["locations"]
        assert e["text"] == utf16(block["text"], e["textSpan"])

    for raw in original["blocks"]:
        b = enriched[raw["id"]]
        source_objects.append({"type": raw["kind"], "blockId": raw["id"], "sourceHash": row["sourceHash"],
                               "rawLocator": raw["locator"], "locations": raw["locations"]})
        if raw["kind"] == "table":
            expected = tables.derive(raw, regions.get(raw["id"], {}))
            for key, value in expected.items():
                assert b["table"][key] == value, ("raw table mismatch", raw["id"], key)
            assert b["table"]["source"] == dict(raw["locations"][0], locator=raw["locator"])
            assert b["table"]["imagePath"] == raw["imagePath"] and b["table"]["assetId"] is None
            originals["tables"] += 1
            for r in expected["rows"]:
                for c in r["cells"]:
                    originals["cells"] += 1
                    originals["mappedCells" if c["bbox"] is not None else "pageOnlyCells"] += 1
                    source_objects.append({"type": "cell", "blockId": raw["id"], "originalId": c["id"],
                        "row": r["index"], "column": c["column"], "text": c["text"], "sourceHash": row["sourceHash"],
                        "rawLocator": raw["locator"], "locations": [{"page": raw["locations"][0]["page"],
                        "bbox": c["bbox"], "coordinateOrigin": "TOPLEFT" if c["bbox"] else None}]})
        if raw["kind"] == "formula":
            expected_latex = regions.get(raw["id"], {}).get("formula")
            expected_latex = expected_latex if isinstance(expected_latex, str) and expected_latex.strip() else None
            assert b["equation"]["rawLatex"] == expected_latex, "raw formula mismatch"
            assert b["equation"]["source"] == dict(raw["locations"][0], locator=raw["locator"])
            originals["equations"] += 1
            eq = b["equation"]
            for e in eq["contexts"] + [r["evidence"] for r in eq["references"]] + [v["evidence"] for v in eq["variables"]]:
                evidence(e)
            number = eq["numberEvidence"]
            if number:
                if number["kind"] == "block":
                    evidence(number["evidence"])
                else:
                    assert utf16(expected_latex, number) == number["text"]
        if raw["kind"] in ("table", "figure"):
            v = b["visual"]
            assert v["kind"] == raw["kind"] and v["source"] == dict(raw["locations"][0], locator=raw["locator"])
            assert v["imagePath"] == raw["imagePath"] and v["assetId"] is None
            for c in v["captions"] + v["references"]:
                evidence(c["evidence"])
            if raw["kind"] == "figure":
                originals["figures"] += 1
        if re.match(r"\s*(?:Algorithm|算法)\s*\d+\b", raw["text"], re.I) or raw["label"] == "algorithm":
            originals["rawAlgorithmBlocks"] += 1
    # Existing block IR intentionally excludes empty unstructured blocks.
    keep = [b for b in content["blocks"] if b["text"].strip() or b.get("table") or b.get("equation") or b.get("visual")]
    assert len(block_ir) == len(keep)
    for entry, b in zip(block_ir, keep):
        assert entry["content"] == b["text"] and entry["locator"] == b["locator"]
        semantic = entry["semantic"]
        assert semantic["blockId"] == b["id"] and semantic["blockKind"] == b["kind"]
        assert semantic["paperId"] == row["paperId"]
        assert semantic["parseId"] == f'paired:{row["cohort"]}:{row["index"]}'
        assert semantic["sourceHash"] == row["sourceHash"]
        for key in ("table", "equation", "visual"):
            assert semantic.get(key) == b.get(key), key
    identity = ir["identity"]
    assert ir["version"] == "roc-paper-ir/2.1" and ir["schemaVersion"] == 2
    assert identity == receipt["identity"] and ir["metadata"] == receipt["metadata"]
    for key in ("paperId", "documentId", "knowledgeDocumentId"):
        assert identity[key] == row["paperId"]
    assert identity["parseId"] == f'paired:{row["cohort"]}:{row["index"]}'
    assert identity["sourceHash"] == row["sourceHash"] and identity["parserFingerprint"] == original["parserFingerprint"]
    assert len(ir["blocks"]) == len(blocks)
    assert [b["text"] for b in ir["blocks"]] == [b["text"] for b in original["blocks"]]
    assert [b["originalId"] for b in ir["blocks"]] == list(blocks)
    assert len(ir["tables"]) == originals["tables"] and len(ir["figures"]) == originals["figures"]
    assert len(ir["equations"]) == originals["equations"] and len(ir["algorithms"]) == originals["rawAlgorithmBlocks"]
    objects = ir["blocks"] + ir["sections"] + ir["tables"] + ir["figures"] + ir["equations"] + ir["algorithms"] + ir["citations"] + ir["references"]
    cells = [c for t in ir["tables"] for c in t["cells"]]
    steps = [s for a in ir["algorithms"] for s in a["steps"]]
    objects += cells + steps
    assert len(cells) == originals["cells"]
    ids = {o["id"] for o in objects}
    assert len(ids) == len(objects)
    cell_ids = {c["id"] for c in cells}
    for obj in objects:
        b, loc = blocks[obj["blockId"]], obj["sourceLocator"]
        assert loc["blockId"] == loc["parentBlockId"] == b["id"] and loc["objectId"] == obj["id"]
        assert loc["rawLocator"] == b["locator"]
        for key in ("documentId", "knowledgeDocumentId", "parseId", "parseHash", "sourceHash", "parserFingerprint"):
            assert loc[key] == identity[key], key
        if obj["id"] not in cell_ids:
            assert loc["locations"] == b["locations"], "locator geometry changed"
        if "textSpan" in loc:
            value = utf16(b["text"], loc["textSpan"])
            assert value == obj.get("text", obj.get("title")), "span mismatch"
        elif "text" in obj:
            assert obj["text"] == b["text"] or obj["id"] in cell_ids
    for name, typ in (("blocks", "block"), ("tables", "table"), ("figures", "figure"), ("equations", "equation"), ("algorithms", "algorithm")):
        for obj in ir[name]:
            assert obj["id"] == oid(typ, identity["parseId"], obj["blockId"])
    for table in ir["tables"]:
        assert table["data"] == enriched[table["blockId"]]["table"]
        anchors = [(r["index"], c) for r in table["data"]["rows"] for c in r["cells"]]
        assert len(table["cells"]) == len(anchors)
        for obj, (y, c) in zip(table["cells"], anchors):
            assert obj["id"] == oid("cell", identity["parseId"], c["id"]) and obj["originalId"] == c["id"]
            assert (obj["row"], obj["column"], obj["text"]) == (y, c["column"], c["text"])
            assert obj["geometry"] == ("cell" if c["bbox"] else "unknown")
            assert obj["sourceLocator"]["locations"] == [{
                "page": table["data"]["source"]["page"], "bbox": c["bbox"],
                "coordinateOrigin": table["data"]["source"]["coordinateOrigin"] if c["bbox"] else None}]
    for equation in ir["equations"]:
        assert equation["data"] == enriched[equation["blockId"]]["equation"]
    for figure in ir["figures"]:
        assert figure["data"] == enriched[figure["blockId"]]["visual"]
    for algorithm in ir["algorithms"]:
        assert [s["text"] for s in algorithm["steps"]] == [line for line in algorithm["text"].split("\n") if line.strip()]
    relation_ids = set()
    for relation in ir["relations"]:
        assert relation["fromId"] in ids and relation["toId"] in ids and relation["fromId"] != relation["toId"]
        assert relation["id"] not in relation_ids and relation["type"] != "supports"
        relation_ids.add(relation["id"])
        loc = relation["sourceLocator"]
        assert loc["objectId"] in ids
        for key in ("documentId", "knowledgeDocumentId", "parseId", "parseHash", "sourceHash", "parserFingerprint"):
            assert loc[key] == identity[key]
        b = blocks[loc["blockId"]]
        assert loc["parentBlockId"] == b["id"] and loc["rawLocator"] == b["locator"]
        if loc["objectId"] not in cell_ids:
            assert loc["locations"] == b["locations"]
        start = str(loc["textSpan"]["start"]) if "textSpan" in loc else ""
        assert relation["id"] == oid("relation", identity["parseId"],
            f'{relation["type"]}:{relation["fromId"]}:{relation["toId"]}:{start}')
    return {"originalParserObjects": originals,
            "blockIR": {"blocks": len(block_ir), "tables": originals["tables"], "cells": originals["cells"],
                        "figures": originals["figures"], "equations": originals["equations"],
                        "standaloneSections": 0, "standaloneCitations": 0, "standaloneReferences": 0, "relations": 0},
            "paperIRv2": {key: len(ir[key]) for key in ("blocks", "sections", "tables", "figures", "equations",
                                                      "algorithms", "citations", "references", "relations")},
            "sourceObjects": source_objects, "validatedV2Locators": len(objects),
            "quality": {"CER": None, "LayoutF1": None, "ObjectRecall": None, "LocatorAccuracy": None}}


def verify(report_path, output_path, controls=False):
    report_path = Path(report_path).resolve()
    root, report = report_path.parent, read(report_path)
    allowed = Path(__file__).resolve().parent.parent / ".artifacts/scientific-rag/phase8-parser-ir-ablation-01"
    assert root.is_relative_to(allowed), "report outside authorized directory"
    protocol_path = root / "protocol.json"
    protocol = read(protocol_path)
    assert digest(protocol_path) == report["protocolHash"]
    assert protocol["repeats"] == 3 and len(protocol["rows"]) == 91 and len(protocol["nativeRows"]) == 8
    assert protocol["arms"]["A"]["fusionOff"]["status"] == "unavailable" and protocol["arms"]["A"]["fusionOff"]["entry"] is None
    assert report["A"]["status"] == "unavailable_as_paired_ablation" and not report["fullSystemBenefitEstablished"]
    assert all(protocol["quality"][key] is None for key in ("CER", "WER", "LayoutF1", "ReadingOrder", "ObjectRecall", "LocatorAccuracy"))
    assert report["scientificQuality"] == protocol["quality"]
    for pin in protocol["inputs"]:
        assert digest(pin["path"]) == pin["sha256"] and Path(pin["path"]).stat().st_mtime_ns == int(pin["mtimeNs"]), pin["path"]
        assert digest(root / pin["snapshot"]) == pin["sha256"]

    def artifact(a):
        path = (root / a["path"]).resolve()
        assert path.is_relative_to(root)
        assert digest(path) == a["sha256"] and path.stat().st_size == a.get("bytes", path.stat().st_size)
        return read(path)

    def original(pin):
        # Read original raw bytes independently of the producer's input copies.
        return read(pin["path"])

    raw_index = artifact(report["rawSource"])
    assert raw_index["protocolHash"] == report["protocolHash"] and raw_index["productionImports"] == []
    raw = {(r["sourceHash"], r["page"]): artifact(r["raw"]) for r in raw_index["rows"]}
    assert len(raw) == 4
    all_rows, totals = [], []
    test_pairs, test_native = [], []
    a_hashes, b_hashes = [], []
    elapsed = {"blockIR": [], "paperIRv2": [], "currentFusion": []}
    sizes = {"blockIR": 0, "paperIRv2": 0, "currentFusion": 0}
    native_raw_items = 0
    for repeat, trial_pin in enumerate(report["trials"]):
        trial = artifact(trial_pin)
        assert trial["repeat"] == repeat and len(trial["B"]) == 91 and len(trial["A"]) == 8
        verify_selection(protocol["rows"], trial["B"])
        total = {"selected": 91, "originalFailed": 0, "pairedConverted": 0, "blocks": 0,
                 "tables": 0, "cells": 0, "figures": 0, "equations": 0, "relations": 0,
                 "mappedCells": 0, "pageOnlyCells": 0, "validatedV2Locators": 0}
        b_hashes.append([])
        for row, observed in zip(protocol["rows"], trial["B"]):
            assert observed["ordinal"] == row["ordinal"] and observed["sourceHash"] == row["sourceHash"]
            run = original(row["run"])
            source = run["rows"][row["index"]]
            assert source == row["originalRow"]
            assert observed["status"] == row["status"] == source["status"]
            assert observed["failure"] == row["failure"] == source["failure"]
            assert list(sorted(observed["arms"])) == ["blockIR", "paperIRv2"]
            b_hashes[-1].append({name: arm["output"]["sha256"] if arm["output"] else None
                               for name, arm in observed["arms"].items()})
            if row["status"] != "parsed":
                assert observed["content"] is None and observed["preparationFailure"] is None
                for arm in observed["arms"].values():
                    assert arm["status"] == "failed" and arm["failure"] == row["failure"]
                    assert arm["output"] is None and arm["objectDenominator"] is None
                total["originalFailed"] += 1
                all_rows.append({"repeat": repeat, "ordinal": row["ordinal"], "source": row["source"],
                    "status": "original_failed", "failure": row["failure"], "objectDenominator": None,
                    "A": row["fusionDiagnosis"]})
                continue
            assert observed["preparationFailure"] is None
            assert all(arm["status"] == "converted" and arm["failure"] is None for arm in observed["arms"].values())
            content = artifact(observed["content"])
            block_ir, ir = [artifact(observed["arms"][name]["output"]) for name in ("blockIR", "paperIRv2")]
            receipt = observed["arms"]["paperIRv2"]["receipt"]
            assert ir["identity"]["parseHash"] == observed["content"]["sha256"]
            receipt_file = (root / observed["content"]["path"]).parent / receipt["path"]
            assert digest(receipt_file) == receipt["sha256"] and receipt_file.stat().st_size == receipt["size"]
            assert read(receipt_file) == ir
            scope = hashlib.sha256((row["paperId"] + "\n" + ir["identity"]["parseId"]).encode()).hexdigest()
            assert receipt["path"] == f'paper-ir/{scope}/{ir["identity"]["parseHash"]}/{receipt["sha256"]}.json'
            verified = verify_pair(row, original(row["parsed"]), original(row["structured"]), content, block_ir, ir, receipt)
            all_rows.append({"repeat": repeat, "ordinal": row["ordinal"], "source": row["source"],
                             "sourceHash": row["sourceHash"], "status": "paired_converted",
                             "A": row["fusionDiagnosis"], **verified})
            total["pairedConverted"] += 1
            for key in ("blocks", "tables", "cells", "figures", "equations", "mappedCells", "pageOnlyCells"):
                total[key] += verified["originalParserObjects"][key]
            total["relations"] += len(ir["relations"])
            total["validatedV2Locators"] += verified["validatedV2Locators"]
            for name, arm in observed["arms"].items():
                elapsed[name].append(arm["elapsedMs"])
                sizes[name] += arm["output"]["bytes"]
            if repeat == 0:
                test_pairs.append((row, original(row["parsed"]), original(row["structured"]), content, block_ir, ir, receipt))
        totals.append(total)
        a_hashes.append([])
        for row, observed in zip(protocol["nativeRows"], trial["A"]):
            assert observed["ordinal"] == row["ordinal"] and observed["sourceHash"] == row["sourceHash"] and observed["page"] == row["page"]
            verify_unavailable(observed["fusionOff"])
            page = next(p for p in original(row["structured"])["pages"] if p["page"] == row["page"])
            raw_source = raw[(row["sourceHash"], row["page"])]
            assert raw_source["sourceHash"] == row["sourceHash"]
            native_count = verify_native_source(page, raw_source)
            if repeat == 0 and row["originalTrial"] == 0:
                native_raw_items += native_count
            current = observed["current"]
            assert current["status"] == "fused" and current["failure"] is None
            inp, result = artifact(observed["input"]), artifact(current["output"])
            checked = verify_fusion(page, inp, result)
            all_rows.append({"repeat": repeat, "nativeOrdinal": row["ordinal"], "source": row["source"],
                             "sourceHash": row["sourceHash"], "page": row["page"],
                             "A": "current_only_no_pair", "observations": checked})
            a_hashes[-1].append(current["output"]["sha256"])
            elapsed["currentFusion"].append(current["elapsedMs"])
            sizes["currentFusion"] += current["output"]["bytes"]
            if repeat == 0:
                test_native.append((page, raw_source, inp, result))
    assert len(totals) == 3 and totals[0] == totals[1] == totals[2]
    assert totals[0]["originalFailed"] == 2 and totals[0]["pairedConverted"] == 89
    assert all(h == b_hashes[0] for h in b_hashes) and all(h == a_hashes[0] for h in a_hashes)
    control_results, positive_controls = [], []
    if controls:
        def reject(name, args, fn):
            args = copy.deepcopy(args)
            # Retain modified JSON and fresh hashes. Rehashing does not make
            # content satisfy independent original-source constraints.
            directory = root / "corruption-controls" / name
            directory.mkdir(parents=True, exist_ok=False)
            mutated = fn(args)
            files = [save(directory / f"input-{index}.json", value) for index, value in enumerate(args)]
            assert all(digest(f["path"]) == f["sha256"] for f in files)
            try:
                mutated()
            except (AssertionError, KeyError, ValueError, StopIteration) as error:
                control_results.append({"name": name, "status": "rejected", "exception": type(error).__name__,
                    "detail": str(error), "freshHashes": files})
            else:
                raise AssertionError(f"corruption accepted: {name}")

        base = next(pair for pair in test_pairs if pair[5]["blocks"])
        formula = next(pair for pair in test_pairs if pair[5]["equations"])
        cell = next(pair for pair in test_pairs if pair[5]["tables"] and pair[5]["tables"][0]["cells"])
        for name, pair, mutate in [
            ("fabricated-block-rehashed", base, lambda a: a[5]["blocks"][0].update(text="fabricated output")),
            ("wrong-source-hash-rehashed", base, lambda a: a[5]["identity"].update(sourceHash="0"*64)),
            ("wrong-locator-rehashed", base, lambda a: a[5]["blocks"][0]["sourceLocator"].update(rawLocator="page 999")),
            ("duplicate-object-rehashed", base, lambda a: a[5]["blocks"].append(copy.deepcopy(a[5]["blocks"][0]))),
            ("forged-cell-both-arms-rehashed", cell, lambda a: a[3]["blocks"][
                next(i for i, b in enumerate(a[3]["blocks"]) if b.get("table") and b["table"]["rows"])
                ]["table"]["rows"][0]["cells"][0].update(text="fake cell")),
            ("forged-original-formula-rehashed", formula, lambda a: a[3]["blocks"][
                next(i for i, b in enumerate(a[3]["blocks"]) if b.get("equation"))
                ]["equation"].update(rawLatex="fake latex")),
            ("omitted-table-rehashed", cell, lambda a: a[5].update(tables=[])),
        ]:
            def apply(a, mutate=mutate):
                mutate(a)
                return lambda: verify_pair(*a)
            reject(name, pair, apply)
        for name, mutate in [
            ("native-text-corruption", lambda a: a[0]["nativeTextItems"][0].update(text="fake native")),
            ("native-transform-corruption", lambda a: a[0]["nativeTextItems"][0]["transform"].__setitem__(4, 999)),
            ("ocr-alternative-corruption", lambda a: next(p for p in a[3]["provenance"]
                if len(p["alternatives"]) == 2)["alternatives"][1].update(text="fake OCR")),
        ]:
            chosen = next(t for t in test_native if any(len(p["alternatives"]) == 2 for p in t[3]["provenance"]))
            def apply(a, mutate=mutate):
                mutate(a)
                return lambda: (verify_native_source(a[0], a[1]), verify_fusion(a[0], a[2], a[3]))
            reject(name, chosen, apply)
        # Complete denominator and unavailable-arm controls exercise the same
        # explicit equality gates as the normal verifier.
        def omit_failed(a):
            a[1].pop(next(i for i, row in enumerate(a[1]) if row["status"] != "parsed"))
            return lambda: verify_selection(*a)
        reject("failed-row-omission", [protocol["rows"], protocol["rows"]], omit_failed)
        def fake_off(a):
            a[0].update(status="fused", output={"path": "invented.json", "sha256": "0"*64})
            return lambda: verify_unavailable(a[0])
        reject("invented-off-arm", [{"status": "unavailable", "reason": "production_fusion_off_switch_absent", "output": None}], fake_off)
        font_sample = next(t for t in test_native if len({i["fontName"] for i in t[0]["nativeTextItems"]}) > 1)
        def merge_groups(a):
            items = a[0]["nativeTextItems"]
            items[0]["fontName"] = next(i["fontName"] for i in items if i["fontName"] != items[0]["fontName"])
        for name, mutate in [
            ("invalid-font-handle", lambda a: a[0]["nativeTextItems"][0].update(fontName="invented-font")),
            ("split-font-group", lambda a: a[0]["nativeTextItems"][0].update(fontName="g_d999_f999")),
            ("merge-font-groups", merge_groups),
            ("changed-font-metrics", lambda a: a[0]["nativeTextItems"][0].update(ascent=999)),
        ]:
            def apply(a, mutate=mutate):
                mutate(a)
                return lambda: verify_native_source(a[0], a[1])
            reject(name, font_sample, apply)
        page, raw = copy.deepcopy(font_sample[:2])
        aliases = {name: f"g_d999_f{100 + index}" for index, name in
                   enumerate(dict.fromkeys(i["fontName"] for i in page["nativeTextItems"]))}
        for item in page["nativeTextItems"]:
            item["fontName"] = aliases[item["fontName"]]
        directory = root / "corruption-controls" / "valid-bijective-runtime-alias"
        files = [save(directory / "native-page.json", page), save(directory / "raw-source.json", raw)]
        verify_native_source(page, raw)
        positive_controls.append({"name": "valid-bijective-runtime-alias", "status": "accepted_valid_alias",
                                  "freshHashes": files})
    details = save(Path(output_path).with_suffix(".rows.json"), all_rows)
    result = {"status": "Verified passing", "scope": "B engineering pairing + A complete unavailable diagnosis/current raw-source replay",
              "reportSha256": digest(report_path), "protocolSha256": digest(protocol_path),
              "originalPinsVerified": len(protocol["inputs"]), "countsPerRepeat": totals,
              "nativeOriginalUniquePages": 4, "nativeOriginalItemsIncludingWhitespace": native_raw_items,
              "pairedA": {"status": "unavailable", "reason": "production_fusion_off_switch_absent",
                          "completePrimaryDenominator": 91, "nativeSupplementInputCaptures": 8},
              "quality": protocol["quality"], "repeatability": {"B": True, "currentA": True},
              "componentResources": {name: {"samples": len(values), "medianMs": statistics.median(values),
                  "minMs": min(values), "maxMs": max(values), "serializedBytesAllRepeats": sizes[name]}
                  for name, values in elapsed.items()},
              "rows": details, "corruptionControls": control_results, "positiveControls": positive_controls,
              "reviewLimits": ["Deterministic independent Python checks; no new model or human scientific adjudication.",
                              "Saved recognizer predictions are source observations, never scientific gold."]}
    save(output_path, result)
    print(json.dumps({key: value for key, value in result.items() if key not in ("countsPerRepeat", "componentResources", "corruptionControls")}))
    return result


if __name__ == "__main__":
    assert len(sys.argv) in (3, 4), "usage: python3 scripts/verify-scientific-parser-ir-ablation.py REPORT OUTPUT [--controls]"
    verify(sys.argv[1], sys.argv[2], controls=len(sys.argv) == 4 and sys.argv[3] == "--controls")
