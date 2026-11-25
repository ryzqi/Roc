"""Independent text and geometry diagnostics with explicit missing/extra blocks."""
from __future__ import annotations

from collections import Counter
import unicodedata

import Levenshtein
import numpy as np
from scipy.optimize import linear_sum_assignment


def normalize(value: str) -> str:
    return " ".join(unicodedata.normalize("NFC", value).split())


def family_lookup(families: dict, side: str) -> dict:
    result = {}
    for name, mapping in families.items():
        for category in mapping[side]:
            if category in result:
                raise ValueError(f"Duplicate family category: {category}")
            result[category] = name
    return result


def match_text(gold: list[dict], prediction: list[dict]) -> list[dict]:
    """Hungarian assignment with explicit deletion/insertion nodes; no dropped extras."""
    g, p = len(gold), len(prediction)
    if not g and not p:
        return []
    forbidden = sum(len(x["normalized"]) for x in gold + prediction) + 1
    cost = np.full((g + p, g + p), forbidden, dtype=np.int64)
    for i, left in enumerate(gold):
        for j, right in enumerate(prediction):
            cost[i, j] = Levenshtein.distance(left["normalized"], right["normalized"])
        cost[i, p + i] = len(left["normalized"])
    for j, right in enumerate(prediction):
        cost[g + j, j] = len(right["normalized"])
    cost[g:, p:] = 0
    rows, columns = linear_sum_assignment(cost)
    result = []
    for i, j in zip(rows.tolist(), columns.tolist(), strict=True):
        if i >= g and j >= p:
            continue
        left, right = (gold[i] if i < g else None), (prediction[j] if j < p else None)
        a, b = (left["normalized"] if left else ""), (right["normalized"] if right else "")
        result.append({"goldIndex": left["index"] if left else None,
                       "predictionIndex": right["index"] if right else None,
                       "characterEdits": Levenshtein.distance(a, b),
                       "wordEdits": Levenshtein.distance(a.split(), b.split()),
                       "goldCharacters": len(a), "predictionCharacters": len(b),
                       "goldWords": len(a.split()), "predictionWords": len(b.split()),
                       "kind": "matched" if left and right else "deletion" if left else "insertion"})
    return result


def text_metrics(gold_page: dict, blocks: list[dict], config: dict) -> dict:
    text = config["text"]
    gf, pf = family_lookup(text["families"], "gold"), family_lookup(text["families"], "prediction")
    gold, pred = [], []
    excluded, ignored = Counter(), Counter()
    for i, item in enumerate(gold_page["layout_dets"]):
        category = item["category_type"]
        if item.get("ignore", False):
            ignored[category] += 1
        elif category in gf:
            content = normalize(item.get("text", ""))
            if content:
                gold.append({"index": i, "family": gf[category], "normalized": content,
                             "order": item.get("order"), "category": category})
            else:
                excluded[f"empty:{category}"] += 1
        elif category in text["excludedNontextGoldCategories"]:
            excluded[category] += 1
        else:
            raise ValueError(f"Unspecified gold text category: {category}")
    for i, item in enumerate(blocks):
        category = item["category"]
        if category in pf:
            pred.append({"index": i, "family": pf[category], "normalized": normalize(item["content"]),
                         "category": category})
        elif category not in text["excludedNontextPredictionCategories"]:
            raise ValueError(f"Unspecified predicted text category: {category}")
    matches = []
    for family in text["families"]:
        matches.extend({"family": family, **row} for row in match_text(
            [x for x in gold if x["family"] == family], [x for x in pred if x["family"] == family]))
    fields = ("characterEdits", "wordEdits", "goldCharacters", "predictionCharacters", "goldWords", "predictionWords")
    totals = {field: sum(x[field] for x in matches) for field in fields}
    diagnostic_families = {"body", "title", "reference"}
    ordered = [x for x in gold if x["family"] in diagnostic_families and type(x["order"]) in (int, float)]
    ordered.sort(key=lambda x: (x["order"], x["index"]))
    gold_text = " ".join(x["normalized"] for x in ordered)
    prediction_text = " ".join(x["normalized"] for x in pred if x["family"] in diagnostic_families)
    return {**totals, "cer": totals["characterEdits"] / totals["goldCharacters"] if totals["goldCharacters"] else None,
            "wer": totals["wordEdits"] / totals["goldWords"] if totals["goldWords"] else None,
            "goldTextBlocks": len(gold), "predictionTextBlocks": len(pred), "matches": matches,
            "excludedGoldByCategory": dict(excluded), "ignoredGoldByCategory": dict(ignored),
            "goldWithoutOrderByCategory": dict(Counter(x["category"] for x in gold if type(x["order"]) not in (int, float))),
            "readingOrderDiagnostic": {"acceptance": False, "explicitOrderGoldBlocks": len(ordered),
                "goldCharacters": len(gold_text), "predictionCharacters": len(prediction_text),
                "characterEdits": Levenshtein.distance(gold_text, prediction_text),
                "cer": Levenshtein.distance(gold_text, prediction_text) / len(gold_text) if gold_text else None}}


def iou(left, right) -> float:
    intersection = max(0, min(left[2], right[2]) - max(left[0], right[0])) * max(
        0, min(left[3], right[3]) - max(left[1], right[1]))
    union = (left[2] - left[0]) * (left[3] - left[1]) + (right[2] - right[0]) * (right[3] - right[1]) - intersection
    return intersection / union if union > 0 else 0.0


def geometry_metrics(page: dict, blocks: list[dict], config: dict) -> dict:
    families = config["extraBlockGeometry"]["families"]
    gf, pf = family_lookup(families, "gold"), family_lookup(families, "prediction")
    width, height = page["page_info"]["width"], page["page_info"]["height"]
    gold = []
    for index, block in enumerate(page["layout_dets"]):
        if block.get("ignore", False) or block["category_type"] not in gf:
            continue
        poly = block.get("poly")
        if not isinstance(poly, list) or len(poly) < 6 or len(poly) % 2:
            raise ValueError("Cannot audit a gold region without a valid polygon")
        gold.append({"index": index, "family": gf[block["category_type"]],
                     "box": [min(poly[::2]) / width, min(poly[1::2]) / height,
                             max(poly[::2]) / width, max(poly[1::2]) / height]})
    prediction = [{"index": i, "family": pf[b["category"]], "box": [n / 1000 for n in b["bbox"]]}
                  for i, b in enumerate(blocks)]
    matches = []
    for family in families:
        g, p = [x for x in gold if x["family"] == family], [x for x in prediction if x["family"] == family]
        if not g or not p:
            continue
        scores = np.array([[iou(x["box"], y["box"]) for y in p] for x in g])
        rows, cols = linear_sum_assignment(-scores)
        matches.extend({"goldIndex": g[i]["index"], "predictionIndex": p[j]["index"], "iou": float(scores[i, j])}
                       for i, j in zip(rows.tolist(), cols.tolist(), strict=True) if scores[i, j] >= 0.5)
    found = {x["predictionIndex"] for x in matches}
    absent = [{"index": i, "category": b["category"], "bbox": b["bbox"]} for i, b in enumerate(blocks) if i not in found]
    return {"status": "geometric-unmatched-diagnostic-not-hallucination-proof", "matches": matches,
            "unmatchedPredictions": absent, "unmatchedPredictedByCategory": dict(Counter(x["category"] for x in absent)),
            "goldRegions": len(gold), "predictionRegions": len(blocks), "matchedRegions": len(matches)}
