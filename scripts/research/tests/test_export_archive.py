import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile


SOURCE = Path(__file__).resolve().parents[3] / "resources/research-runtime/export-archive.py"
SPEC = importlib.util.spec_from_file_location("roc_export_archive", SOURCE)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("export_archive_module_required")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ExportArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="roc-export-archive-")
        self.root = Path(self.temporary.name)
        self.bundle = self.root / "bundle"
        self.bundle.mkdir()

    def tearDown(self):
        self.temporary.cleanup()

    def entry(self, name, content):
        return {"path": name, "size": len(content), "sha256": hashlib.sha256(content).hexdigest()}

    def test_keeps_unicode_paths_bytes_and_fixed_zip_metadata(self):
        content = "批准的正文\n".encode("utf-8")
        (self.bundle / "正文.tex").write_bytes(content)
        entries = [self.entry("正文.tex", content)]
        first, second = self.root / "first.zip", self.root / "second.zip"
        result = MODULE.create_archive(self.bundle, first, entries)
        MODULE.create_archive(self.bundle, second, entries)
        self.assertEqual(first.read_bytes(), second.read_bytes())
        self.assertEqual(result["sha256"], hashlib.sha256(first.read_bytes()).hexdigest())
        with zipfile.ZipFile(first) as archive:
            self.assertEqual(archive.read("正文.tex"), content)
            self.assertEqual(archive.getinfo("正文.tex").date_time, (1980, 1, 1, 0, 0, 0))
            self.assertIsNone(archive.testzip())

    def test_rejects_changed_files_and_existing_destinations(self):
        (self.bundle / "paper.tex").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "research_export_snapshot_changed"):
            MODULE.create_archive(self.bundle, self.root / "changed.zip", [self.entry("paper.tex", b"original")])
        destination = self.root / "existing.zip"
        destination.write_bytes(b"original delivery")
        with self.assertRaises(FileExistsError):
            MODULE.create_archive(self.bundle, destination, [self.entry("paper.tex", b"changed")])
        self.assertEqual(destination.read_bytes(), b"original delivery")

    def test_rejects_links_and_paths_outside_the_bundle(self):
        outside = self.root / "outside.txt"
        outside.write_bytes(b"outside sentinel")
        (self.bundle / "linked.txt").symlink_to(outside)
        for index, name in enumerate(("linked.txt", "../outside.txt", str(outside), "folder\\outside.txt")):
            with self.subTest(path=name), self.assertRaisesRegex(ValueError, "research_export_path_(?:invalid|symlink)"):
                MODULE.create_archive(self.bundle, self.root / f"invalid-{index}.zip", [self.entry(name, outside.read_bytes())])


if __name__ == "__main__":
    unittest.main()
