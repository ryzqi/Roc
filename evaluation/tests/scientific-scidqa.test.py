import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("scidqa", ROOT / "scripts/prepare-scientific-scidqa.py")
scidqa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scidqa)


class SciDQAExportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.source = self.root / "sources"
        self.output = self.root / "export"
        self.source.mkdir()
        self.rows = [
            {"id": 11, "year": 2022, "venue": "NeurIPS", "rid": "review-1", "pid": "paper-1",
             "decision": "Accept", "que": "  Published question α?  ", "ans": "A: First\nanswer.",
             "version": "Initial"},
            {"id": 19, "year": 2021, "venue": "ICLR", "rid": "review-2", "pid": "paper-2",
             "decision": "Reject", "que": "Second question?", "ans": "Revised answer.",
             "version": "Revised"},
        ]
        self.lock = json.loads(scidqa.LOCK.read_bytes())
        self.lock.update(expectedRows=2, expectedPapers=2, expectedVersions={"Initial": 1, "Revised": 1})
        self.originals = {"README.md": b"Source provenance", "publication.pdf": b"%PDF-contract-fixture",
                          "test.jsonl": b"\n".join(json.dumps(r, ensure_ascii=False).encode() for r in self.rows) + b"\n"}
        self.publish_sources()
        self.calls = 0

    def tearDown(self):
        self.temporary.cleanup()

    def publish_sources(self):
        for pin in self.lock["files"]:
            data = self.originals[pin["path"]]
            pin.update(bytes=len(data), sha256=scidqa.digest(data))
            (self.source / pin["path"]).write_bytes(data)

    def no_network(self, *args, **kwargs):
        self.calls += 1
        raise AssertionError("offline replay attempted a download")

    def prepare(self, verify=False):
        return scidqa.prepare(self.source, self.output, offline=True, verify=verify,
                              lock=self.lock, opener=self.no_network)

    def test_exact_original_fields_versions_and_no_qualification_invention(self):
        report = self.prepare()
        labels = json.loads((self.output / "labels.json").read_bytes())
        self.assertEqual([r["original"] for r in labels], self.rows)
        self.assertEqual([r["publishedRow"] for r in labels], [0, 1])
        self.assertEqual([r["sourceDocumentVersion"] for r in labels], ["Initial", "Revised"])
        self.assertEqual(report["completeEvidenceQueries"], 0)
        self.assertFalse(report["scientificBaselineReady"])
        self.assertIsNone(report["qualityMetrics"])
        for row in labels:
            self.assertIsNone(row["expectedEvidenceSpans"])
            self.assertIsNone(row["planCategory"])
            self.assertIsNone(row["answerable"])
        self.assertEqual(self.calls, 0)

    def test_offline_reconstruction_preserves_all_source_and_export_bytes_and_mtimes(self):
        self.prepare()
        before = {p: (p.read_bytes(), p.stat().st_mtime_ns)
                  for root in (self.source, self.output) for p in root.iterdir()}
        self.prepare(verify=True)
        self.assertEqual(before, {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in before})
        self.assertEqual(self.calls, 0)

    def test_changed_source_is_rejected_without_overwriting_it_or_existing_export(self):
        self.prepare()
        original_export = (self.output / "labels.json").read_bytes()
        path = self.source / "test.jsonl"
        changed = path.read_bytes().replace(b"First", b"Other")
        path.write_bytes(changed)
        with self.assertRaisesRegex(ValueError, "source_changed"):
            self.prepare()
        self.assertEqual(path.read_bytes(), changed)
        self.assertEqual((self.output / "labels.json").read_bytes(), original_export)

    def test_missing_offline_source_never_calls_network_or_creates_export(self):
        (self.source / "test.jsonl").unlink()
        with self.assertRaisesRegex(ValueError, "source_missing"):
            self.prepare()
        self.assertFalse(self.output.exists())
        self.assertEqual(self.calls, 0)

    def test_export_tampering_is_rejected_and_preserved(self):
        self.prepare()
        path = self.output / "labels.json"
        changed = path.read_bytes().replace(b"null", b"true", 1)
        path.write_bytes(changed)
        with self.assertRaisesRegex(ValueError, "export_changed"):
            self.prepare(verify=True)
        self.assertEqual(path.read_bytes(), changed)

    def test_duplicate_ids_and_unknown_versions_are_not_silently_repaired(self):
        for mutation in ("duplicate", "version"):
            rows = copy.deepcopy(self.rows)
            if mutation == "duplicate":
                rows[1]["id"] = rows[0]["id"]
            else:
                rows[1]["version"] = "Current"
            self.originals["test.jsonl"] = b"\n".join(json.dumps(r).encode() for r in rows)
            self.publish_sources()
            with self.assertRaisesRegex(ValueError, "label_invalid"):
                self.prepare()
            self.assertFalse(self.output.exists())

    def test_overlapping_paths_and_symlink_ancestors_rejected_before_writes(self):
        with self.assertRaisesRegex(ValueError, "overlaps_source"):
            scidqa.prepare(self.source, self.source / "export", lock=self.lock)
        link = self.root / "alias"
        link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "path_invalid"):
            scidqa.prepare(self.source, link / "export", lock=self.lock)
        self.assertFalse(self.output.exists())

    def test_lock_rejects_moving_url_and_traversal_file_name(self):
        for mutation in ("url", "path"):
            lock = copy.deepcopy(self.lock)
            if mutation == "url":
                lock["files"][0]["url"] = lock["files"][0]["url"].replace(lock["revision"], "main")
            else:
                lock["files"][0]["path"] = "../README.md"
            with self.assertRaisesRegex(ValueError, "lock_invalid"):
                scidqa.prepare(self.source, self.output, lock=lock, opener=self.no_network)
        self.assertFalse(self.output.exists())
        self.assertEqual(self.calls, 0)


if __name__ == "__main__":
    unittest.main()
