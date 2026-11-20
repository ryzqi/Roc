"""Independent saved-block/geometry/UTF-16/asset verifier, without production imports."""
import hashlib
import importlib.util
import json
import re
import sys
from pathlib import Path


def load_verifier(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


equations = load_verifier("verify-scientific-equations")
tables = load_verifier("verify-scientific-tables")
read, digest, evidence = equations.read, equations.digest, equations.evidence

PREFIX = re.compile(r"^(fig(?:ure)?\.?|table|tab\.?|图|表)\s*([A-Z]?\d+(?:[.-]\d+)*)(?![A-Za-z\d]|[.-]\d)", re.I)


def margin(block):
    return block.get("reading", {}).get("role") in ("page_header", "page_footer", "page_number")


def caption(block):
    if block["kind"] != "paragraph" or margin(block):
        return None
    text, label = block["text"].strip(), block.get("label", "")
    match = PREFIX.match(text)
    labelled = block.get("reading", {}).get("role") == "caption" or re.fullmatch(
        r"(?:figure|fig|table|chart)_caption|caption", label, re.I)
    if not labelled and (not match or not re.match(r"\s*[:.：)\-–—]\s*\S", text[match.end():])):
        return None
    kind = ("table" if re.match("table|tab|表", match[1], re.I) else "figure") if match else (
        "table" if re.search("table", label, re.I) else "figure" if re.search("figure|fig|chart", label, re.I) else None)
    return (kind, match[2].upper() if match else None) if kind else None


def proposals(blocks):
    caps = [(index, block, caption(block)) for index, block in enumerate(blocks) if caption(block)]
    pairs = []
    for oi, obj in enumerate(blocks):
        if obj["kind"] not in ("figure", "table"):
            continue
        for ci, cap, (kind, number) in caps:
            if kind != obj["kind"] or abs(ci - oi) > 4:
                continue
            a, b = obj["locations"][0], cap["locations"][0]
            if a["coordinateOrigin"] != "TOPLEFT" or b["coordinateOrigin"] != "TOPLEFT":
                continue
            cross = a["page"] != b["page"]
            if cross and (abs(a["page"] - b["page"]) != 1 or abs(ci - oi) > 2):
                continue
            x, y = a["bbox"], b["bbox"]
            width = min(x[2] - x[0], y[2] - y[0])
            horizontal = max(0, min(x[2], y[2]) - max(x[0], y[0])) / max(1, width)
            gap = max(0, y[1] - x[3], x[1] - y[3])
            if horizontal < .5 or not cross and gap > max(50, width * .5):
                continue
            side = y[1] >= x[3] if kind == "figure" else y[3] <= x[1]
            barrier = any(not margin(block) and block["text"].strip() and not caption(block)
                          for block in blocks[min(ci, oi) + 1:max(ci, oi)])
            strong = not cross and horizontal >= .8 and gap <= max(24, width * .15) and side and not barrier and number is not None
            pairs.append(dict(oi=oi, ci=ci, cross=cross, number=number, strong=strong))
    return pairs


def verify(report_path):
    report = read(report_path)
    for path, sha in report["codeHashes"].items():
        assert digest(path) == sha, path
    for pin in report["inputs"]:
        path = Path(pin["path"])
        assert digest(path) == pin["sha256"] and path.stat().st_mtime_ns == int(pin["mtimeNs"]), str(path)
    counts = dict(objects=0, figures=0, tables=0, captions=0, linkedCaptions=0, candidateCaptions=0,
                  crossPageCaptions=0, references=0, linkedReferences=0, indexedVisuals=0)
    trials, publications = [[], []], 0
    for co, cohort in enumerate(report["cohorts"]):
        run = read(cohort["run"])
        assert len(run["rows"]) == cohort["rows"]
        for index, row in enumerate(run["rows"]):
            saved = [read(Path(report["root"]) / f"trial-{trial}/cohort-{co}-row-{index}.json") for trial in range(2)]
            assert saved[0] == saved[1]
            for trial in range(2):
                trials[trial].append(saved[trial])
            assert saved[0]["status"] == row["status"] and saved[0]["failure"] == row["failure"]
            if row["status"] != "parsed":
                assert not saved[0]["visuals"] and not saved[0]["indexedVisuals"]
                continue
            parsed = read(Path(run["root"]) / row["result"])
            structured = read(Path(run["root"]) / row["structured"])
            regions = {region["id"]: region for page in structured["pages"] for region in page["regions"]}
            blocks, visuals = parsed["blocks"], saved[0]["visuals"]
            pairs = proposals(blocks)
            objects = [(i, block) for i, block in enumerate(blocks) if block["kind"] in ("figure", "table")]
            assert len(objects) == len(visuals)
            for (oi, block), visual in zip(objects, visuals):
                assert visual["id"] == block["kind"] + ":" + block["id"] and visual["blockId"] == block["id"]
                assert visual["source"] == dict(block["locations"][0], locator=block["locator"])
                assert visual["imagePath"] == block["imagePath"] and visual["assetId"] is None
                object_pairs = [pair for pair in pairs if pair["oi"] == oi]
                original_number = tables.derive(block, regions.get(block["id"], {}))["tableNumber"] if block["kind"] == "table" else None
                certain = [pair for pair in object_pairs if pair["strong"] and len(object_pairs) == 1
                           and sum(p["ci"] == pair["ci"] for p in pairs) == 1]
                conflict = bool(certain and original_number and original_number != certain[0]["number"])
                assert ("research_visual_number_conflict" in visual["warnings"]) == conflict
                expected_number = certain[0]["number"] if certain and not conflict else original_number
                assert visual["objectNumber"] == expected_number
                assert len(object_pairs) == len(visual["captions"])
                for pair, cap in zip(object_pairs, visual["captions"]):
                    unique = len(object_pairs) == 1 and sum(p["ci"] == pair["ci"] for p in pairs) == 1
                    linked = pair["strong"] and unique and "research_visual_number_conflict" not in visual["warnings"]
                    assert cap["status"] == ("linked" if linked else "candidate")
                    assert cap["crossPage"] == pair["cross"] and cap["number"] == pair["number"]
                    assert cap["evidence"] == evidence(blocks[pair["ci"]])
                numbers = list(dict.fromkeys([n for n in [visual["objectNumber"]] + [c["number"] for c in visual["captions"]] if n is not None]))
                refs = []
                for number in numbers:
                    unique = sum(v["kind"] == visual["kind"] and (v["objectNumber"] == number or any(
                        c["number"] == number for c in v["captions"])) for v in visuals) == 1
                    pattern = re.compile(r"(?:\b" + (r"Fig(?:ure)?s?\.?" if visual["kind"] == "figure" else r"Tables?|Tab\.?")
                                         + "|" + ("图" if visual["kind"] == "figure" else "表") + r")\s*" + re.escape(number)
                                         + r"(?![A-Za-z\d]|[.-]\d)", re.I)
                    for source in blocks:
                        if source["kind"] != "paragraph" or margin(source) or caption(source):
                            continue
                        refs.extend(dict(status="linked" if unique and visual["objectNumber"] == number else "candidate",
                                         number=number, evidence=evidence(source, match.start(), match.end()))
                                    for match in pattern.finditer(source["text"]))
                assert visual["references"] == refs
                chunks = [c for c in saved[0]["indexedVisuals"] if c["visual"]["id"] == visual["id"]]
                assert chunks == [dict(content=block["text"], locator=block["locator"], visual=visual)]
                counts["objects"] += 1
                counts[visual["kind"] + "s"] += 1
                counts["indexedVisuals"] += 1
                counts["captions"] += len(visual["captions"])
                counts["linkedCaptions"] += sum(c["status"] == "linked" for c in visual["captions"])
                counts["candidateCaptions"] += sum(c["status"] == "candidate" for c in visual["captions"])
                counts["crossPageCaptions"] += sum(c["crossPage"] for c in visual["captions"])
                counts["references"] += len(refs)
                counts["linkedReferences"] += sum(r["status"] == "linked" for r in refs)
            if saved[0]["publishedVisuals"] is not None:
                publications += 1
                for pub in saved[0]["publishedVisuals"]:
                    visual, asset = pub["visual"], pub["asset"]
                    prior = next(v for v in visuals if v["id"] == visual["id"])
                    assert visual == dict(prior, assetId=asset["id"] if asset else None)
                    if asset:
                        assert asset["sha256"] == next(a["sha256"] for a in row["artifacts"] if a["path"] == visual["imagePath"])
    for trial in range(2):
        canonical = json.dumps(trials[trial], sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
        assert hashlib.sha256(canonical).hexdigest() == report["runs"][trial]["deterministicHash"]
    assert counts == report["counts"] and publications == 1
    return dict(status="verified", reportSha256=digest(report_path), counts=counts,
                independentlyCheckedPublications=publications, inputs=len(report["inputs"]), trials=2)


if __name__ == "__main__":
    result = verify(sys.argv[1])
    if len(sys.argv) > 2:
        with open(sys.argv[2], "x") as output:
            json.dump(result, output, indent=2)
    print(json.dumps(result))
