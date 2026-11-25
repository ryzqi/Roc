"""Compare the decoder candidate's fixed three backend pages with official MPS.

Uses pages from the complete candidate run, never exploratory replacement pages.
This small, previously observed cohort is not held-out or full-cohort acceptance.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import signal
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
PROTOCOL = ROOT / "evaluation/ovis-decoder/backend-1.05.json"


def select_pages(candidate: dict, associations: list[dict], report: dict) -> list[tuple[dict, dict]]:
    """Keep original backend order and bind every selected source to the full run."""
    expected = candidate["pages"]
    actual = report["pages"]
    if (len({p["id"] for p in expected}) != len(expected)
            or [p["id"] for p in actual] != [p["id"] for p in expected]
            or len({p["pairedPageId"] for p in associations}) != len(associations)
            or len({p["id"] for p in associations}) != len(associations)):
        raise ValueError("Complete unique candidate cohort and unique backend associations required")
    by_id = {p["id"]: (p, metric) for p, metric in zip(expected, actual, strict=True)}
    selected = []
    for association in associations:
        pair = by_id.get(association["pairedPageId"])
        if pair is None:
            raise ValueError("Backend page is absent from the candidate")
        page, metric = pair
        if not page["sha256"] == metric["sha256"] == association["sourceImage"]["sha256"]:
            raise ValueError("Backend source image differs from the candidate")
        selected.append((association, metric))
    if not selected:
        raise ValueError("Empty backend cohort")
    return selected


def main() -> int:
    sys.path.insert(0, str(ROOT / "evaluation/ovis-evaluator"))
    from runtime import configure, sha256
    from snapshot_runtime import inventory
    from score_arm import (CONFIG_PATH, audit_official, markdown, offline, official_config,
                           run_official, summarize_text, write_json)
    from score_backend_v2 import (CONTRACT, backend_gold, read_blocks, require_committed,
                                  subset_baseline, verified_baseline, verified_contract)
    from quality_acceptance import aggregate_source, compare_quality, source_metrics
    from quality_metrics import text_metrics

    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("inference", "runtime", "runtime-receipt", "baseline", "output"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    parser.add_argument("--wait", action="store_true")
    args = parser.parse_args()
    for name in ("inference", "runtime", "runtime_receipt", "baseline", "output"):
        setattr(args, name, getattr(args, name).resolve())
    offline()
    require_committed(PROTOCOL)
    require_committed(Path(__file__))
    protocol = json.loads(PROTOCOL.read_text(encoding="utf-8"))
    pins = {str(p): sha256(p) for p in (PROTOCOL, Path(__file__), args.runtime_receipt,
                                      args.baseline / "denominator-audit.json")}
    for item in protocol["identities"].values():
        path = ROOT / item["path"]
        if sha256(path) != item["sha256"]:
            raise ValueError(f"Frozen backend identity changed: {path}")
        pins[str(path)] = item["sha256"]
    for path in sorted(CONFIG_PATH.parent.glob("*.py")) + sorted(CONFIG_PATH.parent.glob("*.json")):
        pins[str(path)] = sha256(path)
    contract = verified_contract()
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    candidate = json.loads((ROOT / protocol["identities"]["candidate"]["path"]).read_text(encoding="utf-8"))
    for item in candidate["identities"].values():
        path = ROOT / item["path"]
        if sha256(path) != item["sha256"]:
            raise ValueError(f"Frozen candidate identity changed: {path}")
        pins[str(path)] = item["sha256"]
    baseline = verified_baseline(contract, args.baseline)
    associations, gold, pixel_evidence = backend_gold(config)
    if [p["pairedPageId"] for p in associations] != protocol["pageIds"]:
        raise ValueError("Frozen backend cohort/order changed")
    reference_path = ROOT / protocol["identities"]["referenceScore"]["path"]
    reference = json.loads(reference_path.read_text(encoding="utf-8"))
    if (reference["status"] != "scored" or reference["arm"] != "official-mps"
            or reference["acceptanceSha256"] != sha256(CONTRACT)
            or reference["inferenceReportSha256"] != contract["identities"]["officialReport"]["sha256"]
            or reference["pages"] != len(associations)):
        raise ValueError("Qualified original official backend reference required")
    args.output.mkdir(parents=True)
    write_json(args.output / "started.json", {"sourcePins": pins, "scope": __doc__,
               "automaticAdoption": False, "performanceQualification": False})
    try:
        diagnostic_path = args.inference / "diagnostic.json"
        deadline = time.monotonic() + 12 * 3600
        while True:
            try:
                diagnostic = json.loads(diagnostic_path.read_text(encoding="utf-8"))
                break
            except (FileNotFoundError, json.JSONDecodeError):
                if not args.wait or time.monotonic() >= deadline:
                    raise
                time.sleep(10)
        inference = args.inference / "inference"
        report_path = inference / "report.json"
        report = json.loads(report_path.read_text(encoding="utf-8"))
        spec = importlib.util.spec_from_file_location("candidate_score", ROOT / protocol["identities"]["candidateScorer"]["path"])
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.validate_candidate(candidate, diagnostic, report)
        for path, expected in ((report_path, diagnostic["inferenceReportSha256"]),
                               (args.inference / "infer-probe.py", diagnostic["probeSha256"]),
                               (args.inference / "pages.json", diagnostic["pagesManifestSha256"])):
            if sha256(path) != expected:
                raise ValueError("Candidate execution evidence changed")
            pins[str(path)] = expected
        pins[str(diagnostic_path)] = sha256(diagnostic_path)
        selected = select_pages(candidate, associations, report)
        if any(sha256(Path(p)) != h for p, h in pins.items()):
            raise ValueError("Source changed while waiting")
        recorded = json.loads(args.runtime_receipt.read_text(encoding="utf-8"))
        if inventory(args.runtime) != recorded["files"]:
            raise ValueError("Official evaluator runtime changed")
        source = configure(args.runtime)
        predictions, subset = args.output / "predictions", args.output / "subset-baseline"
        predictions.mkdir()
        subset.mkdir()
        write_json(subset / "denominator-audit.json", subset_baseline(
            baseline, {Path(p["page_info"]["image_path"]).name for p in gold}))
        categories = {c for f in config["extraBlockGeometry"]["families"].values() for c in f["prediction"]}
        rows = []
        for (association, metric), annotation in zip(selected, gold, strict=True):
            raw = inference / f"{metric['id']}.raw.txt"
            # The candidate consumes the original JPEG; backend_gold proves its
            # decoded pixels equal the original independent reference PNG.
            blocks, errors = read_blocks(inference, {"id": metric["id"], "input": association["sourceImage"]},
                                         metric, False, categories)
            errors = metric["errors"] + errors
            if errors:
                blocks = []
            pins[str(raw)] = metric["rawSha256"]
            name = Path(annotation["page_info"]["image_path"]).with_suffix(".md").name
            (predictions / name).write_text(markdown(blocks), encoding="utf-8")
            rows.append({"id": association["id"], "candidatePageId": metric["id"], "modelErrors": errors,
                         "text": text_metrics(annotation, blocks, config), "source": source_metrics(annotation, blocks, config)})
        write_json(args.output / "independent-page-metrics.json", rows)
        gold_path, cfg = args.output / "gold.json", args.output / "official-config.json"
        write_json(gold_path, gold)
        if sha256(gold_path) != reference["goldSha256"]:
            raise ValueError("Backend reference gold differs")
        write_json(cfg, official_config(gold_path, predictions, config["official"]))
        code = run_official(source, args.output, cfg)
        if code:
            raise RuntimeError(f"Official scorer exited {code}")
        audit, metrics = audit_official(args.output, subset)
        write_json(args.output / "denominator-audit.json", audit)
        if any(sha256(Path(p)) != h for p, h in pins.items()):
            raise ValueError("Source changed during scoring")
        result = {"schemaVersion": 1, "arm": "8bit-repetition-1.05-backend",
                  "status": "scored" if audit["validEvaluatorGold"] else "invalid-evaluator-or-denominator",
                  "sourcePins": pins, "protocolSha256": sha256(PROTOCOL), "acceptanceSha256": sha256(CONTRACT),
                  "goldSha256": sha256(gold_path), "inferenceReportSha256": sha256(report_path),
                  "pages": len(rows), "invalidPages": sum(bool(r["modelErrors"]) for r in rows),
                  "text": summarize_text(rows), "source": aggregate_source([r["source"] for r in rows]),
                  "officialCDM": metrics["display_formula"]["all"]["CDM"]["all"],
                  "officialTEDS": metrics["table"]["all"]["TEDS"]["all"], "inputAssociation": pixel_evidence,
                  "runtimeEntriesVerified": len(recorded["files"]), "automaticAdoption": False}
        write_json(args.output / "report.json", result)
        comparison = {"protocolSha256": sha256(PROTOCOL), "candidateReportSha256": sha256(args.output / "report.json"),
                      "referenceReportSha256": sha256(reference_path), "acceptanceSha256": sha256(CONTRACT),
                      **compare_quality(reference, result, contract), "performanceQualification": False}
        write_json(args.output / "comparison.json", comparison)
        print(json.dumps({"status": result["status"], "passed": comparison["passed"],
                          "failedChecks": [c for c in comparison["checks"] if not c["passed"]]}), flush=True)
        return 0 if comparison["passed"] else 2
    except BaseException as error:
        write_json(args.output / "failure.json", {"status": "failed", "error": f"{type(error).__name__}: {error}"})
        raise


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: signal.raise_signal(signal.SIGINT))
    sys.exit(main())
