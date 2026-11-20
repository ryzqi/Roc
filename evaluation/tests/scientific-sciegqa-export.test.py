"""Source/export integrity regressions. Synthetic archives are never gold."""
import copy
import hashlib
import importlib.util
import io
import json
import struct
import tarfile
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "sciegqa_export", ROOT / "scripts/prepare-scientific-sciegqa.py")
export = importlib.util.module_from_spec(spec)
spec.loader.exec_module(export)


def tar_bytes(entries):
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w") as archive:
        for name, value in entries:
            member = tarfile.TarInfo(name)
            if isinstance(value, bytes):
                member.size = len(value)
                archive.addfile(member, io.BytesIO(value))
            else:
                member.type = value
                member.linkname = "../../escape"
                archive.addfile(member)
    return data.getvalue()


def inventory(root):
    return {p.relative_to(root).as_posix(): (p.read_bytes(), p.stat().st_mtime_ns)
            for p in root.rglob("*") if p.is_file()}


class ExportIntegrity(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        self.source = self.base / "source"
        self.source.mkdir()
        self.output = self.base / "output"
        self.lock = json.loads(export.sources.LOCK.read_bytes())
        self.lock.update(expectedRows=1, expectedPapers=1)
        self.row = {
            "query": "  Original query α?  ", "answer": "Original answer\n",
            "doc_name": "2301.00001", "category": "cs", "evidence_page": [1],
            "bbox": [[[10, 20, 80, 60]]], "rel_bbox": [[[100, 100, 800, 300]]],
            "subimg_type": [["image"]],
        }
        # Only a header is needed for the geometry reader; not a real scientific image.
        self.png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" + struct.pack(">II", 100, 200)
        self.pdf_name = "PDF/cs/2301.00001_original.pdf"
        self.image_name = "Images/cs/2301.00001/2301.00001_1.png"
        self.pdf_entries = [(self.pdf_name, b"%PDF-1.7\noriginal bytes")]
        self.image_entries = [(self.image_name, self.png), ("Images/cs/.DS_Store", b"metadata")]
        self.write_sources()

    def write_sources(self):
        contents = {
            "README.md": b"Original public source",
            "SciEGQA_Bench.jsonl": export.json_bytes(self.row).replace(b"\n", b" ") + b"\n",
            "PDF.tar": tar_bytes(self.pdf_entries),
            "Images.tar": tar_bytes(self.image_entries),
        }
        for pin in self.lock["files"]:
            data = contents[pin["path"]]
            (self.source / pin["path"]).write_bytes(data)
            pin.update(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())

    def prepare(self, verify=False):
        return export.prepare(self.source, self.output, verify, self.lock)

    def test_exact_export_preserves_original_rows_and_replays_read_only(self):
        manifest = self.prepare()
        labels = json.loads((self.output / "labels.json").read_bytes())
        self.assertEqual(labels[0]["original"], self.row)
        self.assertEqual(labels[0]["evidence"][0]["normalizedBbox"], [0.1, 0.1, 0.8, 0.3])
        self.assertEqual(labels[0]["status"], "published-image-regions-verified")
        self.assertEqual(labels[0]["originalPdfAlignment"], "pending")
        self.assertFalse(manifest["scientificBaselineReady"])
        self.assertEqual(manifest["pageImages"], 1)
        self.assertEqual(len(manifest["retainedArchiveMetadata"]), 1)
        self.assertFalse(any(".DS_Store" in name for name in inventory(self.output)))
        before, source_before = inventory(self.output), inventory(self.source)
        self.assertEqual(self.prepare(verify=True), manifest)
        self.assertEqual(inventory(self.output), before)
        self.assertEqual(inventory(self.source), source_before)

    def test_missing_pdf_image_and_invalid_coordinates_retain_question(self):
        self.pdf_entries = []
        self.image_entries = []
        self.row["rel_bbox"][0][0][2] = 1200
        self.write_sources()
        manifest = self.prepare()
        task = json.loads((self.output / "labels.json").read_bytes())[0]
        self.assertEqual(task["original"], self.row)
        self.assertEqual(task["status"], "unqualified-published-region")
        self.assertEqual(task["issues"], [
            "missing-original-pdf", "missing-evidence-image:1", "invalid-published-relative-region:1:0"])
        self.assertIsNone(task["evidence"][0]["pageImage"])
        self.assertEqual(manifest["tasks"], 1)
        self.assertNotIn("answerable", task)

    def test_invalid_pixel_regions_and_coordinate_mismatch_are_explicit(self):
        self.row["bbox"][0][0] = [10, 20, 180, 60]
        self.write_sources()
        self.prepare()
        task = json.loads((self.output / "labels.json").read_bytes())[0]
        self.assertIn("invalid-published-pixel-region:1:0", task["issues"])
        self.assertIn("published-coordinate-mismatch:1:0", task["issues"])
        self.assertEqual(task["original"], self.row)

    def test_duplicate_published_pages_keep_distinct_region_ids(self):
        self.row["evidence_page"] *= 2
        for key in ("bbox", "rel_bbox", "subimg_type"):
            self.row[key] *= 2
        self.write_sources()
        self.prepare()
        task = json.loads((self.output / "labels.json").read_bytes())[0]
        self.assertIn("duplicate-published-evidence-page", task["issues"])
        self.assertEqual(len({e["id"] for e in task["evidence"]}), 2)

    def test_invalid_archives_are_rejected_without_extracting_paths(self):
        cases = [
            [("../escape", b"escape")],
            [("/absolute", b"escape")],
            [(self.image_name, tarfile.SYMTYPE)],
            [(self.image_name, tarfile.LNKTYPE)],
            [(self.image_name, self.png), (self.image_name, self.png)],
            [("Images/cs/2301.00001/unknown.jpg", b"unknown")],
            [(self.image_name, b"truncated png")],
        ]
        for entries in cases:
            with self.subTest(entries=entries):
                self.image_entries = entries
                self.write_sources()
                self.output = self.base / f"output-{cases.index(entries)}"
                with self.assertRaisesRegex(ValueError, "(archive_member|image_invalid)"):
                    self.prepare()
                self.assertFalse((self.base / "escape").exists())

    def test_sources_must_match_lock_before_export(self):
        for filename in ("SciEGQA_Bench.jsonl", "PDF.tar", "Images.tar"):
            with self.subTest(filename=filename):
                self.write_sources()
                (self.source / filename).write_bytes(b"corrupt")
                with self.assertRaisesRegex(ValueError, "source_changed"):
                    self.prepare()
                self.assertFalse(self.output.exists())

    def test_tampered_labels_images_and_extra_outputs_are_rejected_and_preserved(self):
        for name in ("labels.json", "images/cs/2301.00001/2301.00001_1.png", "extra.txt"):
            with self.subTest(name=name):
                self.output = self.base / f"tamper-{len(name)}"
                self.prepare()
                target = self.output / name
                target.write_bytes(b"tampered")
                before = inventory(self.output)
                with self.assertRaisesRegex(ValueError, "(export_changed|export_inventory_changed)"):
                    self.prepare(verify=True)
                self.assertEqual(inventory(self.output), before)

    def test_overlap_and_symlinks_are_rejected_before_creation(self):
        for target in (self.source, self.source / "new-child", self.base):
            with self.subTest(target=target):
                before = inventory(self.source)
                with self.assertRaisesRegex(ValueError, "overlaps_sources"):
                    export.prepare(self.source, target, lock=self.lock)
                self.assertEqual(inventory(self.source), before)
        self.assertFalse((self.source / "new-child").exists())
        linked = self.base / "linked"
        linked.symlink_to(self.source, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "path_invalid"):
            export.prepare(self.source, linked / "child", lock=self.lock)
        self.prepare()
        original = self.output / "labels.json"
        original.unlink()
        original.symlink_to(self.source / "SciEGQA_Bench.jsonl")
        with self.assertRaisesRegex(ValueError, "path_invalid"):
            self.prepare(verify=True)

    def test_invalid_schema_or_counts_are_not_silently_filtered(self):
        for change in ({"answer": ""}, {"evidence_page": [True]}, {"bbox": []},
                       {"subimg_type": [["equation"]]}, {"doc_name": 2301}):
            with self.subTest(change=change):
                original = copy.deepcopy(self.row)
                self.row.update(change)
                self.write_sources()
                with self.assertRaisesRegex(ValueError, "label_invalid"):
                    self.prepare()
                self.row = original
        self.write_sources()
        self.lock["expectedRows"] = 2
        with self.assertRaisesRegex(ValueError, "label_count_changed"):
            self.prepare()

    def test_lock_hash_matches_evaluation_canonical_hash(self):
        actual = json.loads(export.sources.LOCK.read_bytes())
        self.assertEqual(export.lock_hash(actual),
                         "71a265bab51d8354021eea87c38f53dc990d8c1d1a83b91e726a88ec91cbfd60")


if __name__ == "__main__":
    unittest.main()
