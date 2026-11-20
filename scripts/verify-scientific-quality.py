"""Independent saved source/page-area readback, without production imports."""
import hashlib
import json
import math
import re
import sys
from pathlib import Path


def read(path):
    return json.loads(Path(path).read_text())


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def union_area(boxes, width, height):
    boxes = [(max(0, a), max(0, b), min(width, c), min(height, d)) for a, b, c, d in boxes]
    boxes = [b for b in boxes if b[2] > b[0] and b[3] > b[1]]
    xs = sorted({x for b in boxes for x in (b[0], b[2])})
    total = 0
    for left, right in zip(xs, xs[1:]):
        intervals = sorted((b[1], b[3]) for b in boxes if b[0] <= left and b[2] >= right)
        length, end = 0, -math.inf
        for low, high in intervals:
            length += max(0, high - max(low, end))
            end = max(end, high)
        total += (right - left) * length
    return total


def verify(path):
    report = read(path)
    for file, sha in report["codeHashes"].items():
        assert digest(file) == sha
    for pin in report["inputs"]:
        assert digest(pin["path"]) == pin["sha256"]
        assert Path(pin["path"]).stat().st_mtime_ns == int(pin["mtimeNs"])
    trials = [read(Path(report["root"]) / f"trial-{trial}.json") for trial in range(2)]
    assert trials[0] == trials[1]
    for trial, rows in enumerate(trials):
        canonical = json.dumps(rows, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
        assert hashlib.sha256(canonical).hexdigest() == report["repeatHashes"][trial]
    for row in trials[0]:
        run = read(report["cohorts"][row["cohort"]]["run"])
        source = run["rows"][row["index"]]
        assert row["status"] == source["status"] and row["failure"] == source["failure"]
        quality = row["quality"]
        if source["status"] != "parsed":
            assert quality["status"] == "failed" and quality["failure"] == source["failure"]["code"] and not quality["pages"]
            continue
        original = read(Path(run["root"]) / source["structured"])
        assert len(quality["pages"]) == len(original["pages"])
        for page, result in zip(original["pages"], quality["pages"]):
            assert result["page"] == page["page"]
            frame = page["coordinateFrame"]
            assert frame is not None and result["pageArea"] == frame["width"] * frame["height"]
            native = page.get("nativeTextItems")
            if frame["kind"] == "image":
                assert result["nativeTextCoverage"] == 0
            elif native is None or any(item["text"].strip() and item["bbox"] is None for item in native):
                assert result["nativeTextCoverage"] is None
            else:
                boxes = [item["bbox"] for item in native if item["text"].strip() and item["bbox"]]
                expected = union_area(boxes, frame["width"], frame["height"]) / result["pageArea"]
                assert abs(result["nativeTextCoverage"] - expected) < 1e-12
            recognized = [region for region in page["regions"] if not re.search("failed|error|unsupported", region.get("status", ""), re.I)
                          and ((region.get("text") or "").strip() or (region.get("formula") or "").strip())]
            expected = union_area([region["bbox"] for region in recognized], frame["width"], frame["height"]) / result["pageArea"]
            assert abs(result["ocrCoverage"] - expected) < 1e-12
            blocks = [b for b in original["blocks"] if any(loc["page"] == page["page"] for loc in b["locations"])]
            assert result["blockCount"] == len(blocks)
            if "fusion" not in page:
                assert result["duplicatedRegionCount"] is None and result["status"] == "review"
            assert result["failure"] is None
    pages = [p for row in trials[0] for p in row["quality"]["pages"]]
    counts = dict(sources=len(trials[0]), failedSources=sum(row["status"] != "parsed" for row in trials[0]),
                  pages=len(pages), good=sum(p["status"] == "good" for p in pages), review=sum(p["status"] == "review" for p in pages),
                  nativeCoverageUnknown=sum(p["nativeTextCoverage"] is None for p in pages),
                  duplicateCountUnknown=sum(p["duplicatedRegionCount"] is None for p in pages),
                  tableWarnings=sum(p["tableWarnings"] for p in pages), formulaWarnings=sum(p["formulaWarnings"] for p in pages))
    assert counts == report["counts"]
    return dict(status="verified", reportSha256=digest(path), counts=counts, inputs=len(report["inputs"]), trials=2)


if __name__ == "__main__":
    result = verify(sys.argv[1])
    if len(sys.argv) > 2:
        with open(sys.argv[2], "x") as output:
            json.dump(result, output, indent=2)
    print(json.dumps(result))
