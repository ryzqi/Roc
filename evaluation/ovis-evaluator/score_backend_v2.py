"""Score the three frozen independent backend outputs against identical upstream gold."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import signal
import subprocess

from PIL import Image

from quality_acceptance import aggregate_source, source_metrics
from quality_metrics import text_metrics
from runtime import configure, sha256
from score_arm import (CONFIG_PATH, ROOT, audit_official, cohort, markdown, offline,
                       official_config, run_official, strict_blocks, summarize_text, write_json)
from snapshot_runtime import inventory

HERE = Path(__file__).parent
CONTRACT = HERE / "acceptance-v2.json"
INPUTS = HERE / "backend-inputs-v2.json"
ARMS = {"official-mps": "officialReport", "mlx-bf16": "mlxBf16Report", "mlx-8bit": "mlx8bitReport"}


def require_committed(path: Path) -> None:
    committed = subprocess.run(["git", "show", f"HEAD:{path.relative_to(ROOT).as_posix()}"],
                               cwd=ROOT, capture_output=True, check=True).stdout
    if committed != path.read_bytes():
        raise ValueError(f"Configuration must match committed HEAD: {path}")


def verified_contract() -> dict:
    require_committed(CONTRACT)
    contract = json.loads(CONTRACT.read_text())
    for item in contract["identities"].values():
        if sha256(ROOT / item["path"]) != item["sha256"]:
            raise ValueError(f"Frozen v2 identity changed: {item['path']}")
    return contract


def backend_gold(config: dict) -> tuple[list, list, list]:
    require_committed(INPUTS)
    paired, gold = cohort(config)
    source_lock = json.loads((ROOT / paired["sourceLockPath"]).read_text())
    source_root = ROOT / source_lock["localSourceRoot"]
    by_id = {p["id"]: (p, g) for p, g in zip(paired["pages"], gold, strict=True)}
    pages = json.loads(INPUTS.read_text())["pages"]
    annotations, evidence = [], []
    for page in pages:
        for key in ("input", "p0Receipt", "sourceImage"):
            if sha256(ROOT / page[key]["path"]) != page[key]["sha256"]:
                raise ValueError(f"Backend image association changed: {page['id']}:{key}")
        receipt = json.loads((ROOT / page["p0Receipt"]["path"]).read_text())
        selected, annotation = by_id[page["pairedPageId"]]
        if (source_root / selected["imagePath"] != ROOT / page["sourceImage"]["path"]
                or selected["sha256"] != page["sourceImage"]["sha256"]
                or receipt["sourceHash"] != selected["sha256"]
                or annotation["page_info"]["image_path"] != page["annotationImagePath"]):
            raise ValueError("Backend input must retain its original frozen source/gold association")
        if not any(a["path"] == "pages/page-1.png" and a["sha256"] == page["input"]["sha256"]
                   for a in receipt["artifacts"]):
            raise ValueError("Input render is absent from original P0 receipt")
        with Image.open(ROOT / page["input"]["path"]) as rendered, Image.open(ROOT / page["sourceImage"]["path"]) as source:
            info = annotation["page_info"]
            if rendered.size != source.size or source.size != (info["width"], info["height"]):
                raise ValueError("Backend image dimensions differ from gold")
            if rendered.convert("RGB").tobytes() != source.convert("RGB").tobytes():
                raise ValueError("Backend render pixels differ from upstream source")
            evidence.append({"id": page["id"], "width": source.width, "height": source.height,
                             "decodedRgbPixelsEqual": True, "sourceImageSha256": selected["sha256"]})
        annotations.append(annotation)
    return pages, annotations, evidence


def subset_baseline(baseline: dict, images: set[str]) -> dict:
    if not baseline["validEvaluatorGold"] or baseline["configurationSha256"] != sha256(CONFIG_PATH):
        raise ValueError("Qualified unchanged full gold baseline required")
    identities = {metric: {key: count for key, count in values.items() if json.loads(key)["img_id"] in images}
                  for metric, values in baseline["identities"].items()}
    if any(not values for values in identities.values()):
        raise ValueError("Independent cohort must contain text, formula and table gold")
    if baseline.get("formulaIdentityVersion") != 2:
        raise ValueError("A v2 formula-identity gold audit is required")
    return {"configurationSha256": baseline["configurationSha256"], "validEvaluatorGold": True,
            "formulaIdentityVersion": 2,
            "errors": [], "identities": identities, "images": sorted(images)}


def verified_baseline(contract: dict, directory: Path) -> dict:
    baseline = json.loads((directory / "denominator-audit.json").read_text())
    original = json.loads((ROOT / contract["identities"]["goldBaselineAudit"]["path"]).read_text())
    if (baseline.get("formulaIdentityVersion") != 2 or not baseline["validEvaluatorGold"]
            or baseline["legacyFormulaIdentities"] != original["identities"]["display_formula"]
            or any(baseline["identities"][m] != original["identities"][m] for m in ("text_block", "table"))):
        raise ValueError("Re-audited baseline must retain every original frozen gold identity")
    return baseline


def read_blocks(directory: Path, page: dict, metric: dict, official: bool, categories: set) -> tuple[list, list]:
    raw = directory / f"{page['id']}.raw.txt"
    image_key = "imageSha256" if official else "sha256"
    if metric[image_key] != page["input"]["sha256"] or sha256(raw) != metric["rawSha256"]:
        raise ValueError("Frozen inference image/output identity differs")
    termination = metric if official else metric["termination"]
    complete = metric["completed"] if official else metric["valid"]
    if (not complete or not termination["eosObserved"] or termination["truncated"]
            or termination["lastTokenId"] not in (248044, 248046)):
        return [], ["incomplete-or-invalid-model-output"]
    try:
        return strict_blocks(raw.read_text(encoding="utf-8"), categories), []
    except ValueError as error:
        return [], [f"invalid-model-document: {error}"]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--runtime-receipt", type=Path, required=True)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    offline()
    contract = verified_contract()
    config = json.loads(CONFIG_PATH.read_text())
    pages, gold, image_evidence = backend_gold(config)
    runtime_receipt_sha = sha256(args.runtime_receipt)
    recorded = json.loads(args.runtime_receipt.read_text())
    if inventory(args.runtime.absolute()) != recorded["files"]:
        raise ValueError("Official evaluator runtime changed")
    source = configure(args.runtime)
    output = args.output.absolute()
    output.mkdir()
    source_paths = [CONTRACT, INPUTS, CONFIG_PATH, Path(__file__), HERE / "quality_acceptance.py",
                    HERE / "quality_metrics.py", HERE / "score_arm.py", HERE / "runtime.py",
                    HERE / "snapshot_runtime.py", HERE / "environment.lock.json"]
    source_paths.append(HERE / "formula_identity.py")
    identity = {p.relative_to(ROOT).as_posix(): sha256(p) for p in source_paths}
    provenance = {"sourceFiles": identity, "acceptanceSha256": sha256(CONTRACT),
                  "runtimeReceiptSha256": runtime_receipt_sha, "runtimeEntriesVerified": len(recorded["files"]),
                  "inputAssociation": image_evidence, "network": "denied-by-seatbelt",
                  "performanceQualification": False, "automaticAdoption": False}
    write_json(output / "started.json", provenance)
    baseline = verified_baseline(contract, args.baseline)
    provenance["baselineAuditSha256"] = sha256(args.baseline / "denominator-audit.json")
    subset = output / "subset-baseline"
    subset.mkdir()
    write_json(subset / "denominator-audit.json", subset_baseline(
        baseline, {Path(p["page_info"]["image_path"]).name for p in gold}))
    categories = {c for f in config["extraBlockGeometry"]["families"].values() for c in f["prediction"]}
    for arm, report_key in ARMS.items():
        report_path = ROOT / contract["identities"][report_key]["path"]
        inference = json.loads(report_path.read_text())
        if inference.get("diagnostic") is not None or inference.get("adoptionEligible") is False:
            raise ValueError("Diagnostic inference cannot serve as an acceptance arm")
        if [p["id"] for p in inference["pages"]] != [p["id"] for p in pages]:
            raise ValueError("Complete original independent cohort/order required")
        directory = output / arm
        directory.mkdir()
        predictions = directory / "predictions"
        predictions.mkdir()
        rows = []
        for page, annotation, metric in zip(pages, gold, inference["pages"], strict=True):
            blocks, errors = read_blocks(report_path.parent, page, metric, arm == "official-mps", categories)
            name = Path(annotation["page_info"]["image_path"]).with_suffix(".md").name
            (predictions / name).write_text(markdown(blocks), encoding="utf-8")
            rows.append({"id": page["id"], "modelErrors": errors, "text": text_metrics(annotation, blocks, config),
                         "source": source_metrics(annotation, blocks, config)})
        write_json(directory / "independent-page-metrics.json", rows)
        gold_path, cfg_path = directory / "gold.json", directory / "official-config.json"
        write_json(gold_path, gold)
        write_json(cfg_path, official_config(gold_path, predictions, config["official"]))
        write_json(directory / "started.json", {**provenance, "arm": arm})
        try:
            code = run_official(source, directory, cfg_path)
            if code:
                raise RuntimeError(f"Official evaluator exited {code}")
        except BaseException as error:
            write_json(directory / "failure.json", {"error": f"{type(error).__name__}: {error}"})
            raise
        audit, metrics = audit_official(directory, subset)
        write_json(directory / "denominator-audit.json", audit)
        verified_contract()
        if any(sha256(ROOT / path) != digest for path, digest in identity.items()):
            raise ValueError("Scoring source changed during execution")
        report = {**provenance, "schemaVersion": 2, "arm": arm, "pages": len(rows),
                  "status": "scored" if audit["validEvaluatorGold"] else "invalid-evaluator-or-denominator",
                  "inferenceReportSha256": sha256(report_path), "goldSha256": sha256(gold_path),
                  "text": summarize_text(rows), "source": aggregate_source([r["source"] for r in rows]),
                  "invalidPages": sum(bool(r["modelErrors"]) for r in rows),
                  "officialCDM": metrics["display_formula"]["all"]["CDM"]["all"],
                  "officialTEDS": metrics["table"]["all"]["TEDS"]["all"]}
        write_json(directory / "report.json", report)
        print(json.dumps({"arm": arm, "status": report["status"], "pages": len(rows)}), flush=True)
    write_json(output / "completed.json", {**provenance, "status": "scored", "arms": list(ARMS)})


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: signal.raise_signal(signal.SIGINT))
    main()
