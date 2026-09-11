"""使用 Bibtexparser 与 CSL JSON 交换文献，保留原始字段。"""

from __future__ import annotations

from copy import deepcopy
from calendar import monthrange
import json
from pathlib import Path
import re
from typing import TypedDict

import bibtexparser
from bibtexparser.library import Library
from bibtexparser.middlewares import SeparateCoAuthors, SplitNameParts
from bibtexparser.model import Entry, Field, Preamble
from pylatexenc.latex2text import LatexNodes2Text
from pylatexenc.latexencode import unicode_to_latex


class BibliographyEntry(TypedDict):
    citationKey: str
    entryType: str
    fields: dict[str, str]
    preambles: list[str]
    csl: dict | None
    title: str
    authors: list[str]
    doi: str | None
    publishedYear: int | None
    abstract: str | None
    url: str | None


TEXT = LatexNodes2Text()
CSL_FIELDS = {"publisher": "publisher", "publisher-place": "address", "edition": "edition",
              "volume": "volume", "issue": "number", "page": "pages", "ISBN": "isbn", "ISSN": "issn",
              "DOI": "doi", "URL": "url", "abstract": "abstract", "language": "language", "note": "note"}
CSL_TYPES = {"article-journal": "article", "article-magazine": "article", "article-newspaper": "article",
             "book": "book", "chapter": "incollection", "paper-conference": "inproceedings",
             "report": "techreport", "thesis": "phdthesis", "webpage": "online", "dataset": "misc",
             "article": "misc", "bill": "misc", "broadcast": "misc", "classic": "book", "collection": "book",
             "document": "misc", "entry": "incollection", "entry-dictionary": "incollection", "entry-encyclopedia": "incollection",
             "event": "misc", "figure": "misc", "graphic": "misc", "hearing": "misc", "interview": "misc",
             "legal_case": "misc", "legislation": "misc", "manuscript": "unpublished", "map": "misc",
             "motion_picture": "misc", "musical_score": "misc", "pamphlet": "booklet", "patent": "misc",
             "performance": "misc", "periodical": "misc", "personal_communication": "misc", "post": "online",
             "post-weblog": "online", "regulation": "misc", "review": "article", "review-book": "article",
             "software": "misc", "song": "misc", "speech": "misc", "standard": "techreport", "treaty": "misc"}
BIB_TYPES = {"article": "article-journal", "book": "book", "booklet": "book", "inbook": "chapter",
             "incollection": "chapter", "inproceedings": "paper-conference", "conference": "paper-conference",
             "proceedings": "book", "techreport": "report", "report": "report", "phdthesis": "thesis",
             "mastersthesis": "thesis", "thesis": "thesis", "online": "webpage", "misc": "article",
             "unpublished": "manuscript", "manual": "book", "collection": "book", "mvbook": "book", "mvcollection": "book",
             "mvproceedings": "book", "periodical": "periodical", "dataset": "dataset", "software": "software", "patent": "patent",
             "suppbook": "chapter", "suppcollection": "chapter", "suppperiodical": "article-journal", "bookinbook": "chapter",
             "reference": "book", "mvreference": "book", "inreference": "entry-encyclopedia"}
BOOK_CONTAINERS = {"chapter", "paper-conference", "entry", "entry-dictionary", "entry-encyclopedia"}


def required_text(value: object, code: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(code)
    return value.strip()


def citation_key(value: object) -> str:
    key = required_text(value, "research_citation_key_required")
    if re.search(r'[\s,{}\\%#"]', key):
        raise ValueError("research_citation_key_invalid")
    return key


def decode(value: str) -> str:
    return TEXT.latex_to_text(value).strip()


def decode_uri(value: str) -> str:
    value = value.strip()
    if value.startswith("\\url{") and value.endswith("}"):
        value = value[5:-1]
    return re.sub(r"\\([%&#_{}$])", r"\1", value)


def encode(value: str) -> str:
    return unicode_to_latex(value, non_ascii_only=False, replacement_latex_protection="braces",
                            unknown_char_policy="keep", unknown_char_warning=False)


def author_names(value: str) -> tuple[list[str], list[dict]]:
    if not value.strip():
        return [], []
    library = Library()
    library.add(Entry("misc", "names", [Field("author", value)]))
    library = SeparateCoAuthors().transform(library)
    library = SplitNameParts().transform(library)
    if library.failed_blocks:
        raise ValueError("research_bibliography_authors_invalid")
    names, people = [], []
    for person in library.entries[0]["author"]:
        family = decode(" ".join(person.last))
        given = decode(" ".join(person.first))
        particle = decode(" ".join(person.von))
        suffix = decode(" ".join(person.jr))
        literal = not person.first and not person.von and not person.jr and len(person.last) == 1 and person.last[0].startswith("{")
        name = " ".join(part for part in (given, particle, family, suffix) if part)
        if not name:
            raise ValueError("research_bibliography_authors_invalid")
        names.append(name)
        people.append({"literal": family} if literal else {key: part for key, part in
                      (("given", given), ("family", family), ("non-dropping-particle", particle), ("suffix", suffix)) if part})
    return names, people


def csl_author_field(people: object) -> str:
    if not isinstance(people, list):
        raise ValueError("research_csl_authors_invalid")
    authors = []
    for person in people:
        if not isinstance(person, dict):
            raise ValueError("research_csl_authors_invalid")
        if person.get("literal"):
            authors.append("{" + encode(required_text(person["literal"], "research_csl_authors_invalid")) + "}")
        else:
            family = required_text(person.get("family"), "research_csl_authors_invalid")
            given = person.get("given", "")
            particle = person.get("non-dropping-particle", "")
            dropping = person.get("dropping-particle", "")
            suffix = person.get("suffix", "")
            if any(not isinstance(value, str) for value in (given, particle, dropping, suffix)):
                raise ValueError("research_csl_authors_invalid")
            last = " ".join(value for value in (particle, family) if value)
            first = " ".join(value for value in (given, dropping) if value)
            authors.append(encode(last) + (", " + encode(suffix) if suffix else "") + ", " + encode(first))
    return " and ".join(authors)


def entry_record(key: str, entry_type: str, fields: dict[str, str], *, preambles: list[str], csl: dict | None) -> BibliographyEntry:
    title = decode(required_text(fields.get("title"), "research_bibliography_title_required"))
    if not title:
        raise ValueError("research_bibliography_title_required")
    authors, _ = author_names(fields.get("author", ""))
    date = fields.get("year", fields.get("date", ""))
    year = re.match(r"^(-?\d{1,4})(?:\b|-)", date)
    return {"citationKey": citation_key(key), "entryType": entry_type.lower(), "fields": fields, "preambles": preambles,
            "csl": csl, "title": title, "authors": authors, "doi": decode_uri(fields["doi"]) if fields.get("doi") else None,
            "publishedYear": int(year[1]) if year else None, "abstract": decode(fields["abstract"]) if fields.get("abstract") else None,
            "url": decode_uri(fields["url"]) if fields.get("url") else None}


def csl_date_parts(value: object) -> list[list[int]] | None:
    if not isinstance(value, dict):
        raise ValueError("research_csl_date_invalid")
    if "date-parts" not in value:
        if any(isinstance(value.get(key), str) and value[key].strip() for key in ("literal", "raw")):
            return None
        raise ValueError("research_csl_date_invalid")
    parts = value["date-parts"]
    if not isinstance(parts, list) or not 1 <= len(parts) <= 2:
        raise ValueError("research_csl_date_invalid")
    for date in parts:
        if not isinstance(date, list) or not 1 <= len(date) <= 3 or any(type(number) is not int for number in date):
            raise ValueError("research_csl_date_invalid")
        if len(date) >= 2 and not 1 <= date[1] <= 12:
            raise ValueError("research_csl_date_invalid")
        if len(date) == 3 and not 1 <= date[2] <= monthrange(date[0], date[1])[1]:
            raise ValueError("research_csl_date_invalid")
    return parts


def bib_date(fields: dict[str, str], year: int | None) -> dict | None:
    if fields.get("date"):
        raw = decode(fields["date"])
        dates = raw.split("/")
        if len(dates) <= 2 and all(re.fullmatch(r"-?\d{1,4}(?:-\d{2}){0,2}", value) for value in dates):
            parts = []
            for value in dates:
                match = re.fullmatch(r"(-?\d{1,4})(?:-(\d{2}))?(?:-(\d{2}))?", value)
                parts.append([int(part) for part in match.groups() if part is not None])
            result = {"date-parts": parts}
            csl_date_parts(result)
            return result
        return {"literal": raw}
    if year is None:
        return None
    parts = [year]
    if fields.get("month"):
        month = decode(fields["month"]).lower()
        month_names = {spelling: index for index, name in enumerate(
            ("january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"), 1)
            for spelling in (name, name[:3])}
        if month.isdecimal():
            parts.append(int(month))
        elif month in month_names:
            parts.append(month_names[month])
        else:
            raise ValueError("research_bibliography_month_invalid")
        if fields.get("day"):
            parts.append(int(fields["day"]))
    result = {"date-parts": [parts]}
    csl_date_parts(result)
    return result


def read_bibtex(text: str) -> list[BibliographyEntry]:
    library = bibtexparser.parse_string(text)
    if library.failed_blocks:
        lines = ",".join(str(block.start_line) for block in library.failed_blocks[:10])
        raise ValueError(f"research_bibliography_parse_failed:lines={lines}")
    if not library.entries or len(library.entries) > 5000:
        raise ValueError("research_bibliography_entry_count_invalid")
    preambles = [block.value for block in library.preambles]
    entries = []
    for entry in library.entries:
        fields = {field.key.lower(): field.value for field in entry.fields}
        if len(fields) != len(entry.fields) or any(not isinstance(value, str) for value in fields.values()):
            raise ValueError("research_bibliography_fields_invalid")
        entries.append(entry_record(entry.key, entry.entry_type, fields, preambles=preambles, csl=None))
    return entries


def read_csl(text: str) -> list[BibliographyEntry]:
    items = json.loads(text)
    if not isinstance(items, list) or not 1 <= len(items) <= 5000:
        raise ValueError("research_bibliography_entry_count_invalid")
    entries = []
    keys = set()
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("research_csl_item_invalid")
        raw_id = item.get("id")
        if type(raw_id) is int:
            raw_id = str(raw_id)
        key = citation_key(item.get("citation-key", raw_id))
        if key in keys:
            raise ValueError("research_citation_key_duplicate")
        keys.add(key)
        csl_type = required_text(item.get("type"), "research_csl_type_required")
        if csl_type not in CSL_TYPES:
            raise ValueError(f"research_csl_type_unsupported:{csl_type}")
        fields = {"title": encode(required_text(item.get("title"), "research_bibliography_title_required"))}
        for csl_name, bib_name in CSL_FIELDS.items():
            if csl_name in item and item[csl_name] is not None:
                value = item[csl_name]
                if not isinstance(value, str):
                    raise ValueError(f"research_csl_field_invalid:{csl_name}")
                fields[bib_name] = value if bib_name in {"doi", "url"} else encode(value)
        if "container-title" in item and item["container-title"] is not None:
            container = required_text(item["container-title"], "research_csl_container_title_invalid")
            fields["booktitle" if csl_type in BOOK_CONTAINERS else "journal"] = encode(container)
        for role in ("author", "editor", "translator"):
            people = csl_author_field(item.get(role, []))
            if people:
                fields[role] = people
        issued = item.get("issued")
        if issued is not None:
            parts = csl_date_parts(issued)
            if parts is not None:
                fields["year"] = str(parts[0][0])
                fields["date"] = "/".join(str(date[0]) + "".join(f"-{value:02d}" for value in date[1:]) for date in parts)
            else:
                fields["date"] = encode(issued["literal"] if "literal" in issued else issued["raw"])
        entries.append(entry_record(key, CSL_TYPES[csl_type], fields, preambles=[], csl=deepcopy(item)))
    return entries


def export_csl(entry: BibliographyEntry) -> dict:
    if entry["csl"] is None and entry["entryType"] not in BIB_TYPES:
        raise ValueError(f'research_bibliography_type_unsupported:{entry["entryType"]}')
    item = deepcopy(entry["csl"]) if entry["csl"] is not None else {"type": BIB_TYPES[entry["entryType"]]}
    item.update({"id": entry["citationKey"], "title": entry["title"]})
    if "citation-key" in item:
        item["citation-key"] = entry["citationKey"]
    for role in ("author", "editor", "translator"):
        names, people = author_names(entry["fields"].get(role, ""))
        original_names, _ = author_names(csl_author_field(item.get(role, [])))
        if people and names != original_names:
            item[role] = people
        elif not people:
            item.pop(role, None)
    for csl_name, bib_name in CSL_FIELDS.items():
        value = entry["fields"].get(bib_name)
        if value is not None:
            item[csl_name] = decode_uri(value) if bib_name in {"doi", "url"} else decode(value)
    container = entry["fields"].get("booktitle") if item["type"] in BOOK_CONTAINERS else journal_title(entry["fields"])
    if container is not None:
        item["container-title"] = decode(container)
    issued = bib_date(entry["fields"], entry["publishedYear"])
    if issued is not None:
        original_issued = item.get("issued")
        if isinstance(original_issued, dict) and original_issued.get("date-parts") == issued.get("date-parts"):
            item["issued"] = {**original_issued, **issued}
        else:
            item["issued"] = issued
    return item


def journal_title(fields: dict[str, str]) -> str | None:
    values = [fields[key] for key in ("journaltitle", "journal") if fields.get(key, "").strip()]
    if len(set(values)) > 1:
        raise ValueError("research_bibliography_journal_conflict")
    return values[0] if values else None


def write_bibliography(entries: list[BibliographyEntry], format: str) -> str:
    if format not in {"bibtex", "biblatex", "csl-json"}:
        raise ValueError("research_bibliography_format_invalid")
    if not 1 <= len(entries) <= 5000:
        raise ValueError("research_bibliography_entry_count_invalid")
    if len({entry["citationKey"] for entry in entries}) != len(entries):
        raise ValueError("research_citation_key_duplicate")
    for entry in entries:
        journal_title(entry["fields"])
    if format == "csl-json":
        return json.dumps([export_csl(entry) for entry in entries], ensure_ascii=False, indent=2) + "\n"
    library = Library()
    for preamble in dict.fromkeys(value for entry in entries for value in entry["preambles"]):
        library.add(Preamble(preamble))
    for entry in entries:
        fields = dict(entry["fields"])
        journal = journal_title(fields)
        if "journal" in fields or "journaltitle" in fields:
            fields.pop("journal", None)
            fields.pop("journaltitle", None)
            if journal is not None:
                fields["journal" if format == "bibtex" else "journaltitle"] = journal
        library.add(Entry(entry["entryType"], citation_key(entry["citationKey"]), [Field(key, value) for key, value in fields.items()]))
    output = bibtexparser.write_string(library)
    if bibtexparser.parse_string(output).failed_blocks:
        raise ValueError("research_bibliography_export_invalid")
    return output


def read_file(source: Path, format: str) -> dict:
    if source.stat().st_size > 16 * 1024 * 1024:
        raise ValueError("research_bibliography_too_large")
    text = source.read_text(encoding="utf-8-sig")
    return {"entries": read_csl(text) if format == "csl-json" else read_bibtex(text)}


def normalize_file(source: Path) -> dict:
    if source.stat().st_size > 16 * 1024 * 1024:
        raise ValueError("research_bibliography_too_large")
    records = json.loads(source.read_text(encoding="utf-8"))
    if not isinstance(records, list) or not 1 <= len(records) <= 5000:
        raise ValueError("research_bibliography_entry_count_invalid")
    entries = []
    for record in records:
        metadata = record["metadata"]
        fields = {"title": encode(required_text(metadata["title"], "research_bibliography_title_required"))}
        authors = metadata["authors"]
        if not isinstance(authors, list):
            raise ValueError("research_bibliography_authors_invalid")
        if authors:
            # 搜索适配器只提供完整显示名，每个数组成员必须保持为同一作者。
            fields["author"] = " and ".join("{" + encode(required_text(name, "research_bibliography_authors_invalid")) + "}" for name in authors)
        for name in ("doi", "url", "abstract"):
            value = metadata[name]
            if value is not None:
                value = required_text(value, f"research_bibliography_{name}_invalid")
                fields[name] = value if name in {"doi", "url"} else encode(value)
        if metadata["publishedYear"] is not None:
            if type(metadata["publishedYear"]) is not int:
                raise ValueError("research_bibliography_year_invalid")
            fields["year"] = str(metadata["publishedYear"])
        entries.append(entry_record(record["citationKey"], "misc", fields, preambles=[], csl=None))
    return {"entries": entries}


def write_file(source: Path, output: Path, format: str) -> dict:
    if source.stat().st_size > 16 * 1024 * 1024:
        raise ValueError("research_bibliography_too_large")
    entries = json.loads(source.read_text(encoding="utf-8"))
    content = write_bibliography(entries, format)
    filename = "references.json" if format == "csl-json" else "references.bib"
    (output / filename).write_text(content, encoding="utf-8")
    return {"filename": filename, "content": content}
