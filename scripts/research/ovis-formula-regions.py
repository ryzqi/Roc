"""Formula-and-number measurement regions; raw annotations/predictions stay intact."""
from __future__ import annotations

from copy import deepcopy


def associate(formulas: dict[int, list], numbers: dict[int, list], rule: dict) -> dict:
    """Select right-side numbers first, left-side only when none can bind right.

    A number chooses the nearest aligned formula, independently on each side of
    the comparison. Ties and multiple numbers choosing one formula stay unbound.
    """
    proposals: dict[int, list[int]] = {}
    unresolved = []
    for number_index, number in numbers.items():
        left, right = [], []
        for formula_index, formula in formulas.items():
            center = (number[1] + number[3]) / 2
            overlap = max(0, min(number[3], formula[3]) - max(number[1], formula[1]))
            if (not formula[1] <= center <= formula[3]
                    or overlap / (number[3] - number[1]) < rule["minimumNumberVerticalOverlap"]):
                continue
            if number[0] >= formula[2]:
                right.append((number[0] - formula[2], formula_index))
            elif number[2] <= formula[0]:
                left.append((formula[0] - number[2], formula_index))
        eligible = right or left
        if not eligible:
            unresolved.append({"numberIndex": number_index, "reason": "no-aligned-disjoint-formula"})
            continue
        eligible.sort()
        if len(eligible) > 1 and abs(eligible[0][0] - eligible[1][0]) <= rule["distanceTieTolerance"]:
            unresolved.append({"numberIndex": number_index, "reason": "equal-distance-formulas"})
            continue
        proposals.setdefault(eligible[0][1], []).append(number_index)
    pairs = []
    for formula_index, assigned in proposals.items():
        if len(assigned) != 1:
            unresolved.extend({"numberIndex": index, "reason": "multiple-numbers-for-formula",
                               "formulaIndex": formula_index} for index in assigned)
            continue
        index = assigned[0]
        formula, number = formulas[formula_index], numbers[index]
        pairs.append({"formulaIndex": formula_index, "numberIndex": index,
                      "formulaBox": formula[:], "numberBox": number[:],
                      "measurementBox": [min(formula[0], number[0]), min(formula[1], number[1]),
                                         max(formula[2], number[2]), max(formula[3], number[3])]})
    return {"pairs": sorted(pairs, key=lambda row: row["formulaIndex"]),
            "unboundNumbers": sorted(unresolved, key=lambda row: row["numberIndex"])}


def measurement_regions(page: dict, blocks: list[dict], rule: dict) -> tuple[dict, list, dict]:
    """Return measurement-only copies with unchanged counts/categories/order/text."""
    width, height = page["page_info"]["width"], page["page_info"]["height"]
    gold_formulas, gold_numbers = {}, {}
    for index, block in enumerate(page["layout_dets"]):
        if block.get("ignore", False):
            continue
        category = block["category_type"]
        if category not in ("equation_isolated", "equation_caption"):
            continue
        poly = block["poly"]
        box = [min(poly[::2]) / width, min(poly[1::2]) / height,
               max(poly[::2]) / width, max(poly[1::2]) / height]
        (gold_formulas if category == "equation_isolated" else gold_numbers)[index] = box
    pred_formulas = {i: [n / 1000 for n in b["bbox"]] for i, b in enumerate(blocks) if b["category"] == "display_formula"}
    pred_numbers = {i: [n / 1000 for n in b["bbox"]] for i, b in enumerate(blocks) if b["category"] == "formula_number"}
    gold_links, prediction_links = associate(gold_formulas, gold_numbers, rule), associate(pred_formulas, pred_numbers, rule)
    gold_copy, prediction_copy = deepcopy(page), deepcopy(blocks)
    for link in gold_links["pairs"]:
        left, top, right, bottom = link["measurementBox"]
        gold_copy["layout_dets"][link["formulaIndex"]]["poly"] = [
            left * width, top * height, right * width, top * height,
            right * width, bottom * height, left * width, bottom * height]
    for link in prediction_links["pairs"]:
        # Use original integer coordinates; division/multiplication rounding
        # must not change the synthetic region passed to the frozen matcher.
        body, number = (blocks[link[key]]["bbox"] for key in ("formulaIndex", "numberIndex"))
        prediction_copy[link["formulaIndex"]]["bbox"] = [min(body[0], number[0]), min(body[1], number[1]),
                                                       max(body[2], number[2]), max(body[3], number[3])]
    return gold_copy, prediction_copy, {"gold": gold_links, "prediction": prediction_links}
