"""Apply committed v3 formula regions to saved complete inference and v2 scores."""
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
CONTRACT = ROOT / "evaluation/ovis-decoder/acceptance-regions-v3.json"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    sys.path.insert(0, str(ROOT / "evaluation/ovis-evaluator"))
    from runtime import sha256
    from score_arm import CONFIG_PATH, cohort, write_json
    from score_backend_v2 import backend_gold, read_blocks, require_committed, verified_contract
    from quality_acceptance import aggregate_source, compare_quality, source_metrics

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    require_committed(CONTRACT)
    require_committed(Path(__file__))
    contract = json.loads(CONTRACT.read_text(encoding="utf-8"))
    prior = verified_contract()
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    pins = {str(p): sha256(p) for p in (CONTRACT, Path(__file__))}
    for item in [*contract["identities"].values(), *(v for arm in contract["arms"].values() for k, v in arm.items() if k != "scope")]:
        path = ROOT / item["path"]
        if sha256(path) != item["sha256"]:
            raise ValueError(f"Frozen region input changed: {path}")
        pins[str(path)] = item["sha256"]
    for path in sorted(CONFIG_PATH.parent.glob("*.py")) + sorted(CONFIG_PATH.parent.glob("*.json")):
        pins[str(path)] = sha256(path)
    regions = load_module("formula_regions", ROOT / contract["identities"]["implementation"]["path"])
    paired, full_gold = cohort(config)
    backend_pages, small_gold, pixel_evidence = backend_gold(config)
    candidate = json.loads((ROOT / contract["identities"]["candidate"]["path"]).read_text(encoding="utf-8"))
    categories = {c for f in config["extraBlockGeometry"]["families"].values() for c in f["prediction"]}
    output = args.output.resolve()
    output.mkdir(parents=True)
    write_json(output / "started.json", {"sourcePins": pins, "scope": __doc__, "automaticAdoption": False})
    reports = {}
    try:
        for name, arm in contract["arms"].items():
            inference_path, score_path, audit_path = (ROOT / arm[k]["path"] for k in ("inference", "score", "denominatorAudit"))
            inference = json.loads(inference_path.read_text(encoding="utf-8"))
            original = json.loads(score_path.read_text(encoding="utf-8"))
            audit = json.loads(audit_path.read_text(encoding="utf-8"))
            gold = full_gold if arm["scope"] == "full" else small_gold
            saved_gold = score_path.parent / "gold.json"
            if (original["status"] != "scored" or not audit["validEvaluatorGold"] or audit["errors"]
                    or original["pages"] != len(gold) or json.loads(saved_gold.read_text(encoding="utf-8")) != gold
                    or sha256(saved_gold) != original["goldSha256"]
                    or original["acceptanceSha256"] != contract["identities"]["priorAcceptance"]["sha256"]):
                raise ValueError(f"Unqualified or mismatched original score: {name}")
            pins[str(saved_gold)] = sha256(saved_gold)
            if name.startswith("candidate-"):
                scorer_path = ROOT / "scripts/research/score-ovis-candidate.py"
                diagnostic_path = inference_path.parent.parent / "diagnostic.json"
                diagnostic = json.loads(diagnostic_path.read_text(encoding="utf-8"))
                if sha256(inference_path) != diagnostic["inferenceReportSha256"]:
                    raise ValueError("Candidate completion report changed")
                load_module("candidate_scorer", scorer_path).validate_candidate(candidate, diagnostic, inference)
                pins[str(scorer_path)] = sha256(scorer_path)
                pins[str(diagnostic_path)] = sha256(diagnostic_path)
            if arm["scope"] in ("full", "backend-candidate"):
                if [p["id"] for p in inference["pages"]] != [p["id"] for p in paired["pages"]]:
                    raise ValueError("Complete frozen inference cohort required")
                for expected, actual in zip(paired["pages"], inference["pages"], strict=True):
                    if expected["sha256"] != actual["sha256"]:
                        raise ValueError("Source page changed")
                by_id = {p["id"]: p for p in inference["pages"]}
                metrics = inference["pages"] if arm["scope"] == "full" else [by_id[p["pairedPageId"]] for p in backend_pages]
                input_pages = [{"id": p["id"], "input": {"sha256": p["sha256"]}} for p in metrics]
            else:
                if [p["id"] for p in inference["pages"]] != [p["id"] for p in backend_pages]:
                    raise ValueError("Original backend cohort/order required")
                metrics, input_pages = inference["pages"], backend_pages
            rows, original_rows = [], []
            for annotation, metric, page in zip(gold, metrics, input_pages, strict=True):
                blocks, errors = read_blocks(inference_path.parent, page, metric, name == "official-mps", categories)
                errors = metric.get("errors", []) + errors
                if errors:
                    blocks = []
                raw = inference_path.parent / f"{metric['id']}.raw.txt"
                pins[str(raw)] = metric["rawSha256"]
                old_source = source_metrics(annotation, blocks, config)
                measured_gold, measured_blocks, associations = regions.measurement_regions(annotation, blocks, contract["association"])
                new_source = source_metrics(measured_gold, measured_blocks, config)
                # V3 changes formula measurement regions only. Reading order
                # keeps its original matches, coverage and pair denominator.
                new_source["order"] = old_source["order"]
                for family, value in old_source["families"].items():
                    if family not in ("formula", "all") and value != new_source["families"][family]:
                        raise ValueError(f"Unrelated region family changed: {family}")
                    if any(value[k] != new_source["families"][family][k] for k in ("gold", "predicted")):
                        raise ValueError("Region denominator changed")
                original_rows.append(old_source)
                rows.append({"id": metric["id"], "modelErrors": errors, "associations": associations, "source": new_source})
            if aggregate_source(original_rows) != original["source"]:
                raise ValueError(f"Cannot reproduce original region/order measurements: {name}")
            if sum(bool(r["modelErrors"]) for r in rows) != original["invalidPages"]:
                raise ValueError("Invalid page count differs")
            directory = output / name
            directory.mkdir()
            write_json(directory / "regions.json", rows)
            result = {**original, "source": aggregate_source([r["source"] for r in rows]),
                      "regionContractSha256": sha256(CONTRACT), "originalScoreSha256": sha256(score_path),
                      "originalV2ResultUnchanged": True, "rawCoordinatesUnchanged": True,
                      "contentAndOrderMetricsReused": True, "automaticAdoption": False}
            write_json(directory / "report.json", result)
            reports[name] = result
        comparisons = []
        for reference, candidate_name in contract["comparisons"]:
            result = {"reference": reference, "candidate": candidate_name,
                      "regionContractSha256": sha256(CONTRACT),
                      **compare_quality(reports[reference], reports[candidate_name], prior)}
            write_json(output / f"{candidate_name}-comparison.json", result)
            comparisons.append({**result, "checks": [c for c in result["checks"] if not c["passed"]]})
        if any(sha256(Path(p)) != h for p, h in pins.items()):
            raise ValueError("Source changed during region scoring")
        write_json(output / "completed.json", {"status": "scored", "sourcePins": pins,
                   "inputAssociation": pixel_evidence, "comparisons": comparisons,
                   "automaticAdoption": False, "performanceQualification": False})
        print(json.dumps(comparisons), flush=True)
    except BaseException as error:
        write_json(output / "failure.json", {"status": "failed", "error": f"{type(error).__name__}: {error}"})
        raise


if __name__ == "__main__":
    main()
