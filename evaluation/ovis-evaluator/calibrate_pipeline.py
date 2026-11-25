#!/usr/bin/env python3
"""Exercise official parsing/matching/metric aggregation with controlled fixtures."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

from runtime import configure, sha256


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    source = configure(args.runtime)
    output = args.output.absolute()
    output.mkdir(parents=True, exist_ok=False)
    text = "A calibrated scientific measurement has a known reference value."
    formula = r"x^2+y^2=z^2"
    table = '<table><tr><td rowspan="2">A</td><td>B</td></tr><tr><td>C</td></tr></table>'
    regions = []
    for i, (category, field, content) in enumerate([("text_block", "text", text), ("equation_isolated", "latex", formula), ("table", "html", table)]):
        regions.append({"anno_id": i, "category_type": category, "order": i + 1, "ignore": False,
                        "attribute": {}, "poly": [10, 10 + 100 * i, 190, 10 + 100 * i, 190, 90 + 100 * i, 10, 90 + 100 * i], field: content})
    gold = [{"page_info": {"image_path": "fixture.jpg", "page_no": 0, "width": 200, "height": 300,
                           "page_attribute": {"data_source": "academic_literature", "language": "english", "layout": "single_column", "special_issue": ["None"], "subset": "v1.5"}},
             "layout_dets": regions, "extra": {"relation": []}}]
    gold_path = output / "gold.json"
    gold_path.write_text(json.dumps(gold, indent=2) + "\n", encoding="utf-8")
    config_template = {"end2end_eval": {"metrics": {
        "text_block": {"metric": ["Edit_dist"]}, "display_formula": {"metric": ["Edit_dist", "CDM"], "cdm_workers": 1},
        "table": {"metric": ["TEDS", "Edit_dist"], "teds_workers": 1}, "reading_order": {"metric": ["Edit_dist"]}},
        "dataset": {"dataset_name": "end2end_dataset", "ground_truth": {"data_path": str(gold_path)},
                    "match_method": "quick_match", "match_workers": 1, "quick_match_truncated_timeout_sec": 300,
                    "match_timeout_sec": 420, "timeout_fallback_max_chunk_span": 10, "timeout_fallback_order_penalty": 0.10}}}
    results = {}
    for name in ["identical", "changed", "missing"]:
        folder = output / name
        predictions = folder / "predictions"
        predictions.mkdir(parents=True)
        if name != "missing":
            prediction = text + "\n\n$$\n" + formula + "\n$$\n\n" + table + "\n"
            if name == "changed":
                prediction = prediction.replace(formula, "a-b=c").replace(">B<", ">Wrong<")
            (predictions / "fixture.md").write_text(prediction, encoding="utf-8")
        config = json.loads(json.dumps(config_template))
        config["end2end_eval"]["dataset"]["prediction"] = {"data_path": str(predictions)}
        config_path = folder / "config.json"
        config_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
        with (folder / "pipeline.log").open("x", encoding="utf-8") as log:
            subprocess.run([sys.executable, "-B", str(source / "pdf_validation.py"), "--config", str(config_path)],
                           cwd=folder, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=600)
        result_path = folder / "result/predictions_quick_match_metric_result.json"
        results[name] = json.loads(result_path.read_text(encoding="utf-8"))
        print(name, json.dumps({k: v.get("all") for k, v in results[name].items() if isinstance(v, dict) and "all" in v}), flush=True)
    expected = {"identical": (1.0, 1.0, 0.0), "changed": (0.0, 0.8, 0.0), "missing": (0.0, 0.0, 1.0)}
    checks = {}
    for name, (cdm, teds, edit) in expected.items():
        result = results[name]
        checks[name] = (result["display_formula"]["all"]["CDM"]["all"] == cdm
                        and result["table"]["all"]["TEDS"]["all"] == teds
                        and result["text_block"]["all"]["Edit_dist"]["ALL_page_avg"] == edit
                        and result["match_debug"]["page_count"] == 1)
    passed = all(checks.values())
    report = {"schemaVersion": 1, "scope": "synthetic fixtures verify evaluator behavior only; not model gold",
              "status": "cdm-teds-pipeline-calibration-passed" if passed else "pipeline-calibration-failed",
              "checks": checks, "readingOrderQualified": False,
              "readingOrderFinding": "Perfect fixture yields gold [1,2,3], prediction [1,2] and edit 1/3 because the table is omitted from predicted order. No reading-order acceptance claim.",
              "sourceCommit": source.name.removeprefix("OmniDocBench-"), "scriptSha256": sha256(Path(__file__)),
              "goldSha256": sha256(gold_path), "results": results}
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    if not passed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
