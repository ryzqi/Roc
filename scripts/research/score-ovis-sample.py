"""Score exactly twenty frozen pages; never claim full-cohort qualification.

Re-score saved BF16 and new 8-bit outputs on identical gold. The three existing
independent backend pages are a subset of these twenty, not additional inference.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import importlib.util
import json
from pathlib import Path
import signal
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
PROTOCOL = ROOT / "evaluation/ovis-decoder/sample-20-1.03.json"


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def selected_pages(candidate: dict, paired: dict, gold: list) -> list[tuple[dict, dict]]:
    """Reproduce selection without consulting model output or scores."""
    selection = candidate["selection"]
    anchors = [f"scientific-{n:03d}" for n in (1, 5, 6, 43, 157, 240, 253)]
    if (selection["sampleSize"] != 20 or selection["anchors"] != anchors
            or selection["seed"] != "ovis-sample-20-2026-11-26" or candidate["exclusions"]):
        raise ValueError("Fixed twenty-page selection changed")
    remaining = sorted((p for p in paired["pages"] if p["id"] not in anchors),
                       key=lambda p: hashlib.sha256((selection["seed"] + ":" + p["id"]).encode()).hexdigest())
    ids = set(anchors + [p["id"] for p in remaining[:13]])
    selected = [(p, g) for p, g in zip(paired["pages"], gold, strict=True) if p["id"] in ids]
    if len(selected) != 20 or candidate["pages"] != [p for p, _ in selected]:
        raise ValueError("Sample count, identity or order differs")
    return selected


def measured_source(annotation: dict, blocks: list, config: dict, regions, association: dict) -> tuple[dict, dict]:
    from quality_acceptance import source_metrics
    old = source_metrics(annotation, blocks, config)
    gold, predictions, bindings = regions.measurement_regions(annotation, blocks, association)
    new = source_metrics(gold, predictions, config)
    new["order"] = old["order"]
    for family, value in old["families"].items():
        if family not in ("formula", "all") and value != new["families"][family]:
            raise ValueError(f"Unrelated family changed: {family}")
        if any(value[k] != new["families"][family][k] for k in ("gold", "predicted")):
            raise ValueError("Region denominator changed")
    return new, bindings


def main() -> int:
    sys.path.insert(0, str(ROOT / "evaluation/ovis-evaluator"))
    from runtime import configure, sha256
    from snapshot_runtime import inventory
    from score_arm import (CONFIG_PATH, audit_official, cohort, markdown, offline, official_config,
                           run_official, summarize_text, write_json)
    from score_backend_v2 import (CONTRACT, backend_gold, read_blocks, require_committed,
                                  subset_baseline, verified_baseline, verified_contract)
    from quality_acceptance import aggregate_source, compare_quality
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
    candidate = json.loads(PROTOCOL.read_text(encoding="utf-8"))
    contract = verified_contract()
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    paired, gold = cohort(config)
    selected = selected_pages(candidate, paired, gold)
    baseline = verified_baseline(contract, args.baseline)
    paths = [PROTOCOL, Path(__file__), args.runtime_receipt, args.baseline / "denominator-audit.json"]
    paths += [Path(__file__).with_name(name) for name in (
        "audit-ovis-zero-order.py", "score-ovis-candidate.py", "ovis-formula-regions.py")]
    paths += sorted(CONFIG_PATH.parent.glob("*.py")) + sorted(CONFIG_PATH.parent.glob("*.json"))
    pins = {str(p): sha256(p) for p in paths}
    for item in candidate["identities"].values():
        path = ROOT / item["path"]
        if sha256(path) != item["sha256"]:
            raise ValueError(f"Frozen sample input changed: {path}")
        pins[str(path)] = item["sha256"]
    region_contract = json.loads((ROOT / candidate["identities"]["regionContract"]["path"]).read_text(encoding="utf-8"))
    regions = load_module("regions", "ovis-formula-regions.py")
    zero = load_module("zero", "audit-ovis-zero-order.py")
    validator = load_module("candidate_validator", "score-ovis-candidate.py")
    recorded = json.loads(args.runtime_receipt.read_text(encoding="utf-8"))
    if inventory(args.runtime) != recorded["files"]:
        raise ValueError("Official scoring runtime changed")
    source = configure(args.runtime)
    categories = {c for f in config["extraBlockGeometry"]["families"].values() for c in f["prediction"]}
    args.output.mkdir(parents=True)
    provenance = {"scope": __doc__, "protocolSha256": sha256(PROTOCOL), "sampleSize": 20,
                  "automaticAdoption": False, "fullCohortQualification": False, "performanceQualification": False,
                  "acceptanceSha256": sha256(CONTRACT), "regionContractSha256": sha256(ROOT / candidate["identities"]["regionContract"]["path"]),
                  "runtimeEntriesVerified": len(recorded["files"])}
    write_json(args.output / "started.json", {**provenance, "sourcePins": pins})

    def check_pins() -> None:
        if any(sha256(Path(p)) != digest for p, digest in pins.items()):
            raise ValueError("Scoring input changed")

    def score_arm(name: str, entries: list, report_path: Path) -> dict:
        inference = json.loads(report_path.read_text(encoding="utf-8"))
        metrics = {p["id"]: p for p in inference["pages"]}
        if len(metrics) != len(inference["pages"]):
            raise ValueError("Duplicate inference page")
        pins[str(report_path)] = sha256(report_path)
        directory = args.output / name
        directory.mkdir()
        predictions = directory / "predictions"
        predictions.mkdir()
        rows, annotations = [], []
        for page, annotation in entries:
            metric = metrics[page["id"]]
            blocks, errors = read_blocks(report_path.parent, {"id": page["id"], "input": {"sha256": page["sha256"]}}, metric, False, categories)
            errors = metric.get("errors", []) + errors
            if errors:
                blocks = []
            pins[str(report_path.parent / f"{page['id']}.raw.txt")] = metric["rawSha256"]
            filename = Path(annotation["page_info"]["image_path"]).with_suffix(".md").name
            (predictions / filename).write_text(markdown(blocks), encoding="utf-8")
            geometry, bindings = measured_source(annotation, blocks, config, regions, region_contract["association"])
            rows.append({"id": page["id"], "modelErrors": errors, "text": text_metrics(annotation, blocks, config),
                         "source": geometry, "associations": bindings})
            annotations.append(annotation)
        write_json(directory / "independent-page-metrics.json", rows)
        gold_path, cfg = directory / "gold.json", directory / "official-config.json"
        write_json(gold_path, annotations)
        write_json(cfg, official_config(gold_path, predictions, config["official"]))
        code = run_official(source, directory, cfg)
        if code:
            raise RuntimeError(f"Official scoring exited {code}: {name}")
        audit, scores = audit_official(directory, None)
        expected = subset_baseline(baseline, {Path(g["page_info"]["image_path"]).name for g in annotations})
        want_formulas, baseline_corrections = zero.canonical_formulas(expected["identities"]["display_formula"], annotations)
        got_formulas, score_corrections = zero.canonical_formulas(audit["identities"]["display_formula"], annotations)
        expected["identities"]["display_formula"] = want_formulas
        audit["identities"]["display_formula"] = got_formulas
        for metric, identities in audit["identities"].items():
            want, got = Counter(expected["identities"][metric]), Counter(identities)
            if want != got:
                audit["errors"].append({"kind": "gold-denominator-differs", "metric": metric,
                                        "missing": dict(want - got), "unexpected": dict(got - want)})
        audit.update(formulaIdentityVersion=3, validEvaluatorGold=not audit["errors"],
                     zeroOrderCorrections={"baseline": baseline_corrections, "score": score_corrections})
        write_json(directory / "denominator-audit.json", audit)
        check_pins()
        result = {**provenance, "arm": name, "status": "scored" if audit["validEvaluatorGold"] else "invalid-evaluator-or-denominator",
                  "sourcePins": dict(pins), "goldSha256": sha256(gold_path), "inferenceReportSha256": sha256(report_path),
                  "pages": len(rows), "invalidPages": sum(bool(r["modelErrors"]) for r in rows),
                  "text": summarize_text(rows), "source": aggregate_source([r["source"] for r in rows]),
                  "officialCDM": scores["display_formula"]["all"]["CDM"]["all"],
                  "officialTEDS": scores["table"]["all"]["TEDS"]["all"]}
        write_json(directory / "report.json", result)
        print(json.dumps({"arm": name, "status": result["status"], "pages": len(rows)}), flush=True)
        return result

    try:
        reference = score_arm("sample-bf16", selected, ROOT / candidate["identities"]["referenceInference"]["path"])
        diagnostic_path = args.inference / "diagnostic.json"
        deadline = time.monotonic() + 2 * 3600
        while not diagnostic_path.exists():
            if not args.wait or time.monotonic() >= deadline:
                raise TimeoutError("Twenty-page candidate is not complete")
            time.sleep(5)
        diagnostic = json.loads(diagnostic_path.read_text(encoding="utf-8"))
        report_path = args.inference / "inference/report.json"
        report = json.loads(report_path.read_text(encoding="utf-8"))
        validator.validate_candidate(candidate, diagnostic, report)
        for path, expected in ((report_path, diagnostic["inferenceReportSha256"]),
                               (args.inference / "infer-probe.py", diagnostic["probeSha256"]),
                               (args.inference / "pages.json", diagnostic["pagesManifestSha256"])):
            if sha256(path) != expected:
                raise ValueError("Candidate execution evidence changed")
            pins[str(path)] = expected
        pins[str(diagnostic_path)] = sha256(diagnostic_path)
        check_pins()
        result = score_arm("sample-8bit", selected, report_path)
        if reference["goldSha256"] != result["goldSha256"]:
            raise ValueError("Sample reference gold differs")
        comparison = {**provenance, **compare_quality(reference, result, contract)}
        write_json(args.output / "comparison.json", comparison)
        backend_pages, backend_annotations, pixel_evidence = backend_gold(config)
        by_id = {p["id"]: p for p, _ in selected}
        entries = [(by_id[p["pairedPageId"]], g) for p, g in zip(backend_pages, backend_annotations, strict=True)]
        backend = score_arm("sample-8bit-backend", entries, report_path)
        backend_reference = json.loads((ROOT / candidate["identities"]["backendReferenceScore"]["path"]).read_text(encoding="utf-8"))
        if backend["goldSha256"] != backend_reference["goldSha256"]:
            raise ValueError("Backend reference gold differs")
        backend_comparison = {**provenance, **compare_quality(backend_reference, backend, contract), "inputAssociation": pixel_evidence}
        write_json(args.output / "backend-comparison.json", backend_comparison)
        check_pins()
        passed = comparison["passed"] and backend_comparison["passed"]
        write_json(args.output / "completed.json", {**provenance, "sourcePins": pins, "status": "scored", "passed": passed})
        print(json.dumps({"passed": passed, "sampleFailed": [c for c in comparison["checks"] if not c["passed"]],
                          "backendFailed": [c for c in backend_comparison["checks"] if not c["passed"]]}), flush=True)
        return 0 if passed else 2
    except BaseException as error:
        write_json(args.output / "failure.json", {"status": "failed", "error": f"{type(error).__name__}: {error}"})
        raise


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: signal.raise_signal(signal.SIGINT))
    sys.exit(main())
