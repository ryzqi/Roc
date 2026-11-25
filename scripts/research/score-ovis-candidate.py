"""Score a separately frozen decoder candidate without altering the original evaluation."""
from __future__ import annotations

import argparse
from collections import Counter
import importlib.util
import json
from pathlib import Path
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]


def validate_candidate(candidate: dict, diagnostic: dict, report: dict) -> None:
    if (diagnostic.get("status") != "finished" or diagnostic.get("exitCode") not in (0, 2)
            or report.get("status") not in ("completed", "invalid-output")
            or report.get("scope") != "diagnostic-repetition-probe" or report.get("variant") != "8bit"):
        raise ValueError("Candidate must finish the complete cohort, including invalid pages")
    if (report.get("evaluatorSha256") != candidate["identities"]["generatedInference"]["sha256"]
            or diagnostic.get("probeSha256") != report["evaluatorSha256"]
            or diagnostic.get("launcherSha256") != candidate["identities"]["launcher"]["sha256"]
            or report.get("revision") != candidate["modelRevision"]
            or report.get("receiptSha256") != candidate["installationReceiptSha256"]):
        raise ValueError("Candidate implementation/model identity differs")
    settings = candidate["settings"]
    for key in ("temperature", "maxTokens", "enableThinking", "minPixels", "maxPixels", "seed",
                "repetitionPenalty", "repetitionContextSize"):
        if report["settings"].get(key) != settings[key]:
            raise ValueError(f"Candidate decoder setting differs: {key}")
    for key in ("promptSha256", "formattedPromptSha256", "eosTokenIds", "network"):
        if report.get(key) != settings[key]:
            raise ValueError(f"Candidate prompt/runtime setting differs: {key}")
    if [p["id"] for p in report["pages"]] != [p["id"] for p in candidate["pages"]]:
        raise ValueError("Candidate page denominator/order differs")
    for expected, actual in zip(candidate["pages"], report["pages"], strict=True):
        if expected["sha256"] != actual["sha256"]:
            raise ValueError("Candidate source image changed")
    valid = sum(p["valid"] is True for p in report["pages"])
    expected_status = "completed" if valid == len(report["pages"]) else "invalid-output"
    if (report["status"] != expected_status or diagnostic.get("inferenceStatus") != expected_status
            or diagnostic.get("validPages") != valid
            or diagnostic["exitCode"] != (0 if expected_status == "completed" else 2)):
        raise ValueError("Candidate completion accounting differs")


def main() -> int:
    sys.path.insert(0, str(ROOT / "evaluation/ovis-evaluator"))
    from score_arm import (CONFIG_PATH, audit_official, cohort, markdown, offline, official_config,
                           run_official, strict_blocks, summarize_text, write_json)
    from score_backend_v2 import CONTRACT, verified_baseline, verified_contract
    from quality_metrics import geometry_metrics, text_metrics
    from quality_acceptance import aggregate_source, compare_quality, source_metrics
    from runtime import configure, sha256
    from snapshot_runtime import inventory
    spec = importlib.util.spec_from_file_location("zero_order", Path(__file__).with_name("audit-ovis-zero-order.py"))
    zero_order = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(zero_order)
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("candidate", "inference", "runtime", "runtime-receipt", "baseline", "output"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    parser.add_argument("--wait", action="store_true")
    args = parser.parse_args()
    offline()
    for key in ("candidate", "inference", "runtime", "runtime_receipt", "baseline", "output"):
        setattr(args, key, getattr(args, key).resolve())
    for path in (args.candidate, Path(__file__)):
        committed = subprocess.check_output(["git", "show", f"HEAD:{path.relative_to(ROOT).as_posix()}"], cwd=ROOT)
        if committed != path.read_bytes():
            raise ValueError(f"Candidate/scorer must be committed: {path}")
    contract = verified_contract()
    candidate = json.loads(args.candidate.read_text())
    config = json.loads(CONFIG_PATH.read_text())
    paired, gold = cohort(config)
    if (candidate["id"] != "ovis-8bit-repetition-1.05-candidate"
            or candidate["pages"] != paired["pages"] or candidate["exclusions"]):
        raise ValueError("Candidate must retain the complete frozen cohort")
    baseline = verified_baseline(contract, args.baseline)
    paths = [args.candidate, args.runtime_receipt, args.baseline / "denominator-audit.json",
             Path(__file__), Path(__file__).with_name("audit-ovis-zero-order.py")]
    paths += sorted(CONFIG_PATH.parent.glob("*.py")) + sorted(CONFIG_PATH.parent.glob("*.json"))
    for item in candidate["identities"].values():
        path = ROOT / item["path"]
        if sha256(path) != item["sha256"]:
            raise ValueError(f"Candidate frozen identity changed: {path}")
        paths.append(path)
    pins = {str(p): sha256(p) for p in paths}
    args.output.mkdir(parents=True)
    write_json(args.output / "started.json", {"candidateSha256": sha256(args.candidate), "sourcePins": pins,
               "scope": __doc__, "automaticAdoption": False, "performanceQualification": False})
    try:
        diagnostic_path = args.inference / "diagnostic.json"
        deadline = time.monotonic() + 12 * 3600
        while True:
            try:
                diagnostic = json.loads(diagnostic_path.read_text())
                break
            except (FileNotFoundError, json.JSONDecodeError):
                if not args.wait or time.monotonic() >= deadline:
                    raise
                time.sleep(10)
        inference = args.inference / "inference"
        report_path = inference / "report.json"
        report = json.loads(report_path.read_text())
        validate_candidate(candidate, diagnostic, report)
        if (sha256(report_path) != diagnostic["inferenceReportSha256"]
                or sha256(args.inference / "infer-probe.py") != diagnostic["probeSha256"]
                or sha256(args.inference / "pages.json") != diagnostic["pagesManifestSha256"]):
            raise ValueError("Candidate saved execution evidence changed")
        pins.update({str(p): sha256(p) for p in (diagnostic_path, report_path,
                    args.inference / "infer-probe.py", args.inference / "pages.json")})
        if any(sha256(Path(p)) != h for p, h in pins.items()):
            raise ValueError("Source changed while waiting")
        recorded = json.loads(args.runtime_receipt.read_text())
        if inventory(args.runtime) != recorded["files"]:
            raise ValueError("Official scoring runtime changed")
        source = configure(args.runtime)
        predictions = args.output / "predictions"
        predictions.mkdir()
        categories = {c for f in config["extraBlockGeometry"]["families"].values() for c in f["prediction"]}
        rows = []
        for metric, annotation in zip(report["pages"], gold, strict=True):
            raw = inference / f"{metric['id']}.raw.txt"
            if sha256(raw) != metric["rawSha256"]:
                raise ValueError("Candidate output bytes changed")
            pins[str(raw)] = metric["rawSha256"]
            blocks, errors = [], metric["errors"][:]
            termination = metric["termination"]
            if (metric["valid"] and termination["eosObserved"] and not termination["truncated"]
                    and termination["lastTokenId"] in candidate["settings"]["eosTokenIds"]):
                try:
                    blocks = strict_blocks(raw.read_text(), categories)
                except ValueError as error:
                    errors.append(f"invalid-model-document: {error}")
            else:
                errors = errors or ["incomplete-or-invalid-model-output"]
            if errors:
                blocks = []
            name = Path(annotation["page_info"]["image_path"]).with_suffix(".md").name
            (predictions / name).write_text(markdown(blocks))
            rows.append({"id": metric["id"], "modelErrors": errors, "text": text_metrics(annotation, blocks, config),
                         "source": source_metrics(annotation, blocks, config), "geometry": geometry_metrics(annotation, blocks, config)})
        totals = summarize_text(rows)
        write_json(args.output / "independent-page-metrics.json", rows)
        write_json(args.output / "independent-summary.json", totals)
        gold_path = args.output / "gold.json"
        write_json(gold_path, gold)
        cfg = args.output / "official-config.json"
        write_json(cfg, official_config(gold_path, predictions, config["official"]))
        code = run_official(source, args.output, cfg)
        if code:
            raise RuntimeError(f"Official scorer exited {code}")
        audit, metrics = audit_official(args.output, None)
        expected, baseline_corrections = zero_order.canonical_formulas(baseline["identities"]["display_formula"], gold)
        observed, score_corrections = zero_order.canonical_formulas(audit["identities"]["display_formula"], gold)
        audit["identities"]["display_formula"] = observed
        for name, actual in audit["identities"].items():
            want = Counter(expected if name == "display_formula" else baseline["identities"][name])
            got = Counter(actual)
            if want != got:
                audit["errors"].append({"kind": "gold-denominator-differs", "metric": name,
                                        "missing": dict(want-got), "unexpected": dict(got-want)})
        audit.update(formulaIdentityVersion=3, validEvaluatorGold=not audit["errors"],
                     zeroOrderCorrections={"baseline": baseline_corrections, "score": score_corrections})
        write_json(args.output / "denominator-audit.json", audit)
        if any(sha256(Path(p)) != h for p, h in pins.items()):
            raise ValueError("Source changed during scoring")
        result = {"schemaVersion": 1, "arm": "8bit-repetition-1.05", "candidateSha256": sha256(args.candidate),
                  "status": "scored" if audit["validEvaluatorGold"] else "invalid-evaluator-or-denominator",
                  "sourcePins": pins, "runtimeEntriesVerified": len(recorded["files"]),
                  "acceptanceSha256": sha256(CONTRACT), "goldSha256": sha256(gold_path),
                  "pages": len(rows), "invalidPages": sum(bool(r["modelErrors"]) for r in rows), "text": totals,
                  "source": aggregate_source([r["source"] for r in rows]),
                  "officialCDM": metrics["display_formula"]["all"]["CDM"]["all"],
                  "officialTEDS": metrics["table"]["all"]["TEDS"]["all"], "automaticAdoption": False}
        write_json(args.output / "report.json", result)
        reference_path = ROOT / candidate["identities"]["referenceScore"]["path"]
        reference = json.loads(reference_path.read_text())
        if reference["goldSha256"] != result["goldSha256"]:
            raise ValueError("Reference gold differs")
        comparison = {"candidateSha256": sha256(args.candidate), "candidateReportSha256": sha256(args.output / "report.json"),
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
