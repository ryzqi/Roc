"""V2 location/order checks; content metrics retain the frozen official scorer."""
from __future__ import annotations

import math

from quality_metrics import family_lookup, geometry_metrics


def source_metrics(page: dict, blocks: list, scoring: dict) -> dict:
    families = scoring["extraBlockGeometry"]["families"]
    gf, pf = family_lookup(families, "gold"), family_lookup(families, "prediction")
    matched = geometry_metrics(page, blocks, scoring)["matches"]
    gold = {i: b for i, b in enumerate(page["layout_dets"])
            if not b.get("ignore", False) and b["category_type"] in gf}
    result = {name: {"gold": 0, "predicted": 0, "matched": 0, "biasXSum": 0.0, "biasYSum": 0.0}
              for name in ("all", *families)}
    for b in gold.values():
        for name in ("all", gf[b["category_type"]]):
            result[name]["gold"] += 1
    for b in blocks:
        for name in ("all", pf[b["category"]]):
            result[name]["predicted"] += 1
    width, height = page["page_info"]["width"], page["page_info"]["height"]
    ordered = {i: b["order"] for i, b in gold.items()
               if type(b.get("order")) in (int, float) and math.isfinite(b["order"])}
    order_pairs = []
    for row in matched:
        g, p = gold[row["goldIndex"]], blocks[row["predictionIndex"]]
        poly, box = g["poly"], p["bbox"]
        dx = (box[0] + box[2]) / 2000 - (min(poly[::2]) + max(poly[::2])) / (2 * width)
        dy = (box[1] + box[3]) / 2000 - (min(poly[1::2]) + max(poly[1::2])) / (2 * height)
        for name in ("all", gf[g["category_type"]]):
            result[name]["matched"] += 1
            result[name]["biasXSum"] += dx
            result[name]["biasYSum"] += dy
        if row["goldIndex"] in ordered:
            order_pairs.append((ordered[row["goldIndex"]], row["predictionIndex"]))
    pairs = inversions = 0
    for i, (a, x) in enumerate(order_pairs):
        for b, y in order_pairs[i + 1:]:
            if a != b:
                pairs += 1
                inversions += (a - b) * (x - y) < 0
    return {"families": result, "order": {"gold": len(ordered), "matched": len(order_pairs),
            "pairs": pairs, "inversions": inversions}}


def aggregate_source(rows: list[dict]) -> dict:
    if not rows:
        raise ValueError("Source metrics require a nonempty fixed cohort")
    families = {}
    for family in rows[0]["families"]:
        totals = {key: sum(r["families"][family][key] for r in rows) for key in rows[0]["families"][family]}
        totals.update(recall=totals["matched"] / totals["gold"] if totals["gold"] else None,
                      precision=totals["matched"] / totals["predicted"] if totals["predicted"] else None,
                      biasX=totals["biasXSum"] / totals["matched"] if totals["matched"] else None,
                      biasY=totals["biasYSum"] / totals["matched"] if totals["matched"] else None)
        families[family] = totals
    order = {key: sum(r["order"][key] for r in rows) for key in rows[0]["order"]}
    order.update(coverage=order["matched"] / order["gold"] if order["gold"] else None,
                 inversionRate=order["inversions"] / order["pairs"] if order["pairs"] else None)
    return {"pages": len(rows), "families": families, "order": order}


def compare_quality(reference: dict, candidate: dict, contract: dict) -> dict:
    checks = []

    def bound(name, value, limit, direction):
        valid = type(value) in (int, float) and math.isfinite(value)
        passed = valid and (value <= limit if direction == "maximum" else value >= limit)
        checks.append({"name": name, "value": value, direction: limit, "passed": passed})

    def delta(a, b):
        return b - a if type(a) in (int, float) and type(b) in (int, float) else None

    for name, report in (("reference", reference), ("candidate", candidate)):
        checks.append({"name": f"{name}:valid-evaluator", "passed": report["status"] == "scored"})
    margins = contract["content"]["backendAndQuantizationMargins"]
    bound("CER delta", delta(reference["text"]["cer"], candidate["text"]["cer"]), margins["cerCandidateMinusReferenceMaximum"], "maximum")
    for key, metric in (("cdm", "officialCDM"), ("teds", "officialTEDS")):
        bound(f"{key.upper()} delta", delta(reference[metric], candidate[metric]), margins[f"{key}CandidateMinusReferenceMinimum"], "minimum")
    bound("invalid page delta", candidate["invalidPages"] - reference["invalidPages"], 0, "maximum")
    checks.append({"name": "same page denominator", "passed": reference["pages"] == candidate["pages"] and reference["pages"] > 0})
    geo = contract["geometry"]
    for family in geo["qualityFamilies"]:
        a, b = reference["source"]["families"][family], candidate["source"]["families"][family]
        checks.append({"name": f"{family}:same gold denominator", "passed": a["gold"] == b["gold"]})
        if a["gold"] == b["gold"] == a["predicted"] == b["predicted"] == 0:
            checks.append({"name": f"{family}:no applicable regions", "passed": True, "notApplicable": True})
            continue
        for metric in ("recall", "precision"):
            bound(f"{family}:{metric} delta", delta(a[metric], b[metric]), geo[f"{metric}CandidateMinusReferenceMinimum"], "minimum")
        for axis in ("X", "Y"):
            value = b[f"bias{axis}"]
            change = delta(a[f"bias{axis}"], value)
            bound(f"{family}:absolute center bias {axis}", abs(value) if value is not None else None,
                  geo["signedMeanCenterBiasAbsoluteMaximum"], "maximum")
            bound(f"{family}:center bias delta {axis}", abs(change) if change is not None else None,
                  geo["signedMeanCenterBiasCandidateMinusReferenceAbsoluteMaximum"], "maximum")
    a, b = reference["source"]["order"], candidate["source"]["order"]
    order = contract["readingOrder"]
    bound("reading order inversion delta", delta(a["inversionRate"], b["inversionRate"]), order["inversionRateCandidateMinusReferenceMaximum"], "maximum")
    bound("reading order coverage delta", delta(a["coverage"], b["coverage"]), order["coverageCandidateMinusReferenceMinimum"], "minimum")
    checks.append({"name": "same explicit-order gold denominator", "passed": a["gold"] == b["gold"]})
    return {"passed": all(row["passed"] for row in checks), "checks": checks, "automaticAdoption": False}
