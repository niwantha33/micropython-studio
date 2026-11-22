"""Regression tests for simulator archive extraction safety."""
import importlib.util
import pathlib
import stat
import tempfile
import unittest
import zipfile

MODULE = pathlib.Path(__file__).resolve().parents[1] / "src" / "safe_extract.py"
spec = importlib.util.spec_from_file_location("safe_extract", MODULE)
safe_extract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(safe_extract)


class SafeExtractionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="mps-zip-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        self.zip_path = self.root / "artifact.zip"
        self.target = self.root / "out"

    def _write_zip(self, entries):
        with zipfile.ZipFile(self.zip_path, "w") as archive:
            for name, content in entries:
                archive.writestr(name, content)

    def test_extracts_normal_files(self):
        self._write_zip([("qemu/bin/launcher", b"binary")])
        safe_extract.extract_archive(self.zip_path, self.target)
        self.assertEqual((self.target / "qemu/bin/launcher").read_bytes(), b"binary")

    def test_rejects_parent_traversal_without_creating_files(self):
        self._write_zip([("../escape.txt", b"bad"), ("normal.txt", b"ok")])
        with self.assertRaisesRegex(ValueError, "Unsafe ZIP path"):
            safe_extract.extract_archive(self.zip_path, self.target)
        self.assertFalse((self.root / "escape.txt").exists())
        self.assertFalse((self.target / "normal.txt").exists())

    def test_rejects_windows_drive_paths(self):
        self._write_zip([("C:/evil", b"bad")])
        with self.assertRaisesRegex(ValueError, "Unsafe ZIP path"):
            safe_extract.extract_archive(self.zip_path, self.target)

    def test_rejects_symlinks(self):
        link = zipfile.ZipInfo("escape-link")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        with zipfile.ZipFile(self.zip_path, "w") as archive:
            archive.writestr(link, "../outside")
        with self.assertRaisesRegex(ValueError, "symlinks"):
            safe_extract.extract_archive(self.zip_path, self.target)

    def test_rejects_oversized_uncompressed_metadata(self):
        old_limit = safe_extract.MAX_FILE_BYTES
        try:
            safe_extract.MAX_FILE_BYTES = 1
            self._write_zip([("big.txt", b"too large")])
            with self.assertRaisesRegex(ValueError, "size limit"):
                safe_extract.extract_archive(self.zip_path, self.target)
        finally:
            safe_extract.MAX_FILE_BYTES = old_limit


if __name__ == "__main__":
    unittest.main()
