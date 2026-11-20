"""Read saved public inputs with an independent stdlib HTML parser; no production imports."""
import hashlib
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path


class Node:
    def __init__(self, tag="", attrs=None):
        self.tag, self.attrs, self.children = tag, dict(attrs or []), []

    def find(self, tag):
        return ([self] if self.tag == tag else []) + [
            found for child in self.children if isinstance(child, Node) for found in child.find(tag)]

    def text(self):
        if self.tag in ("script", "style", "template"):
            return ""
        return "".join(child.text() if isinstance(child, Node) else child for child in self.children)

    def clean(self):
        return re.sub(r"\s+", " ", self.text()).strip()


class Tree(HTMLParser):
    def __init__(self, raw):
        super().__init__(convert_charrefs=True)
        self.root = Node()
        self.stack = [self.root]
        self.feed(raw)

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs)
        self.stack[-1].children.append(node)
        if tag == "br":
            node.children.append("\n")
        if tag not in ("br", "img", "hr", "meta", "link", "input", "wbr"):
            self.stack.append(node)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read(path):
    return json.loads(Path(path).read_text())


def derive(block, region):
    structure, matched = region.get("table") or {}, region.get("tableMatches") or {}
    choices = [(matched.get("fullHtml"), "matched"), (matched.get("html"), "matched"),
               (structure.get("fullHtml"), "structure"), (structure.get("html"), "structure"),
               (region.get("rawHtml"), "html")]
    raw, source = next(((raw, source) for raw, source in choices if isinstance(raw, str) and raw.strip()), (None, "missing"))
    expected = dict(rawHtml=raw, htmlSource=source, rows=[], columns=[], footnotes=[], caption=None, tableNumber=None,
                    status="missing" if raw is None else "parsed")
    if raw is None:
        return expected
    try:
        tree = Tree(raw).root
        tables = tree.find("table")
        assert len(tables) <= 1
        root = tables[0] if tables else tree
        assert len(root.find("tr")) == len(tree.find("tr"))
        captions = root.find("caption")
        assert len(captions) <= 1
        expected["caption"] = captions[0].clean() or None if captions else None
        number = re.match(r"^(?:Table|Tab\.?|表)\s*([A-Z]?\d+(?:[.-]\d+)*|[IVX]+)", expected["caption"] or "", re.I)
        expected["tableNumber"] = number[1] if number else None
        feet = [row for foot in root.find("tfoot") for row in foot.find("tr")]
        expected["footnotes"] = [row.clean() for row in feet if row.clean()]
        heads = [row for head in root.find("thead") for row in head.find("tr")]
        rows = [row for row in root.find("tr") if row not in feet]
        assert 0 < len(rows) <= 1000
        occupied, anchors, width = set(), [], 0
        for y, row in enumerate(rows):
            cells, x = [], 0
            for node in row.children:
                if not isinstance(node, Node) or node.tag not in ("td", "th"):
                    continue
                while (y, x) in occupied:
                    x += 1
                spans = [node.attrs.get(key, "1") for key in ("rowspan", "colspan")]
                assert all(re.fullmatch("[1-9][0-9]*", value) for value in spans)
                rs, cs = map(int, spans)
                assert rs <= 1000 and cs <= 1000 and y + rs <= len(rows) and x + cs <= 1000
                covered = {(j, i) for j in range(y, y + rs) for i in range(x, x + cs)}
                assert not occupied.intersection(covered)
                occupied.update(covered)
                cell = dict(id=f"table:{block['id']}:cell:{y}:{x}", column=x, text=node.clean(),
                            rowSpan=rs, colSpan=cs, header=node.tag == "th" or row in heads, bbox=None)
                cells.append(cell)
                anchors.append(cell)
                x += cs
                width = max(width, x)
            expected["rows"].append(dict(index=y, cells=cells))
        assert 0 < len(anchors) <= 10000
        for x in range(width):
            headers = [cell for cell in anchors if cell["header"] and cell["column"] <= x < cell["column"] + cell["colSpan"]]
            units = set()
            for header in headers:
                unit = re.search(r"(?:\((%|ms|s|kg|g|mm|cm|m|K|°C|MB|GB|Hz)\)|\[([^\]\[\n]{1,30})\])\s*$", header["text"])
                if unit:
                    units.add(unit[1] or unit[2])
            expected["columns"].append(dict(index=x, header=" / ".join(h["text"] for h in headers if h["text"]),
                                             headerCellIds=[h["id"] for h in headers], unit=next(iter(units)) if len(units) == 1 else None))
        boxes, location = structure.get("bbox"), block["locations"][0]
        if isinstance(boxes, list) and len(boxes) == len(anchors) and block["imagePath"] and location["coordinateOrigin"] == "TOPLEFT":
            base = location["bbox"]
            mapped = []
            for box in boxes:
                assert len(box) in (4, 8)
                xs, ys = (box[::2], box[1::2]) if len(box) == 8 else ([box[0], box[2]], [box[1], box[3]])
                mapped.append([min(xs) + base[0], min(ys) + base[1], max(xs) + base[0], max(ys) + base[1]])
            if all(base[0] <= b[0] < b[2] <= base[2] and base[1] <= b[1] < b[3] <= base[3] for b in mapped):
                for cell, box in zip(anchors, mapped):
                    cell["bbox"] = box
    except (AssertionError, ValueError, TypeError):
        expected.update(status="invalid", rows=[], columns=[], footnotes=[], caption=None, tableNumber=None)
    return expected


def verify(report_path):
    report = read(report_path)
    for path, value in report["codeHashes"].items():
        assert digest(path) == value, path
    for pin in report["inputs"]:
        path = Path(pin["path"])
        assert digest(path) == pin["sha256"] and path.stat().st_mtime_ns == int(pin["mtimeNs"]), str(path)
    totals = dict(tables=0, parsed=0, missing=0, invalid=0, cells=0, indexedTables=0, mappedCells=0)
    publications, trials = 0, [[], []]
    for cohort_index, cohort in enumerate(report["cohorts"]):
        original = read(cohort["run"])
        assert len(original["rows"]) == cohort["rows"]
        for index, row in enumerate(original["rows"]):
            saved = [read(Path(report["root"]) / f"trial-{trial}/cohort-{cohort_index}-row-{index}.json") for trial in range(2)]
            assert saved[0] == saved[1]
            for trial in range(2):
                trials[trial].append(saved[trial])
            assert saved[0]["status"] == row["status"] and saved[0]["failure"] == row["failure"]
            if row["status"] != "parsed":
                assert not saved[0]["tables"] and not saved[0]["indexedTables"]
                continue
            parsed = read(Path(original["root"]) / row["result"])
            structured = read(Path(original["root"]) / row["structured"])
            regions = {region["id"]: region for page in structured["pages"] for region in page["regions"]}
            blocks = [block for block in parsed["blocks"] if block["kind"] == "table"]
            assert len(blocks) == len(saved[0]["tables"])
            for block, table in zip(blocks, saved[0]["tables"]):
                expected = derive(block, regions.get(block["id"], {}))
                for key, value in expected.items():
                    assert table[key] == value, (cohort_index, index, block["id"], key)
                assert table["source"] == dict(block["locations"][0], locator=block["locator"])
                assert table["blockId"] == block["id"] and table["id"] == "table:" + block["id"]
                assert table["imagePath"] == block["imagePath"] and table["assetId"] is None
                chunks = [chunk for chunk in saved[0]["indexedTables"] if chunk["table"]["blockId"] == block["id"]]
                assert len(chunks) == 1 and chunks[0] == dict(content=block["text"], locator=block["locator"], table=table)
                totals["tables"] += 1
                totals[table["status"]] += 1
                totals["cells"] += sum(len(r["cells"]) for r in table["rows"])
                totals["mappedCells"] += sum(c["bbox"] is not None for r in table["rows"] for c in r["cells"])
                totals["indexedTables"] += 1
            if saved[0]["publishedTables"] is not None:
                publications += 1
                for value in saved[0]["publishedTables"]:
                    table, asset = value["table"], value["asset"]
                    original_table = next(t for t in saved[0]["tables"] if t["id"] == table["id"])
                    assert table == dict(original_table, assetId=asset["id"] if asset else None)
                    if asset:
                        pin = next(a for a in row["artifacts"] if a["path"] == table["imagePath"])
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
