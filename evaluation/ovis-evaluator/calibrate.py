#!/usr/bin/env python3
"""Calibrate the unmodified upstream CDM/TEDS APIs, retaining invalid-run evidence."""
from __future__ import annotations

import argparse
import importlib.metadata
import json
import logging
import os
from pathlib import Path
import platform
import subprocess
import sys

from runtime import configure, sha256

FORMULAS = [
    {"id": "ascii-identical", "gold": r"x^2+y^2=z^2", "prediction": r"x^2+y^2=z^2", "expected": "perfect"},
    {"id": "cjk-identical", "gold": r"\text{速度}=\frac{\text{距离}}{\text{时间}}", "prediction": r"\text{速度}=\frac{\text{距离}}{\text{时间}}", "expected": "perfect"},
    {"id": "different-formula", "gold": r"x^2+y^2=z^2", "prediction": r"a-b=c", "expected": "model-failure"},
    {"id": "empty-prediction", "gold": r"x^2+y^2=z^2", "prediction": "", "expected": "model-failure"},
    {"id": "malformed-prediction", "gold": r"x^2+y^2=z^2", "prediction": r"\frac{", "expected": "model-failure"},
    {"id": "invalid-gold", "gold": "", "prediction": r"x^2+y^2=z^2", "expected": "invalid-evaluator-or-gold"},
    {"id": "unavailable-renderer", "gold": r"x^2+y^2=z^2", "prediction": r"x^2+y^2=z^2", "expected": "invalid-evaluator-or-gold"},
]
TABLE = '<html><body><table><tr><td rowspan="2">A</td><td>B</td></tr><tr><td>C</td></tr></table></body></html>'
TABLES = [
    {"id": "identical-table", "gold": TABLE, "prediction": TABLE, "expected": "perfect"},
    {"id": "changed-content", "gold": TABLE, "prediction": TABLE.replace(">B<", ">Wrong<"), "expected": "model-failure"},
    {"id": "changed-merged-cell", "gold": TABLE, "prediction": TABLE.replace('rowspan="2"', 'rowspan="1"'), "expected": "model-failure"},
    {"id": "empty-table", "gold": TABLE, "prediction": "", "expected": "model-failure"},
    {"id": "malformed-table", "gold": TABLE, "prediction": "no table here", "expected": "model-failure"},
]


def classify_cdm(metrics: dict) -> str:
    if metrics.get("cdm_eval_error") or metrics.get("gt_tokens", 0) <= 0:
        return "invalid-evaluator-or-gold"
    return "perfect" if metrics["F1_score"] == 1 and metrics.get("pred_tokens", 0) > 0 else "model-failure"


def json_write(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output.absolute()
    output.mkdir(parents=True, exist_ok=False)
    logging.basicConfig(level=logging.INFO, handlers=[logging.FileHandler(output / "scorer.log", encoding="utf-8")])
    source = configure(args.runtime)
    sys.path.insert(0, str(source))
    from src.metrics.cdm_metric import CDM
    from src.metrics.table_metric import TEDS
    from src.metrics.cdm.modules.texlive_env import describe_tex_runtime

    json_write(output / "fixtures.json", {"formulas": FORMULAS, "tables": TABLES})
    rows = []
    for repeat in [1, 2]:
        for case in FORMULAS:
            scorer = CDM(output_root=str(output / f"repeat-{repeat}" / case["id"]))
            previous = os.environ["CDM_PDFLATEX"]
            if case["id"] == "unavailable-renderer":
                os.environ["CDM_PDFLATEX"] = str(output / "intentionally-absent-pdflatex")
            try:
                metrics = scorer.evaluate(case["gold"], case["prediction"], case["id"])
            finally:
                os.environ["CDM_PDFLATEX"] = previous
            actual = classify_cdm(metrics)
            row = {"metric": "official-CDM", "repeat": repeat, "case": case["id"], "expected": case["expected"],
                   "classification": actual, "passed": actual == case["expected"], "metrics": metrics}
            rows.append(row)
            print(json.dumps(row), flush=True)
        for case in TABLES:
            score = TEDS(structure_only=False, n_jobs=1).evaluate(case["prediction"], case["gold"])
            actual = "perfect" if score == 1 else "model-failure"
            row = {"metric": "official-TEDS", "repeat": repeat, "case": case["id"], "expected": case["expected"],
                   "classification": actual, "passed": actual == case["expected"], "score": score}
            rows.append(row)
            print(json.dumps(row), flush=True)
    repeated_scores_match = all(
        (a.get("metrics"), a.get("score"), a["classification"]) == (b.get("metrics"), b.get("score"), b["classification"])
        for a, b in zip(rows[:len(rows) // 2], rows[len(rows) // 2:], strict=True))
    binaries = {}
    for name, argv in {"magick": ["magick", "-version"], "ghostscript": ["gs", "--version"]}.items():
        binaries[name] = subprocess.run(argv, check=True, capture_output=True, text=True, timeout=15).stdout.strip()
    passed = all(row["passed"] for row in rows) and repeated_scores_match
    report = {"schemaVersion": 1, "status": "calibration-passed" if passed else "calibration-failed",
              "referenceLinuxParity": "not_established", "environmentVariant": "macOS-native-TeXLive2025-IM7.1.1.47-GS10.05.1",
              "sourceCommit": source.name.removeprefix("OmniDocBench-"), "scriptSha256": sha256(Path(__file__)),
              "environmentLockSha256": sha256(Path(__file__).parent / "environment.lock.json"),
              "fixturesSha256": sha256(output / "fixtures.json"), "python": sys.version, "platform": platform.platform(),
              "tex": describe_tex_runtime(), "native": binaries,
              "pythonPackages": {d.metadata["Name"]: d.version for d in importlib.metadata.distributions()},
              "repeatedScoresMatch": repeated_scores_match, "rows": rows,
              "qualityAcceptance": "not_run", "scope": "direct official metric API calibration; full matching pipeline not yet calibrated"}
    json_write(output / "report.json", report)
    if not passed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
