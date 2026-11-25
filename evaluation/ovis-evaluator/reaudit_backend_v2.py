"""Re-audit saved backend scores after correcting upstream formula index-space identity."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from runtime import sha256
from score_arm import ROOT, CONFIG_PATH, audit_official, write_json
from score_backend_v2 import ARMS, CONTRACT, backend_gold, subset_baseline, verified_baseline, verified_contract


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    contract = verified_contract()
    baseline = verified_baseline(contract, args.baseline)
    _, gold, _ = backend_gold(json.loads(CONFIG_PATH.read_text()))
    source = args.source.absolute()
    inputs = sorted(p for p in source.rglob('*') if p.is_file() and p.suffix in ('.json', '.jsonl', '.md', '.log'))
    identities = {p.relative_to(source).as_posix(): sha256(p) for p in inputs}
    output = args.output.absolute()
    output.mkdir()
    subset = output / "subset-baseline"
    subset.mkdir()
    write_json(subset / "denominator-audit.json", subset_baseline(
        baseline, {Path(p["page_info"]["image_path"]).name for p in gold}))
    for arm, key in ARMS.items():
        original = json.loads((source / arm / "report.json").read_text())
        saved_gold = json.loads((source / arm / "gold.json").read_text())
        if (original["acceptanceSha256"] != sha256(CONTRACT) or saved_gold != gold
                or original["inferenceReportSha256"] != contract["identities"][key]["sha256"]):
            raise ValueError("Saved score scope differs from frozen backend input")
        audit, metrics = audit_official(source / arm, subset)
        if (original["officialCDM"] != metrics["display_formula"]["all"]["CDM"]["all"]
                or original["officialTEDS"] != metrics["table"]["all"]["TEDS"]["all"]):
            raise ValueError("Saved official metric differs")
        directory = output / arm
        directory.mkdir()
        (directory / "gold.json").write_bytes((source / arm / "gold.json").read_bytes())
        write_json(directory / "denominator-audit.json", audit)
        report = {**original, "status": "scored" if audit["validEvaluatorGold"] else "invalid-evaluator-or-denominator",
                  "audit": {"scope": "read-only denominator correction; original metrics/output unchanged",
                            "scriptSha256": sha256(Path(__file__)),
                            "implementationSha256": sha256(Path(__file__).with_name("score_arm.py")),
                            "formulaIdentitySha256": sha256(Path(__file__).with_name("formula_identity.py")),
                            "baselineSha256": sha256(args.baseline / "denominator-audit.json"),
                            "source": str(source), "sourceFiles": identities}}
        write_json(directory / "report.json", report)
        print(json.dumps({"arm": arm, "status": report["status"], "errors": audit["errors"]}), flush=True)
    if any(sha256(source / name) != value for name, value in identities.items()):
        raise ValueError("Saved backend output changed during audit")
    write_json(output / "completed.json", {"status": "audited", "source": str(source), "sourceFiles": identities})


if __name__ == "__main__":
    main()
