import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "resources/research-runtime"))
import bibliography
from test_worker import worker


class BibliographyTests(unittest.TestCase):
    def test_keeps_protected_titles_custom_fields_and_institutional_authors(self):
        text = '@string{journalname={A Journal}}\n@article{doe2026,title={A {DNA} study},author={Doe, Jane and {Research Group}},journal=journalname,year={2026},doi={10.1234/X},custom={keep me}}'
        entries = bibliography.read_bibtex(text)
        self.assertEqual(entries[0]["title"], "A DNA study")
        self.assertEqual(entries[0]["authors"], ["Jane Doe", "Research Group"])
        self.assertEqual(entries[0]["fields"]["title"], "A {DNA} study")
        output = bibliography.write_bibliography(entries, "biblatex")
        restored = bibliography.read_bibtex(output)[0]
        self.assertEqual(restored["fields"]["journaltitle"], "A Journal")
        self.assertEqual(restored["fields"]["custom"], "keep me")
        csl = json.loads(bibliography.write_bibliography(entries, "csl-json"))[0]
        self.assertEqual(csl["author"], [{"given": "Jane", "family": "Doe"}, {"literal": "Research Group"}])

    def test_round_trips_zotero_csl_dates_unicode_and_extra_fields(self):
        source = [{"id": "source", "type": "article-journal", "title": "研究 A & B", "DOI": "10.1234/x",
                   "author": [{"family": "Doe", "given": "Jane"}, {"literal": "Research Group"}],
                   "issued": {"date-parts": [[2026, 9, 11]]}, "container-title": "A Journal", "custom-extra": "preserved"}]
        entries = bibliography.read_csl(json.dumps(source))
        self.assertEqual(entries[0]["title"], "研究 A & B")
        exported = json.loads(bibliography.write_bibliography(entries, "csl-json"))[0]
        self.assertEqual(exported, source[0])
        bib = bibliography.write_bibliography(entries, "bibtex")
        self.assertEqual(bibliography.read_bibtex(bib)[0]["title"], "研究 A & B")

    def test_reports_bad_blocks_and_required_metadata_instead_of_partial_import(self):
        with self.assertRaisesRegex(ValueError, "parse_failed"):
            bibliography.read_bibtex('@article{broken,title={not closed}')
        with self.assertRaisesRegex(ValueError, "title_required"):
            bibliography.read_bibtex('@article{key,author={Doe, Jane}}')
        with self.assertRaisesRegex(ValueError, "csl_type_required"):
            bibliography.read_csl('[{"id":"key","title":"Title"}]')

    def test_export_rejects_duplicate_citation_keys(self):
        entry = bibliography.read_bibtex('@article{key,title={Title}}')[0]
        with self.assertRaisesRegex(ValueError, "citation_key_duplicate"):
            bibliography.write_bibliography([entry, entry], "bibtex")

    def test_does_not_overwrite_conflicting_journal_fields_during_export(self):
        entries = bibliography.read_bibtex('@article{key,title={Title},journal={Legacy Journal},journaltitle={Primary Journal}}')
        for format in ("bibtex", "biblatex", "csl-json"):
            with self.subTest(format=format), self.assertRaisesRegex(ValueError, "journal_conflict"):
                bibliography.write_bibliography(entries, format)

    def test_empty_journal_aliases_do_not_replace_the_retained_title(self):
        for fields in ("journal={},journaltitle={Primary}", "journal={Primary},journaltitle={ }", "journal={ },journaltitle={Primary}"):
            entries = bibliography.read_bibtex('@article{key,title={Title},' + fields + '}')
            for format in ("bibtex", "biblatex", "csl-json"):
                with self.subTest(fields=fields, format=format):
                    output = bibliography.write_bibliography(entries, format)
                    if format == "csl-json":
                        self.assertEqual(json.loads(output)[0]["container-title"], "Primary")
                    else:
                        key = "journal" if format == "bibtex" else "journaltitle"
                        self.assertEqual(bibliography.read_bibtex(output)[0]["fields"][key], "Primary")

    def test_converts_chapters_with_their_book_title_editors_and_edition(self):
        source = [{"id": "chapter", "type": "chapter", "title": "A chapter", "container-title": "A book", "edition": "2",
                   "editor": [{"given": "Jane", "family": "Doe"}], "translator": [{"literal": "Research Group"}]}]
        entries = bibliography.read_csl(json.dumps(source))
        self.assertEqual(entries[0]["fields"]["booktitle"], "A book")
        restored = bibliography.read_bibtex(bibliography.write_bibliography(entries, "bibtex"))
        result = json.loads(bibliography.write_bibliography(restored, "csl-json"))
        self.assertEqual(result, source)

    def test_keeps_percent_encoded_urls_and_decodes_only_tex_uri_escapes(self):
        source = [{"id": "uri", "type": "article-journal", "title": "Links", "URL": "https://example.org/a%20b?x=1&y=2", "DOI": "10.1234/a_b"}]
        entries = bibliography.read_csl(json.dumps(source))
        self.assertEqual(entries[0]["url"], source[0]["URL"])
        self.assertEqual(json.loads(bibliography.write_bibliography(entries, "csl-json"))[0]["URL"], source[0]["URL"])
        parsed = bibliography.read_bibtex(r'@misc{escaped,title={Links},url={\url{https://example.org/a\_b?q=x\&y=2}},doi={10.1234/a\_b}}')[0]
        self.assertEqual(parsed["url"], "https://example.org/a_b?q=x&y=2")
        self.assertEqual(parsed["doi"], "10.1234/a_b")

    def test_preserves_preamble_and_parses_names_with_particles(self):
        text = '@preamble{"\\newcommand{\\x}{X}"}\n@book{book,title={A book},author={von Neumann, John},year={1950}}'
        entries = bibliography.read_bibtex(text)
        restored = bibliography.read_bibtex(bibliography.write_bibliography(entries, "bibtex"))[0]
        self.assertEqual(restored["preambles"], entries[0]["preambles"])
        csl = json.loads(bibliography.write_bibliography(entries, "csl-json"))[0]
        self.assertEqual(csl["author"], [{"given": "John", "family": "Neumann", "non-dropping-particle": "von"}])

    def test_updates_both_csl_identifiers_after_a_citation_key_edit(self):
        entries = bibliography.read_csl('[{"id":"old","citation-key":"old","type":"article-journal","title":"Title"}]')
        entries[0]["citationKey"] = "new-key"
        result = json.loads(bibliography.write_bibliography(entries, "csl-json"))[0]
        self.assertEqual(result["id"], "new-key")
        self.assertEqual(result["citation-key"], "new-key")
        self.assertEqual(bibliography.read_csl(json.dumps([result]))[0]["citationKey"], "new-key")

    def test_export_uses_retained_dates_after_merging_csl_metadata(self):
        entries = bibliography.read_csl('[{"id":"key","type":"article-journal","title":"Title","issued":{"date-parts":[[2009,1]]}}]')
        entries[0]["publishedYear"] = 2026
        entries[0]["fields"].update({"date": "2026-09-11", "year": "2026"})
        result = json.loads(bibliography.write_bibliography(entries, "csl-json"))[0]
        self.assertEqual(result["issued"], {"date-parts": [[2026, 9, 11]]})

    def test_preserves_csl_author_extensions_and_date_qualifiers(self):
        source = [{"id": "key", "type": "article-journal", "title": "Title", "author": [
            {"family": "Doe", "given": "Jane", "ORCID": "https://orcid.org/0000-0000-0000-0000"}],
            "issued": {"date-parts": [[2026]], "circa": True}}]
        result = json.loads(bibliography.write_bibliography(bibliography.read_csl(json.dumps(source)), "csl-json"))
        self.assertEqual(result, source)

    def test_rejects_invalid_csl_dates_and_unknown_types(self):
        for issued in ([], "2026", {"date-parts": []}, {"date-parts": [[2026, True]]},
                       {"date-parts": [[2026, 13]]}, {"date-parts": [[2026, 2, 30]]},
                       {"date-parts": [[2026, 1], ["bad"]]}, {"date-parts": [[2026, 1, 1, 9]]}):
            with self.subTest(issued=issued), self.assertRaisesRegex(ValueError, "csl_date_invalid"):
                bibliography.read_csl(json.dumps([{"id": "key", "type": "article-journal", "title": "Title", "issued": issued}]))
        with self.assertRaisesRegex(ValueError, "csl_type_unsupported"):
            bibliography.read_csl('[{"id":"key","type":"invented-type","title":"Title"}]')

    def test_preserves_full_dates_across_biblatex_and_csl(self):
        entry = bibliography.read_bibtex('@article{key,title={Title},date={2026-09-11}}')[0]
        result = json.loads(bibliography.write_bibliography([entry], "csl-json"))[0]
        self.assertEqual(result["issued"], {"date-parts": [[2026, 9, 11]]})
        restored = bibliography.read_csl(json.dumps([result]))[0]
        self.assertEqual(restored["fields"]["date"], "2026-09-11")

    def test_keeps_date_ranges_literal_dates_and_standard_bibtex_months(self):
        for date in ({"date-parts": [[2026, 9, 11], [2026, 9, 13]]}, {"literal": "in press"}):
            source = [{"id": "range", "title": "Dates", "type": "article-journal", "issued": date}]
            entries = bibliography.read_csl(json.dumps(source))
            bib = bibliography.write_bibliography(entries, "biblatex")
            restored = json.loads(bibliography.write_bibliography(bibliography.read_bibtex(bib), "csl-json"))[0]
            self.assertEqual(restored["issued"], date)
        entry = bibliography.read_bibtex('@article{key,title={Dates},year={2026},month=sep,day={11}}')[0]
        self.assertEqual(json.loads(bibliography.write_bibliography([entry], "csl-json"))[0]["issued"], {"date-parts": [[2026, 9, 11]]})

    def test_normalizing_search_metadata_preserves_atomic_author_names(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "record.json"
            authors = ["Jane Doe", "Research and Development Group"]
            source.write_text(json.dumps([{"citationKey": "key", "metadata": {"title": "Title", "authors": authors,
                              "doi": None, "url": None, "abstract": None, "publishedYear": None}}]), encoding="utf-8")
            self.assertEqual(bibliography.normalize_file(source)["entries"][0]["authors"], authors)

    def test_worker_reads_and_writes_bibliography_in_fresh_project_outputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            source = root / "references.bib"
            source.write_text('@article{key,title={A {DNA} study},year={2026}}', encoding="utf-8")
            request = {"operation": "read_bibliography", "projectRoot": str(root), "sourcePath": str(source),
                       "outputDir": str(root / "read"), "format": "bibtex"}
            parsed = worker.execute(worker.parse_request(request))
            self.assertEqual(parsed["sourceHash"], worker.file_hash(source))
            data = root / "entries.json"
            data.write_text(json.dumps(parsed["entries"]), encoding="utf-8")
            result = worker.execute(worker.parse_request({**request, "operation": "write_bibliography", "sourcePath": str(data),
                                                          "outputDir": str(root / "write"), "format": "csl-json"}))
            self.assertEqual(json.loads(result["content"])[0]["title"], "A DNA study")
            self.assertEqual((root / "write/references.json").read_text(), result["content"])


if __name__ == "__main__":
    unittest.main()
