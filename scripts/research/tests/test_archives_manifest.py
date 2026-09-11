from io import BytesIO
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from archive_utils import convert_tex_bundle, extract_tool_archive
from manifest import verify_manifest, write_manifest


def make_archive(path: Path, entries: dict[str, bytes]):
    with tarfile.open(path, "w") as archive:
        for name, data in entries.items():
            member = tarfile.TarInfo(name)
            member.size = len(data)
            archive.addfile(member, BytesIO(data))


class ArchiveTests(unittest.TestCase):
    def test_converts_bundle_without_changing_contents(self):
        entries = {"SHA256SUM": b"a" * 64, "tectonic-format-latex.tex": b"\\input latex.ltx", "example.sty": b"license and contents"}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive, target = root / "source.tar", root / "bundle.zip"
            make_archive(archive, entries)
            convert_tex_bundle(archive, target)
            with zipfile.ZipFile(target) as result:
                self.assertEqual({name: result.read(name) for name in result.namelist()}, entries)
            with self.assertRaisesRegex(ValueError, "destination_exists"):
                convert_tex_bundle(archive, target)

    def test_bundle_rejects_paths_and_leaves_no_final_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            make_archive(root / "source.tar", {"../escape": b"bad"})
            with self.assertRaisesRegex(ValueError, "entry_invalid"):
                convert_tex_bundle(root / "source.tar", root / "bundle.zip")
            self.assertFalse((root / "bundle.zip").exists())
            self.assertFalse((root.parent / "escape").exists())

    def test_tar_rejects_symlink_escape(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with tarfile.open(root / "source.tar", "w") as archive:
                link = tarfile.TarInfo("escape")
                link.type = tarfile.SYMTYPE
                link.linkname = "../outside"
                archive.addfile(link)
            with self.assertRaises(tarfile.LinkOutsideDestinationError):
                extract_tool_archive(root / "source.tar", root / "output")
            self.assertFalse((root / "output/escape").exists())


class ManifestTests(unittest.TestCase):
    def test_detects_changed_extra_and_missing_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "worker.py"
            source.write_text("original", encoding="utf-8")
            write_manifest(root, architecture="arm64", versions={"python": "3.12.14"}, lock_hashes={})
            self.assertEqual(verify_manifest(root)["architecture"], "arm64")
            source.write_text("modified", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "integrity_mismatch"):
                verify_manifest(root)
            source.write_text("original", encoding="utf-8")
            extra = root / "extra"
            extra.touch()
            with self.assertRaisesRegex(ValueError, "integrity_mismatch"):
                verify_manifest(root)
            extra.unlink()
            source.unlink()
            with self.assertRaisesRegex(ValueError, "integrity_mismatch"):
                verify_manifest(root)

    def test_allows_internal_relative_links_and_rejects_external_links(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "python3.12").write_bytes(b"binary")
            (root / "python3").symlink_to("python3.12")
            write_manifest(root, architecture="arm64", versions={}, lock_hashes={})
            verify_manifest(root)
            (root / "escape").symlink_to(root.parent)
            with self.assertRaisesRegex(ValueError, "external_symlink"):
                verify_manifest(root)


if __name__ == "__main__":
    unittest.main()
