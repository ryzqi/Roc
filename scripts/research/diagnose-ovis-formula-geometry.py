"""Diagnose raw formula region errors without changing coordinates or acceptance.

Gold tag groups explain diagnostics only; no prediction is merged, repaired or
discarded and no passing decision is produced.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import statistics
import sys

ROOT = Path(__file__).resolve().parents[2]


def summarize(rows: list[dict]) -> dict:
    return {"matches": len(rows),
            "meanX": statistics.mean(r["dx"] for r in rows) if rows else None,
            "medianX": statistics.median(r["dx"] for r in rows) if rows else None,
            "meanY": statistics.mean(r["dy"] for r in rows) if rows else None,
            "meanEdges": [statistics.mean(r["edgeErrors"][i] for r in rows) for i in range(4)] if rows else None,
            "absoluteXOver1Percent": sum(abs(r["dx"]) > .01 for r in rows)}


def main() -> None:
    sys.path.insert(0, str(ROOT / "evaluation/ovis-evaluator"))
    from runtime import sha256
    from score_arm import CONFIG_PATH, cohort, strict_blocks
    from quality_metrics import family_lookup, geometry_metrics

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inference", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report_path = args.inference / "report.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    paired, gold = cohort(config)
    if (report["variant"] not in ("8bit", "original-bf16")
            or report["status"] not in ("completed", "invalid-output")
            or [p["id"] for p in report["pages"]] != [p["id"] for p in paired["pages"]]
            or report["evaluatorSha256"] != paired["inferenceScriptSha256"]
            or report["receiptSha256"] != paired["installationReceiptSha256"]):
        raise ValueError("Complete original frozen inference required")
    paths = [report_path, CONFIG_PATH, Path(__file__), ROOT / "evaluation/ovis-evaluator/quality_metrics.py",
             ROOT / "evaluation/ovis-evaluator/score_arm.py", ROOT / "evaluation/ovis-evaluator/paired-inference.json",
             ROOT / paired["sourceLockPath"]]
    pins = {str(p.resolve()): sha256(p) for p in paths}
    families = config["extraBlockGeometry"]["families"]
    lookup = family_lookup(families, "gold")
    categories = {c for f in families.values() for c in f["prediction"]}
    formulas, invalid_pages = [], []
    for source, annotation, metric in zip(paired["pages"], gold, report["pages"], strict=True):
        raw = args.inference / f"{metric['id']}.raw.txt"
        if metric["sha256"] != source["sha256"] or sha256(raw) != metric["rawSha256"]:
            raise ValueError("Frozen source/raw inference changed")
        pins[str(raw.resolve())] = metric["rawSha256"]
        if not metric["valid"]:
            invalid_pages.append({"id": metric["id"], "errors": metric["errors"], "termination": metric["termination"]})
            continue
        blocks = strict_blocks(raw.read_text(encoding="utf-8"), categories)
        width, height = annotation["page_info"]["width"], annotation["page_info"]["height"]
        for match in geometry_metrics(annotation, blocks, config)["matches"]:
            left, right = annotation["layout_dets"][match["goldIndex"]], blocks[match["predictionIndex"]]
            if lookup[left["category_type"]] != "formula":
                continue
            poly = left["poly"]
            box = [min(poly[::2]) / width, min(poly[1::2]) / height,
                   max(poly[::2]) / width, max(poly[1::2]) / height]
            prediction = [v / 1000 for v in right["bbox"]]
            edges = [b - a for a, b in zip(box, prediction, strict=True)]
            formulas.append({"page": metric["id"], "imagePath": source["imagePath"], **match,
                             "goldBox": box, "predictionBox": prediction, "edgeErrors": edges,
                             "dx": (edges[0] + edges[2]) / 2, "dy": (edges[1] + edges[3]) / 2,
                             "goldHasTag": "\\tag" in left.get("latex", ""),
                             "goldLatex": left.get("latex"), "prediction": right["content"]})
    if any(sha256(Path(p)) != h for p, h in pins.items()):
        raise ValueError("Inputs changed during diagnosis")
    result = {"scope": __doc__, "variant": report["variant"], "sourcePins": pins,
              "pages": len(report["pages"]), "invalidPages": invalid_pages,
              "summary": summarize(formulas),
              "goldWithTag": summarize([r for r in formulas if r["goldHasTag"]]),
              "goldWithoutTag": summarize([r for r in formulas if not r["goldHasTag"]]),
              "formulas": sorted(formulas, key=lambda r: -abs(r["dx"])), "automaticAdoption": False}
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    print(json.dumps({k: result[k] for k in ("variant", "summary", "goldWithTag", "goldWithoutTag")}))


if __name__ == "__main__":
    main()
