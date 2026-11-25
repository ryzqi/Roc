"""Apply the frozen three-page structural/content parity contract without repairs."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from common import CONFIG_PATH, digest, write_json


def strict_document(raw: str) -> list:
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError(f"duplicate key: {key}")
            result[key] = value
        return result
    def constant(value):
        raise ValueError(f"non-JSON constant: {value}")
    value = json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
    if not isinstance(value, list):
        raise ValueError("document is not a JSON array")
    for index, block in enumerate(value):
        if not isinstance(block, dict) or set(block) != {"bbox", "category", "content"}:
            raise ValueError(f"block {index} fields differ from contract")
        if not isinstance(block["category"], str) or not isinstance(block["content"], str):
            raise ValueError(f"block {index} category/content is not a string")
        box = block["bbox"]
        if (not isinstance(box, list) or len(box) != 4
                or any(type(x) is not int or not 0 <= x < 1000 for x in box)
                or box[0] >= box[2] or box[1] >= box[3]):
            raise ValueError(f"block {index} bounding box is invalid")
    return value


def compare_blocks(reference: list, candidate: list, tolerance: int) -> dict:
    differences = []
    if len(reference) != len(candidate):
        differences.append({"field": "blockCount", "reference": len(reference), "candidate": len(candidate)})
    for index, (left, right) in enumerate(zip(reference, candidate)):
        for field in ("category", "content"):
            if left[field] != right[field]:
                differences.append({"block": index, "field": field, "reference": left[field], "candidate": right[field]})
        delta = [abs(a - b) for a, b in zip(left["bbox"], right["bbox"], strict=True)]
        if max(delta) > tolerance:
            differences.append({"block": index, "field": "bbox", "reference": left["bbox"],
                                "candidate": right["bbox"], "absoluteDifference": delta})
    return {"passed": not differences, "differences": differences,
            "referenceBlockCount": len(reference), "candidateBlockCount": len(candidate)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--backend", choices=("cpu", "mps"), default="cpu")
    args = parser.parse_args()
    config_path = CONFIG_PATH if args.backend == "cpu" else CONFIG_PATH.with_name("parity-mps.json")
    config = json.loads(config_path.read_text())
    reference_report = json.loads((args.reference / "report.json").read_text())
    candidate_report = json.loads((args.candidate / "report.json").read_text())
    expected_ids = [p["id"] for p in config["pages"]]
    if reference_report["configurationSha256"] != digest(config_path):
        raise ValueError("Reference configuration differs")
    if ([p["id"] for p in reference_report["pages"]] != expected_ids
            or [p["id"] for p in candidate_report["pages"]] != expected_ids):
        raise ValueError("Complete frozen page cohort and order are required")
    results = []
    for page, left_row, right_row in zip(config["pages"], reference_report["pages"], candidate_report["pages"], strict=True):
        row = {"id": page["id"], "passed": False}
        try:
            if not left_row["eosObserved"] or not left_row["completed"] or not right_row["valid"]:
                raise ValueError("Both outputs must have verified official EOS and complete valid output")
            if left_row["imageSha256"] != page["sha256"] or right_row["sha256"] != page["sha256"]:
                raise ValueError("Image identity differs")
            raw = []
            for directory, metric in ((args.reference, left_row), (args.candidate, right_row)):
                path = directory / f"{page['id']}.raw.txt"
                if digest(path) != metric["rawSha256"]:
                    raise ValueError("Raw output bytes changed")
                raw.append(path.read_text(encoding="utf-8"))
            row.update(compare_blocks(strict_document(raw[0]), strict_document(raw[1]),
                                      config["outputComparison"]["bboxMaximumAbsoluteDifference"]))
            row["rawBytesEqual"] = raw[0] == raw[1]
        except (ValueError, KeyError) as error:
            row["error"] = str(error)
        results.append(row)
    report = {"schemaVersion": 1, "scope": config["scope"], "configurationSha256": digest(config_path),
              "comparatorSha256": digest(Path(__file__)), "referenceReportSha256": digest(args.reference / "report.json"),
              "candidateReportSha256": digest(args.candidate / "report.json"), "pages": results,
              "status": "parity-passed" if all(r["passed"] for r in results) else "parity-failed",
              "automatic347PageQualityAcceptance": False}
    write_json(args.output, report)
    print(report["status"])


if __name__ == "__main__":
    main()
