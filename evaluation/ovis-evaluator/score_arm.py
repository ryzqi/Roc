"""Score a complete frozen cohort through official CDM/TEDS and independent text metrics."""
from __future__ import annotations

import argparse
from collections import Counter
import ctypes
import json
import os
from pathlib import Path
import signal
import subprocess
import sys

from quality_metrics import geometry_metrics, text_metrics
from quality_acceptance import aggregate_source, source_metrics
from runtime import configure, sha256
from snapshot_runtime import inventory

ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = Path(__file__).with_name("scoring.json")


def write_json(path: Path, value) -> None:
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, ensure_ascii=False, allow_nan=False)
        stream.write("\n")


def offline() -> None:
    library = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    check = library.sandbox_check
    check.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int)
    check.restype = ctypes.c_int
    if any(check(os.getpid(), operation, 0) != 1 for operation in (b"network-outbound", b"network-inbound")):
        raise RuntimeError("OS network-deny sandbox is required for official scoring")


def strict_blocks(raw: str, categories: set) -> list:
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError(f"Duplicate JSON key: {key}")
            result[key] = value
        return result
    def constant(value):
        raise ValueError(f"Invalid JSON constant: {value}")
    value = json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
    if not isinstance(value, list):
        raise ValueError("Document must be an array")
    for b in value:
        if not isinstance(b, dict) or set(b) != {"bbox", "category", "content"}:
            raise ValueError("Unexpected document fields")
        if not isinstance(b["category"], str) or b["category"] not in categories or not isinstance(b["content"], str):
            raise ValueError("Unexpected document category/content")
        box = b["bbox"]
        if (not isinstance(box, list) or len(box) != 4 or any(type(x) is not int or not 0 <= x < 1000 for x in box)
                or box[0] >= box[2] or box[1] >= box[3]):
            raise ValueError("Invalid bounding box")
    return value


def markdown(blocks: list) -> str:
    output = []
    for block in blocks:
        content = block["content"]
        stripped = content.strip()
        if block["category"] == "display_formula" and not (
                (stripped.startswith("$$") and stripped.endswith("$$"))
                or (stripped.startswith(r"\[") and stripped.endswith(r"\]"))):
            content = "$$\n" + content + "\n$$"
        elif block["category"] == "inline_formula" and not (
                (stripped.startswith("$") and stripped.endswith("$"))
                or (stripped.startswith(r"\(") and stripped.endswith(r"\)"))):
            content = "$" + content + "$"
        output.append(content)
    return "\n\n".join(output)


def cohort(config: dict):
    frozen = config["cohort"]
    pairs = [(CONFIG_PATH.parent / "paired-inference.json", frozen["pairedConfigurationSha256"]),
             (ROOT / frozen["selectionPath"], frozen["selectionSha256"]),
             (ROOT / "evaluation/corpora/ovis-ocr/sources.lock.json", frozen["sourceLockSha256"]),
             (ROOT / frozen["labelsPath"], frozen["labelsSha256"])]
    for path, digest in pairs:
        if sha256(path) != digest:
            raise ValueError(f"Frozen source changed: {path}")
    paired = json.loads(pairs[0][0].read_text())
    selected = json.loads(pairs[1][0].read_text())["pages"]
    labels = json.loads(pairs[-1][0].read_text())
    by_image = {p["page_info"]["image_path"]: p for p in labels}
    if len(by_image) != len(labels):
        raise ValueError("Ambiguous duplicate upstream annotation image path")
    if len(selected) != frozen["pages"] or len(paired["pages"]) != frozen["pages"]:
        raise ValueError("Incomplete frozen cohort")
    gold = []
    for selection, page in zip(selected, paired["pages"], strict=True):
        if selection["imagePath"] != page["imagePath"]:
            raise ValueError("Paired cohort order differs")
        gold.append(by_image[selection["annotationImagePath"]])
    return paired, gold


def official_config(gold_path: Path, predictions: Path, frozen: dict):
    return {"end2end_eval": {"metrics": {
        "text_block": {"metric": ["Edit_dist"]},
        "display_formula": {"metric": ["Edit_dist", "CDM"], "cdm_workers": frozen["cdmWorkers"]},
        "table": {"metric": ["TEDS", "Edit_dist"], "teds_workers": frozen["tedsWorkers"]},
        "reading_order": {"metric": ["Edit_dist"]}},
        "dataset": {"dataset_name": "end2end_dataset", "ground_truth": {"data_path": str(gold_path)},
                    "prediction": {"data_path": str(predictions)}, "match_method": frozen["matchMethod"],
                    "match_workers": frozen["matchWorkers"],
                    "quick_match_truncated_timeout_sec": frozen["quickMatchTimeoutSeconds"],
                    "match_timeout_sec": frozen["pageMatchTimeoutSeconds"],
                    "timeout_fallback_max_chunk_span": frozen["fallbackMaxChunkSpan"],
                    "timeout_fallback_order_penalty": frozen["fallbackOrderPenalty"]}}}


def row_identity(row: dict) -> str:
    return json.dumps({key: row.get(key) for key in ("img_id", "gt_idx", "gt_position", "gt_category_type")},
                      sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def gold_identities(rows: list) -> Counter:
    # quick_match may merge several gold blocks into one prediction match and
    # assign the majority category to that group. Audit each original index and
    # position, not prediction-dependent grouping or the majority category.
    result = Counter()
    for row in rows:
        indices, positions = row["gt_idx"], row["gt_position"]
        if not isinstance(indices, list) or not indices or not isinstance(positions, list):
            raise ValueError("Malformed official gold identity")
        for index, position in zip(indices, positions, strict=True):
            if type(index) is not int or index < 0:
                raise ValueError("Malformed official gold index")
            result[json.dumps({"img_id": row["img_id"], "gt_idx": index, "gt_position": position},
                              sort_keys=True, ensure_ascii=False, separators=(",", ":"))] += 1
    return result


def audit_official(output: Path, expected: Path | None):
    result = output / "result"
    identities, errors, coverage = {}, [], {}
    for metric in ("text_block", "display_formula", "table"):
        path = result / f"predictions_quick_match_{metric}_result.json"
        rows = json.loads(path.read_text())
        # Upstream retains pure insertions as gt_idx=['']. They still contribute
        # to upstream metrics, but are not gold rows or failed gold renders.
        gold_rows = [row for row in rows if row.get("gt_idx") != [""]]
        counts = gold_identities(gold_rows)
        identities[metric] = dict(sorted(counts.items()))
        coverage[metric] = {"matchedRows": len(rows), "pages": len({row["img_id"] for row in rows}),
                            "goldRows": len(gold_rows), "extraPredictionRows": len(rows) - len(gold_rows),
                            "identityCount": len(counts)}
        if metric == "display_formula":
            invalid_gold = []
            for row in gold_rows:
                path = result / "predictions_quick_match_display_formula/CDM/gt/bbox" / f"{row['img_id_cdm']}.jsonl"
                if not path.is_file() or not path.read_text().strip():
                    invalid_gold.append({"identity": row_identity(row), "goldLatex": row.get("gt_cdm", row["gt"])})
            if invalid_gold:
                errors.append({"kind": "unrenderable-gold", "samples": invalid_gold})
    metric_result = json.loads((result / "predictions_quick_match_metric_result.json").read_text())
    expected_pages = len(json.loads((output / "gold.json").read_text()))
    match_debug = metric_result.get("match_debug", {})
    if match_debug.get("page_count") != expected_pages:
        errors.append({"kind": "official-page-denominator-differs", "expected": expected_pages,
                       "observed": match_debug.get("page_count")})
    if any(match_debug.get("text_match_fallback_counts", {}).values()):
        errors.append({"kind": "official-match-timeout-fallback", "details": match_debug})
    for metric in ("display_formula", "table"):
        for name, debug in metric_result[metric].get("metric_debug", {}).items():
            if any(debug.get(key, 0) for key in ("timeout_case_count", "exception_case_count", "error_case_count")):
                errors.append({"kind": "evaluator-error", "metric": name, "details": debug})
    if expected:
        baseline = json.loads((expected / "denominator-audit.json").read_text())
        if baseline["configurationSha256"] != sha256(CONFIG_PATH):
            raise ValueError("Expected denominator was created with another scoring configuration")
        for metric, observed in identities.items():
            want, got = Counter(baseline["identities"][metric]), Counter(observed)
            if want != got:
                errors.append({"kind": "gold-denominator-differs", "metric": metric,
                               "missing": dict(want - got), "unexpected": dict(got - want)})
        if not baseline["validEvaluatorGold"]:
            errors.append({"kind": "baseline-gold-not-qualified", "details": baseline["errors"]})
    return {"configurationSha256": sha256(CONFIG_PATH), "identities": identities, "coverage": coverage,
            "validEvaluatorGold": not errors, "errors": errors, "readingOrderQualified": False}, metric_result


def run_official(source: Path, output: Path, config_path: Path) -> int:
    """Own the evaluator process group, including TeX and renderer grandchildren."""
    with (output / "official.log").open("x", encoding="utf-8") as log:
        process = subprocess.Popen(
            [sys.executable, "-B", str(source / "pdf_validation.py"), "--config", str(config_path)],
            cwd=output, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            return process.wait()
        finally:
            # Kill the owned group even if its leader exited before a child renderer.
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            if process.poll() is None:
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()


def summarize_text(rows: list[dict]) -> dict:
    fields = ("characterEdits", "wordEdits", "goldCharacters", "predictionCharacters", "goldWords", "predictionWords", "goldTextBlocks")
    totals = {field: sum(r["text"][field] for r in rows) for field in fields}
    totals.update(pages=len(rows), applicableTextPages=sum(r["text"]["goldCharacters"] > 0 for r in rows),
                  cer=totals["characterEdits"] / totals["goldCharacters"], wer=totals["wordEdits"] / totals["goldWords"],
                  macroCer=sum(r["text"]["cer"] for r in rows if r["text"]["cer"] is not None) / sum(r["text"]["cer"] is not None for r in rows),
                  macroWer=sum(r["text"]["wer"] for r in rows if r["text"]["wer"] is not None) / sum(r["text"]["wer"] is not None for r in rows))
    return totals


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--runtime-receipt", type=Path, required=True)
    parser.add_argument("--arm", choices=("gold-empty-baseline", "original-bf16", "8bit"), required=True)
    parser.add_argument("--inference", type=Path)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    offline()
    committed = subprocess.run(["git", "show", "HEAD:evaluation/ovis-evaluator/scoring.json"], cwd=ROOT,
                               capture_output=True, check=True).stdout
    if committed != CONFIG_PATH.read_bytes():
        raise ValueError("Scoring configuration must match committed HEAD")
    acceptance_path = CONFIG_PATH.with_name("acceptance-v2.json")
    acceptance_bytes = subprocess.run(["git", "show", "HEAD:evaluation/ovis-evaluator/acceptance-v2.json"],
                                      cwd=ROOT, capture_output=True, check=True).stdout
    if acceptance_bytes != acceptance_path.read_bytes():
        raise ValueError("Acceptance configuration must match committed HEAD")
    config = json.loads(CONFIG_PATH.read_text())
    paired, gold = cohort(config)
    runtime_receipt_sha = sha256(args.runtime_receipt)
    recorded = json.loads(args.runtime_receipt.read_text())
    if inventory(args.runtime.absolute()) != recorded["files"]:
        raise ValueError("Official evaluator runtime changed")
    source = configure(args.runtime)
    output = args.output.absolute()
    output.mkdir()
    predictions = output / "predictions"
    predictions.mkdir()
    source_identity = {"configurationSha256": sha256(CONFIG_PATH),
        "runtimeReceiptSha256": runtime_receipt_sha,
        "runtimeEntriesVerified": len(recorded["files"]),
        "acceptanceSha256": sha256(acceptance_path),
        "sourceMetricsSha256": sha256(Path(__file__).with_name("quality_acceptance.py")),
        "scriptSha256": sha256(Path(__file__)),
        "independentMetricsSha256": sha256(Path(__file__).with_name("quality_metrics.py")),
        "runtimeConfigurationSha256": sha256(Path(__file__).with_name("runtime.py")),
        "environmentLockSha256": sha256(Path(__file__).with_name("environment.lock.json"))}
    write_json(output / "started.json", {**source_identity,
        "arm": args.arm, "network": "denied-by-seatbelt", "performanceQualification": False})
    baseline = args.arm == "gold-empty-baseline"
    inference = None
    if not baseline:
        if not args.inference or not args.baseline:
            raise ValueError("Both complete inference and gold denominator baseline are required")
        inference = json.loads((args.inference / "report.json").read_text())
        if inference["variant"] != args.arm or inference["status"] not in ("completed", "invalid-output"):
            raise ValueError("Expected completed inference arm (invalid model pages are retained)")
        if [p["id"] for p in inference["pages"]] != [p["id"] for p in paired["pages"]]:
            raise ValueError("Full inference cohort/order is required")
        for report_key, config_key in (("revision", "modelRevision"), ("receiptSha256", "installationReceiptSha256"),
                                       ("evaluatorSha256", "inferenceScriptSha256")):
            if inference[report_key] != paired[config_key]:
                raise ValueError(f"Inference identity differs: {report_key}")
        settings = paired["settings"]
        for key in ("temperature", "maxTokens", "enableThinking", "minPixels", "maxPixels", "seed"):
            if inference["settings"][key] != settings[key]:
                raise ValueError(f"Inference setting differs: {key}")
        for key in ("promptSha256", "formattedPromptSha256", "eosTokenIds", "network"):
            if inference[key] != settings[key]:
                raise ValueError(f"Inference setting differs: {key}")
    categories = {category for value in config["extraBlockGeometry"]["families"].values() for category in value["prediction"]}
    rows = []
    for index, (page, annotation) in enumerate(zip(paired["pages"], gold, strict=True)):
        blocks, errors = [], []
        if inference:
            metric = inference["pages"][index]
            if metric["sha256"] != page["sha256"]:
                raise ValueError("Inference page bytes differ")
            raw = args.inference / f"{page['id']}.raw.txt"
            if sha256(raw) != metric["rawSha256"]:
                raise ValueError("Inference output bytes differ")
            termination = metric["termination"]
            if (metric["valid"] and termination["eosObserved"] and not termination["truncated"]
                    and termination["lastTokenId"] in settings["eosTokenIds"]):
                try:
                    blocks = strict_blocks(raw.read_text(encoding="utf-8"), categories)
                except ValueError as error:
                    errors = [f"invalid-model-document: {error}"]
            else:
                errors = metric["errors"] or ["incomplete-or-invalid-model-output"]
        name = Path(annotation["page_info"]["image_path"]).with_suffix(".md").name
        (predictions / name).write_text(markdown(blocks), encoding="utf-8")
        rows.append({"id": page["id"], "imagePath": page["imagePath"], "modelErrors": errors,
                     "text": text_metrics(annotation, blocks, config),
                     "source": source_metrics(annotation, blocks, config),
                     "geometry": geometry_metrics(annotation, blocks, config)})
    write_json(output / "independent-page-metrics.json", rows)
    totals = summarize_text(rows)
    write_json(output / "independent-summary.json", totals)
    gold_path = output / "gold.json"
    write_json(gold_path, gold)
    cfg_path = output / "official-config.json"
    write_json(cfg_path, official_config(gold_path, predictions, config["official"]))
    try:
        exit_code = run_official(source, output, cfg_path)
    except BaseException as error:
        write_json(output / "failure.json", {"kind": "official-evaluator-interrupted",
                                            "error": f"{type(error).__name__}: {error}"})
        raise
    if exit_code:
        write_json(output / "failure.json", {"kind": "official-evaluator-process-failure", "exitCode": exit_code})
        raise SystemExit(exit_code)
    audit, metrics = audit_official(output, None if baseline else args.baseline)
    write_json(output / "denominator-audit.json", audit)
    write_json(output / "report.json", {"schemaVersion": 1, "arm": args.arm,
        "status": "scored" if audit["validEvaluatorGold"] else "invalid-evaluator-or-denominator",
        **source_identity,
        "inferenceReportSha256": sha256(args.inference / "report.json") if args.inference else None,
        "goldSha256": sha256(gold_path), "pages": len(rows), "text": totals,
        "source": aggregate_source([r["source"] for r in rows]),
        "invalidPages": sum(bool(r["modelErrors"]) for r in rows),
        "officialCDM": metrics["display_formula"]["all"]["CDM"]["all"],
        "officialTEDS": metrics["table"]["all"]["TEDS"]["all"],
        "readingOrderQualified": False, "automaticAdoption": False})
    print(json.dumps({"status": "scored", "validEvaluatorGold": audit["validEvaluatorGold"], "pages": len(rows)}), flush=True)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: signal.raise_signal(signal.SIGINT))
    main()
