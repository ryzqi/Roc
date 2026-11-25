"""Apply frozen v2 margins to source-bound backend or full-cohort score reports."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from quality_acceptance import compare_quality
from score_arm import CONFIG_PATH, write_json
from score_backend_v2 import CONTRACT, verified_contract
from runtime import sha256


def compare(reference: Path, candidate: Path, scope: str) -> dict:
    contract = verified_contract()
    a, b = [json.loads(p.read_text()) for p in (reference, candidate)]
    required_pages = 3 if scope == "backend" else 347
    expected_arms = (("official-mps", {"mlx-bf16", "mlx-8bit"}) if scope == "backend"
                     else ("original-bf16", {"8bit"}))
    if a["arm"] != expected_arms[0] or b["arm"] not in expected_arms[1]:
        raise ValueError("Comparison arms do not match frozen scope")
    if any(r["pages"] != required_pages or r["acceptanceSha256"] != sha256(CONTRACT) for r in (a, b)):
        raise ValueError("Incomplete cohort or changed acceptance contract")
    if a["goldSha256"] != b["goldSha256"]:
        raise ValueError("Comparison gold bytes differ")
    for path, report in ((reference, a), (candidate, b)):
        if sha256(path.parent / "gold.json") != report["goldSha256"]:
            raise ValueError("Saved gold bytes changed")
        audit = json.loads((path.parent / "denominator-audit.json").read_text())
        if audit["configurationSha256"] != sha256(CONFIG_PATH) or not audit["validEvaluatorGold"]:
            raise ValueError("Unqualified evaluator denominator")
    return {"schemaVersion": 2, "scope": scope, "referenceArm": a["arm"], "candidateArm": b["arm"],
            "referenceReportSha256": sha256(reference), "candidateReportSha256": sha256(candidate),
            "acceptanceSha256": sha256(CONTRACT), "comparatorSha256": sha256(Path(__file__)),
            "metricsImplementationSha256": sha256(Path(__file__).with_name("quality_acceptance.py")),
            **compare_quality(a, b, contract), "performanceQualification": False}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--scope", choices=("backend", "quantization"), required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = compare(args.reference, args.candidate, args.scope)
    write_json(args.output, result)
    print(json.dumps({"passed": result["passed"], "failedChecks": [r for r in result["checks"] if not r["passed"]]}))


if __name__ == "__main__":
    main()
