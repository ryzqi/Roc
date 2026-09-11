import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

WORKER = Path(__file__).resolve().parents[3] / "resources/research-runtime/worker.py"
spec = importlib.util.spec_from_file_location("research_worker", WORKER)
worker = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = worker
spec.loader.exec_module(worker)


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.source = self.root / "paper.pdf"
        self.source.write_bytes(b"invalid pdf")
        self.request = {"operation": "render_pdf", "projectRoot": str(self.root), "sourcePath": str(self.source),
                        "outputDir": str(self.root / "render"), "page": 1, "scale": 1.5}

    def tearDown(self):
        self.temporary.cleanup()

    def test_does_not_overwrite_existing_output(self):
        output = self.root / "render"
        output.mkdir()
        (output / "page-1.png").write_bytes(b"keep")
        with self.assertRaisesRegex(ValueError, "output_already_exists"):
            worker.parse_request(self.request)
        self.assertEqual((output / "page-1.png").read_bytes(), b"keep")

    def test_rejects_path_traversal_and_symlinked_parent(self):
        with tempfile.TemporaryDirectory() as external:
            outside = Path(external).resolve()
            (outside / "paper.pdf").write_bytes(b"outside")
            (self.root / "linked").symlink_to(outside, target_is_directory=True)
            for source in [str(outside / "paper.pdf"), str(self.root / "linked/paper.pdf")]:
                with self.subTest(source=source), self.assertRaisesRegex(ValueError, "outside_project"):
                    worker.parse_request({**self.request, "sourcePath": source})
            with self.assertRaisesRegex(ValueError, "outside_project"):
                worker.parse_request({**self.request, "outputDir": str(outside / "new-output")})
            self.assertFalse((outside / "new-output").exists())

    def test_rejects_missing_extra_and_ill_typed_fields_before_side_effects(self):
        for change in [{"page": True}, {"scale": float("nan")}, {"scale": float("inf")}, {"scale": 4.1}, {"page": 0}]:
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, "render_options_invalid"):
                worker.parse_request({**self.request, **change})
        for value in [{**self.request, "extra": 1}, {key: value for key, value in self.request.items() if key != "page"}]:
            with self.assertRaisesRegex(ValueError, "fields_invalid"):
                worker.parse_request(value)
        self.assertFalse((self.root / "render").exists())

    def test_failed_decode_removes_only_the_new_output(self):
        keep = self.root / "keep.txt"
        keep.write_text("keep", encoding="utf-8")
        with self.assertRaises(Exception):
            worker.execute(worker.parse_request(self.request))
        self.assertFalse((self.root / "render").exists())
        self.assertEqual(keep.read_text(), "keep")

    def test_json_boundary_returns_explicit_error_without_traceback_in_stdout(self):
        result = subprocess.run([sys.executable, "-I", "-B", str(WORKER)], input=json.dumps({"operation": "unknown"}),
                                text=True, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout), {"ok": False, "error": {"code": "research_operation_unknown", "type": "ValueError"}})

    def test_worker_uses_bundled_mime_types_without_reading_host_configuration(self):
        host = self.root / "host-mime.types"
        host.write_text("application/host-only host-only-extension", encoding="utf-8")
        script = """import builtins, mimetypes, runpy, sys
mimetypes.knownfiles = [sys.argv[2]]
original = builtins.open
def guarded(path, *args, **kwargs):
    if str(path) == sys.argv[2]:
        raise PermissionError('host MIME file denied by sandbox')
    return original(path, *args, **kwargs)
builtins.open = guarded
runpy.run_path(sys.argv[1])
mimetypes.add_type('application/x-test', '.test')
assert mimetypes.guess_type('paper.pdf')[0] == 'application/pdf'
"""
        result = subprocess.run([sys.executable, "-I", "-B", "-c", script, str(WORKER), str(host)], text=True, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_renders_real_pdf_and_rejects_out_of_range_page(self):
        import pypdfium2 as pdfium

        with pdfium.PdfDocument.new() as pdf:
            page = pdf.new_page(200, 100)
            page.close()
            pdf.save(self.source)
        request = worker.parse_request({**self.request, "scale": 2})
        result = worker.execute(request)
        self.assertEqual((result["width"], result["height"], result["pageCount"]), (400, 200, 1))
        self.assertEqual(result["sourceHash"], worker.file_hash(self.source))
        self.assertEqual(Path(result["path"]).read_bytes()[:8], b"\x89PNG\r\n\x1a\n")
        with self.assertRaisesRegex(ValueError, "page_out_of_range"):
            worker.execute(worker.parse_request({**self.request, "page": 2, "outputDir": str(self.root / "invalid-page")}))
        self.assertFalse((self.root / "invalid-page").exists())

    def test_rejects_oversized_page_before_loading_ocr_models(self):
        import pypdfium2 as pdfium

        with pdfium.PdfDocument.new() as pdf:
            page = pdf.new_page(60_000, 60_000)
            page.close()
            pdf.save(self.source)
        (self.root / "models").mkdir()
        request = {key: value for key, value in self.request.items() if key not in {"page", "scale"}}
        request.update(operation="parse_document", modelsPath=str(self.root / "models"))
        with self.assertRaisesRegex(ValueError, "document_page_too_large"):
            worker.execute(worker.parse_request(request))
        self.assertFalse((self.root / "render").exists())


if __name__ == "__main__":
    unittest.main()
