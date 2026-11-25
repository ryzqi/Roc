"""Read-only formula denominator audit for upstream's order-zero truthiness bug.

Keep frozen scorer outputs and metrics intact. Only an exact, unique nonignored
annotation with numeric order zero can explain an empty formula position.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]


def canonical_formulas(identities: dict, gold: list) -> tuple[dict, list]:
    annotations = {}
    for page in gold:
        image = Path(page["page_info"]["image_path"]).name
        if image in annotations:
            raise ValueError("Ambiguous gold image")
        annotations[image] = page["layout_dets"]
    result, corrections = Counter(), []
    for key, count in identities.items():
        if type(count) is not int or count < 1:
            raise ValueError("Invalid formula multiplicity")
        identity = json.loads(key)
        if identity["gt_position"] == "":
            matches = [a for a in annotations[identity["img_id"]]
                       if a.get("category_type") == identity["gt_category_type"]
                       and not a.get("ignore", False) and isinstance(a.get("latex"), str)
                       and hashlib.sha256(a["latex"].encode()).hexdigest() == identity["exactGoldSha256"]]
            if (len(matches) == 1 and type(matches[0].get("order")) in (int, float)
                    and matches[0]["order"] == 0 and count == 1):
                identity["gt_position"] = 0
                corrections.append({"originalIdentity": key, "annotationId": matches[0].get("anno_id"),
                                    "annotationOrder": 0, "count": count})
        result[json.dumps(identity, sort_keys=True, ensure_ascii=False, separators=(",", ":"))] += count
    return dict(sorted(result.items())), corrections


def main() -> None:
    sys.path.insert(0, str(ROOT / "evaluation/ovis-evaluator"))
    from score_arm import CONFIG_PATH, audit_official, cohort, write_json
    from score_backend_v2 import CONTRACT, verified_baseline, verified_contract
    from runtime import sha256

    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source", "baseline", "output"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    args = parser.parse_args()
    source, baseline, output = (getattr(args, key).resolve() for key in ("source", "baseline", "output"))
    contract = verified_contract()
    baseline_audit = verified_baseline(contract, baseline)
    _, gold = cohort(json.loads(CONFIG_PATH.read_text()))
    paths = sorted(p for p in source.rglob("*") if p.is_file() and p.suffix in (".json", ".jsonl", ".md", ".log"))
    paths += [baseline / "denominator-audit.json", Path(__file__)]
    paths += sorted((ROOT / "evaluation/ovis-evaluator").glob("*.py"))
    paths += sorted((ROOT / "evaluation/ovis-evaluator").glob("*.json"))
    pins = {str(p): sha256(p) for p in paths}
    original = json.loads((source / "report.json").read_text())
    started = json.loads((source / "started.json").read_text())
    if (json.loads((source / "gold.json").read_text()) != gold or original["pages"] != len(gold)
            or original["goldSha256"] != sha256(source / "gold.json")
            or original["configurationSha256"] != sha256(CONFIG_PATH)
            or original["acceptanceSha256"] != sha256(CONTRACT)
            or original["arm"] not in ("original-bf16", "8bit")):
        raise ValueError("Saved score differs from frozen full-cohort contract")
    for key in ("scriptSha256", "configurationSha256", "formulaIdentitySha256", "acceptanceSha256"):
        if original[key] != started[key]:
            raise ValueError(f"Scoring source changed during run: {key}")
    audit, metrics = audit_official(source, None)
    if (original["officialCDM"] != metrics["display_formula"]["all"]["CDM"]["all"]
            or original["officialTEDS"] != metrics["table"]["all"]["TEDS"]["all"]):
        raise ValueError("Saved metric changed")
    expected, baseline_corrections = canonical_formulas(baseline_audit["identities"]["display_formula"], gold)
    observed, score_corrections = canonical_formulas(audit["identities"]["display_formula"], gold)
    audit["identities"]["display_formula"] = observed
    for metric, actual in audit["identities"].items():
        want = Counter(expected if metric == "display_formula" else baseline_audit["identities"][metric])
        got = Counter(actual)
        if want != got:
            audit["errors"].append({"kind": "gold-denominator-differs", "metric": metric,
                                    "missing": dict(want - got), "unexpected": dict(got - want)})
    audit.update(formulaIdentityVersion=3, validEvaluatorGold=not audit["errors"],
                 zeroOrderCorrections={"baseline": baseline_corrections, "score": score_corrections})
    if any(sha256(Path(path)) != digest for path, digest in pins.items()):
        raise ValueError("Saved input changed during audit")
    output.mkdir(parents=True)
    (output / "gold.json").write_bytes((source / "gold.json").read_bytes())
    write_json(output / "denominator-audit.json", audit)
    report = {**original, "status": "scored" if audit["validEvaluatorGold"] else "invalid-evaluator-or-denominator",
              "audit": {"scope": __doc__, "source": str(source), "sourceFiles": pins,
                        "metricsUnchanged": True, "automaticAdoption": False}}
    write_json(output / "report.json", report)
    print(json.dumps({"status": report["status"], "corrections": audit["zeroOrderCorrections"], "errors": audit["errors"]}))


if __name__ == "__main__":
    main()
