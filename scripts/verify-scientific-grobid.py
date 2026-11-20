"""Read saved upstream TEI with an independent XML implementation; no inference."""
import hashlib
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()


def tag(node):
    return node.tag.rsplit("}", 1)[-1]


def find(node, name):
    return next((n for n in node.iter() if tag(n) == name), None) if node is not None else None


def direct(node, name):
    return [n for n in node if tag(n) == name] if node is not None else []


def text(node):
    return "".join(node.itertext()) if node is not None else ""


def clean(node):
    return re.sub(r"\s+", " ", text(node)).strip() or None


def fields(root):
    # This source cohort has no coordinate frames; do not infer raster coordinates.
    assert find(root, "surface") is None

    def loc(n):
        raw = n.get("coords")
        return dict(raw=raw, status="missing" if raw is None else "invalid",
                    coordinateSystem="grobid-pdf-point-top-left", boxes=[])

    header = next(iter(direct(root, "teiHeader")), None)
    bibl = find(find(header, "sourceDesc"), "biblStruct")
    analytic = next(iter(direct(bibl, "analytic")), None)
    titles = [n for n in analytic.iter() if tag(n) == "title"] if analytic is not None else []
    title = next((n for n in titles if n.get("level") == "a"), titles[0] if titles else None)
    if title is None:
        title = next(iter(direct(find(header, "titleStmt"), "title")), None)
    authors = []
    if analytic is not None:
        for author in (n for n in analytic.iter() if tag(n) == "author"):
            person = find(author, "persName")
            if person is not None:
                value = " ".join(filter(None, (clean(n) for n in person)))
                if value:
                    authors.append(value)
    doi = next((n for n in bibl.iter() if tag(n) == "idno" and n.get("type", "").lower() == "doi"), None) if bibl is not None else None
    date = next((n for n in bibl.iter() if tag(n) == "date" and n.get("when")), None) if bibl is not None else None
    result = dict(metadata=dict(title=clean(title), authors=authors, doi=clean(doi),
                                year=date.get("when") if date is not None else None),
                  sections=[], references=[], citationMarkers=[])
    identities = set()

    def identity(n, fallback):
        value = n.get("{http://www.w3.org/XML/1998/namespace}id", fallback)
        assert value not in identities
        identities.add(value)
        return value

    tei_text = next(iter(direct(root, "text")), None)
    body = find(tei_text, "body")

    def sections(node, parent):
        head = next(iter(direct(node, "head")), None)
        nested_parent = parent
        if head is not None and clean(head):
            value = identity(head, f"section:{len(result['sections'])}")
            result["sections"].append(dict(id=value, parentId=parent, title=clean(head),
                                           number=head.get("n"), location=loc(head)))
            nested_parent = value
        for div in direct(node, "div"):
            sections(div, nested_parent)

    if body is not None:
        sections(body, None)
    back = find(tei_text, "back")
    if back is not None:
        for n in (n for n in back.iter() if tag(n) == "biblStruct"):
            raw = next((c for c in n.iter() if tag(c) == "note" and c.get("type") == "raw_reference"), None)
            doi = next((c for c in n.iter() if tag(c) == "idno" and c.get("type", "").lower() == "doi"), None)
            result["references"].append(dict(id=identity(n, f"reference:{len(result['references'])}"),
                                              title=clean(find(n, "title")), rawCitation=clean(raw),
                                              doi=clean(doi), location=loc(n)))
    references = {r["id"] for r in result["references"]}
    # ElementTree retains mixed content as text/tail; offsets are original UTF-16.
    size = lambda value: len(value.encode("utf-16-le")) // 2

    def markers(node, context=None, offset=0):
        if tag(node) == "p":
            context, offset = node, 0
        if tag(node) == "ref" and node.get("type") == "bibr":
            targets = node.get("target", "").split()
            resolved = [t for t in targets if t.startswith("#") and t[1:] in references]
            result["citationMarkers"].append(dict(id=identity(node, f"citation:{len(result['citationMarkers'])}"),
                text=text(node), targets=targets, referenceIds=[t[1:] for t in resolved],
                unresolvedTargets=[t for t in targets if t not in resolved],
                context=text(context) if context is not None else None,
                contextOffset=offset if context is not None else None, location=loc(node)))
            return
        at = offset + size(node.text or "")
        for child in node:
            markers(child, context, at)
            at += size(text(child)) + size(child.tail or "")

    if body is not None:
        markers(body)
    return result


def main():
    report_path = Path(sys.argv[1]).resolve()
    report_bytes = report_path.read_bytes()
    report = json.loads(report_bytes)
    lock_path = ROOT / report["sourceLock"]
    assert sha(lock_path.read_bytes()) == report["sourceLockSha256"]
    lock = json.loads(lock_path.read_bytes())
    for path, digest in report["codeHashes"].items():
        assert sha((ROOT / path).read_bytes()) == digest, path
    for source in lock["rows"]:
        data = (ROOT / source["path"]).read_bytes()
        assert len(data) == source["size"] and sha(data) == source["sha256"]
        assert hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest() == source["gitBlobSha"]
    first, second = report["runs"]
    assert first == second
    assert sha(canonical(first["rows"])) == first["deterministicHash"]
    checked = []
    for row in first["rows"]:
        source = lock["rows"][row["index"]]
        root = ET.fromstring((ROOT / source["path"]).read_bytes())
        for trial in range(2):
            saved = report_path.parent / f"trial-{trial}/source-{row['index']}.json"
            assert json.loads(saved.read_bytes()) == row
        if tag(root) in ("teiCorpus", "tei"):
            assert row["status"] == "failed" and row["failureCode"] == "research_grobid_output_unsupported"
            assert row["fields"] is None and not row["resolutions"]
        else:
            assert row["status"] == "parsed" and row["fields"] == fields(root), source["path"]
            expected_warnings = []
            if any(x["location"]["status"] == "invalid" for key in ("sections", "references", "citationMarkers") for x in row["fields"][key]):
                expected_warnings.append("research_grobid_coordinates_invalid")
            if any(x["unresolvedTargets"] for x in row["fields"]["citationMarkers"]):
                expected_warnings.append("research_grobid_reference_target_missing")
            assert set(row["warnings"]) == set(expected_warnings)
        checked.append(dict(index=row["index"], root=tag(root), status=row["status"]))
    semantic = json.loads((ROOT / "evaluation/results/scientific-paper-semantics-regression.json").read_bytes())
    saved_path = semantic["savedReplay"]["report"]
    saved_bytes = (ROOT / saved_path).read_bytes()
    assert sha(saved_bytes) == semantic["artifactHashes"][saved_path]
    inputs = json.loads(saved_bytes)["inputs"]
    assert len(inputs) == len(report["disabled"]) == 45
    for source, disabled in zip(inputs, report["disabled"]):
        assert sha(Path(source["sourcePath"]).read_bytes()) == source["sourceHash"] == disabled["sourceHash"]
        parsed_bytes = Path(source["path"]).read_bytes()
        assert sha(parsed_bytes) == source["sha256"]
        blocks = [{k: b[k] for k in ("id", "kind", "text", "locator")} for b in json.loads(parsed_bytes)["blocks"] if b["text"].strip()]
        assert sha(json.dumps(blocks, ensure_ascii=False, separators=(",", ":")).encode()) == disabled["sourceBlocksDigest"]
        assert disabled["status"] == "disabled"
        assert disabled["missingFields"] == ["metadata", "sections", "references", "citation_markers", "coordinates"]
    result = dict(status="verified-repeatable", report=str(report_path.relative_to(ROOT)),
                  reportSha256=sha(report_bytes), sources=checked, disabledPapers=45,
                  deterministicHash=first["deterministicHash"],
                  verifierSha256=sha(Path(__file__).read_bytes()),
                  limitations=report["limitations"])
    target = Path(sys.argv[2])
    with target.open("x") as output:
        json.dump(result, output, ensure_ascii=False, indent=2)
        output.write("\n")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
