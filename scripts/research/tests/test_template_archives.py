from pathlib import Path
import stat
import tempfile
import unittest
import zipfile

from test_worker import worker


class TemplateArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name).resolve()
        self.root = self.base / "workspace"
        self.root.mkdir()
        self.archive = self.root / "template.zip"
        self.request = {"operation": "extract_template", "projectRoot": str(self.root),
                        "sourcePath": str(self.archive), "outputDir": str(self.root / "extracted")}

    def tearDown(self):
        self.temporary.cleanup()

    def test_extracts_nested_template_and_keeps_source_digest(self):
        with zipfile.ZipFile(self.archive, "w") as archive:
            archive.writestr("template/main.tex", "\\documentclass{article}")
            archive.writestr("template/references.bib", "@article{sample}")
        result = worker.execute(worker.parse_request(self.request))
        self.assertEqual(result, {"fileCount": 2, "sourceHash": worker.file_hash(self.archive)})
        self.assertEqual((self.root / "extracted/template/references.bib").read_text(), "@article{sample}")

    def test_rejects_path_traversal_without_overwriting_outside_file(self):
        outside = self.base / "escape.tex"
        outside.write_text("protected", encoding="utf-8")
        with zipfile.ZipFile(self.archive, "w") as archive:
            archive.writestr("../escape.tex", "bad")
        with self.assertRaisesRegex(ValueError, "archive_entry_invalid"):
            worker.execute(worker.parse_request(self.request))
        self.assertEqual(outside.read_text(), "protected")
        self.assertFalse((self.root / "extracted").exists())

    def test_rejects_symlink_members_and_case_collisions(self):
        link = zipfile.ZipInfo("link.tex")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        with zipfile.ZipFile(self.archive, "w") as archive:
            archive.writestr(link, "../secret")
        with self.assertRaisesRegex(ValueError, "archive_entry_invalid"):
            worker.execute(worker.parse_request(self.request))
        with zipfile.ZipFile(self.archive, "w") as archive:
            archive.writestr("Figures/a.pdf", "a")
            archive.writestr("figures/b.pdf", "b")
        with self.assertRaisesRegex(ValueError, "path_collision"):
            worker.execute(worker.parse_request(self.request))
        self.assertFalse((self.root / "extracted").exists())

    def test_rejects_excessive_member_count_before_writing_any_files(self):
        with zipfile.ZipFile(self.archive, "w") as archive:
            for index in range(5001):
                archive.writestr(f"{index}.tex", "")
        with self.assertRaisesRegex(ValueError, "archive_too_large"):
            worker.execute(worker.parse_request(self.request))
        self.assertFalse((self.root / "extracted").exists())


if __name__ == "__main__":
    unittest.main()
