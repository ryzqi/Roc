import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("pin", Path(__file__).with_name("pin-ovis-wheels.py"))
pin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pin)


class WheelSelectionTests(unittest.TestCase):
    def metadata(self, tags="cp314-cp314-macosx_15_0_arm64", **changes):
        name = f"sample-1.0-{tags}.whl"
        entry = {"filename": name, "url": f"https://files.pythonhosted.org/packages/{name}",
                 "size": 100, "digests": {"sha256": "a" * 64}, "packagetype": "bdist_wheel",
                 "yanked": False, "requires_python": ">=3.14"}
        entry.update(changes)
        return {"info": {"name": "sample", "version": "1.0"}, "urls": [entry]}

    def test_fixed_interpreter_platform_and_hash_required(self):
        for tags in ("cp314-cp314-macosx_15_0_arm64", "cp39-abi3-macosx_14_0_arm64", "py3-none-any"):
            self.assertEqual(pin.select_wheel("sample", "1.0", {"a" * 64}, self.metadata(tags))["sha256"], "a" * 64)
        for metadata in (self.metadata("cp314-cp314-macosx_15_0_x86_64"),
                         self.metadata("cp314-cp314-macosx_16_0_arm64"), self.metadata("cp314-cp314t-macosx_15_0_arm64"),
                         self.metadata(digests={"sha256": "b" * 64}), self.metadata(yanked=True),
                         self.metadata(requires_python=">=3.15"), self.metadata(url="http://files.pythonhosted.org/a")):
            with self.assertRaises(ValueError):
                pin.select_wheel("sample", "1.0", {"a" * 64}, metadata)

    def test_exact_lock_refuses_direct_sources_options_and_duplicates(self):
        line = "sample==1.0 --hash=sha256:" + "a" * 64
        self.assertEqual(pin.read_lock(line), {"sample": ("1.0", {"a" * 64})})
        for content in ("", line + "\n" + line, "sample @ https://example.org/pkg", line + " --extra-index-url https://example.org"):
            with self.assertRaises(ValueError):
                pin.read_lock(content)


if __name__ == "__main__":
    unittest.main()
