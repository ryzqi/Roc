"""Independent original-recognition/located-prose readback. No production imports."""
import hashlib
import json
import re
import sys
from pathlib import Path

NUMBER = r"(?:[A-Z][.-]?)?\d+(?:[.-]\d+)*"
TAG = re.compile(r"\\tag\*?\s*\{\s*(" + NUMBER + r")\s*\}")


def read(path):
    return json.loads(Path(path).read_text())


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def units(text):
    return len(text.encode("utf-16-le")) // 2


def evidence(block, start=0, end=None):
    end = len(block["text"]) if end is None else end
    return dict(blockId=block["id"], locator=block["locator"], text=block["text"][start:end],
                textSpan=dict(start=units(block["text"][:start]), end=units(block["text"][:end])),
                locations=block["locations"])


def body(block):
    return block["kind"] == "paragraph" and block.get("reading", {}).get("role") not in (
        "page_header", "page_footer", "page_number", "caption", "equation_number") and bool(block["text"].strip())


def same_page(a, b):
    return bool({loc["page"] for loc in a["locations"]} & {loc["page"] for loc in b["locations"]})


def balanced(raw):
    braces = re.sub(r"\\[\s\S]", "", raw)
    depth = 0
    for char in braces:
        depth += 1 if char == "{" else -1 if char == "}" else 0
        if depth < 0:
            return False
    return depth == 0


def derive(blocks, regions):
    result = []
    for index, block in enumerate(blocks):
        if block["kind"] != "formula":
            continue
        raw = regions.get(block["id"], {}).get("formula")
        raw = raw if isinstance(raw, str) and raw.strip() else None
        status = "missing" if raw is None else "parsed" if balanced(raw) and "\0" not in raw else "invalid"
        normalized = raw.replace("\r\n", "\n").replace("\r", "\n").strip() if raw else None
        tags, number, proof = list(TAG.finditer(raw or "")), None, None
        if len(tags) == 1:
            tag = tags[0]
            number = tag[1]
            proof = dict(kind="latex", text=tag[0], start=units(raw[:tag.start()]), end=units(raw[:tag.end()]))
        elif not tags:
            matches = []
            for neighbor in blocks[max(0, index - 1):index + 2]:
                match = re.fullmatch(r"\s*\((" + NUMBER + r")\)\s*", neighbor["text"])
                if not match or neighbor["kind"] != "paragraph" or not same_page(block, neighbor):
                    continue
                loc = block["locations"][0]
                box = next((p["bbox"] for p in neighbor["locations"] if p["page"] == loc["page"]
                            and p["coordinateOrigin"] == loc["coordinateOrigin"]), None)
                if box and box[0] >= loc["bbox"][2] and box[1] < loc["bbox"][3] and box[3] > loc["bbox"][1]:
                    matches.append((neighbor, match[1]))
            if len(matches) == 1:
                number = matches[0][1]
                proof = dict(kind="block", evidence=evidence(matches[0][0]))
        contexts = [evidence(other) for other in blocks[max(0, index - 2):index + 3]
                    if body(other) and same_page(block, other)
                    and not re.fullmatch(r"\s*\([\dA-Z.-]+\)\s*", other["text"])]
        result.append(dict(blockId=block["id"], rawLatex=raw, normalizedLatex=normalized, status=status,
                           equationNumber=number, numberEvidence=proof, contexts=contexts))
    for eq in result:
        number = eq["equationNumber"]
        refs = []
        if number:
            ambiguity = sum(other["equationNumber"] == number for other in result) > 1
            pattern = re.compile(r"(?:\bEq(?:uation)?s?\.?|式)\s*\(?" + re.escape(number)
                                 + r"\)?(?![\dA-Za-z]|[.-]\d)", re.I)
            refs = [dict(status="candidate" if ambiguity else "linked", evidence=evidence(block, m.start(), m.end()))
                    for block in blocks if body(block) for m in pattern.finditer(block["text"])]
        eq["references"] = refs
    return result


def verify(report_path):
    report = read(report_path)
    for path, sha in report["codeHashes"].items():
        assert digest(path) == sha, path
    for pin in report["inputs"]:
        path = Path(pin["path"])
        assert digest(path) == pin["sha256"] and path.stat().st_mtime_ns == int(pin["mtimeNs"]), str(path)
    totals = dict(equations=0, parsed=0, missing=0, invalid=0, numbered=0, contexts=0,
                  references=0, variables=0, indexedEquations=0)
    trials, publications = [[], []], 0
    for ci, cohort in enumerate(report["cohorts"]):
        original = read(cohort["run"])
        assert len(original["rows"]) == cohort["rows"]
        for index, row in enumerate(original["rows"]):
            saved = [read(Path(report["root"]) / f"trial-{trial}/cohort-{ci}-row-{index}.json") for trial in range(2)]
            assert saved[0] == saved[1]
            for trial in range(2):
                trials[trial].append(saved[trial])
            assert saved[0]["status"] == row["status"] and saved[0]["failure"] == row["failure"]
            if row["status"] != "parsed":
                assert not saved[0]["equations"] and not saved[0]["indexedEquations"]
                continue
            parsed = read(Path(original["root"]) / row["result"])
            structured = read(Path(original["root"]) / row["structured"])
            blocks = {block["id"]: block for block in parsed["blocks"]}
            regions = {region["id"]: region for page in structured["pages"] for region in page["regions"]}
            expected = derive(parsed["blocks"], regions)
            assert len(expected) == len(saved[0]["equations"])
            for wanted, eq in zip(expected, saved[0]["equations"]):
                for key, value in wanted.items():
                    assert eq[key] == value, (ci, index, eq["id"], key)
                block = blocks[eq["blockId"]]
                assert eq["id"] == "equation:" + block["id"] and eq["version"] == "roc-paper-equation/1"
                assert eq["source"] == dict(block["locations"][0], locator=block["locator"])
                assert eq["imagePath"] == block["imagePath"] and eq["assetId"] is None
                for variable in eq["variables"]:
                    proof = variable["evidence"]
                    source = blocks[proof["blockId"]]
                    # Read the original UTF-16 interval, independent of recognizer/definition helpers.
                    encoded = source["text"].encode("utf-16-le")
                    quote = encoded[proof["textSpan"]["start"] * 2:proof["textSpan"]["end"] * 2].decode("utf-16-le")
                    assert proof["text"] == quote and proof["locator"] == source["locator"]
                    assert proof["locations"] == source["locations"]
                    assert variable["definition"] in quote and variable["symbol"] in quote
                    assert re.search(r"denotes|represents|is defined as|表示|代表", quote, re.I)
                    assert re.search(r"(?<![A-Za-z])" + re.escape(variable["symbol"]) + r"(?![A-Za-z])", eq["rawLatex"])
                chunks = [chunk for chunk in saved[0]["indexedEquations"] if chunk["equation"]["blockId"] == block["id"]]
                assert chunks == [dict(content=block["text"], locator=block["locator"], equation=eq)]
                totals["equations"] += 1
                totals[eq["status"]] += 1
                totals["numbered"] += eq["equationNumber"] is not None
                for key in ("contexts", "references", "variables"):
                    totals[key] += len(eq[key])
                totals["indexedEquations"] += 1
            if saved[0]["publishedEquations"] is not None:
                publications += 1
                for value in saved[0]["publishedEquations"]:
                    eq, asset = value["equation"], value["asset"]
                    prior = next(e for e in saved[0]["equations"] if e["id"] == eq["id"])
                    assert eq == dict(prior, assetId=asset["id"] if asset else None)
                    if asset:
                        pin = next(a for a in row["artifacts"] if a["path"] == eq["imagePath"])
                        assert pin["sha256"] == asset["sha256"]
    for trial in range(2):
        canonical = json.dumps(trials[trial], sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
        assert hashlib.sha256(canonical).hexdigest() == report["runs"][trial]["deterministicHash"]
    assert totals == report["counts"] and publications == 1
    return dict(status="verified", reportSha256=digest(report_path), counts=totals,
                independentlyCheckedPublications=publications, inputs=len(report["inputs"]), trials=2)


if __name__ == "__main__":
    result = verify(sys.argv[1])
    if len(sys.argv) > 2:
        with open(sys.argv[2], "x") as output:
            json.dump(result, output, indent=2)
    print(json.dumps(result))
