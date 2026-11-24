"""Upload completion tests: fake serial transport, no hardware or network."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import types
import unittest


SOURCE = Path(__file__).resolve().parents[1] / 'src' / 'mps_backend.py'


def load_backend():
    stub = types.ModuleType('ollama_helper')
    stub.OllamaHelper = type('OllamaHelper', (), {})
    original = sys.modules.get('ollama_helper')
    sys.modules['ollama_helper'] = stub
    try:
        spec = importlib.util.spec_from_file_location('_mps_upload_test_backend', SOURCE)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        if original is None:
            sys.modules.pop('ollama_helper', None)
        else:
            sys.modules['ollama_helper'] = original


class UploadCompletionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.backend = load_backend()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def _device(self, reply):
        device = self.backend.SerialConnection('COM7')
        device.enter_raw_repl = lambda soft_reset=False: True
        device._exit_raw_repl = lambda: None
        device._exec_raw_no_exit = lambda code, **kwargs: (0, reply, b'')
        return device

    def test_package_logs_never_expose_webrepl_password(self):
        self.assertEqual(
            self.backend._safe_package_port_label('ws:192.168.1.2,private-secret'),
            'ws:192.168.1.2 [credential hidden]')
        self.assertEqual(self.backend._safe_package_port_label('COM7'), 'COM7')

    def test_package_download_must_contain_actual_files(self):
        package_dir = self.root / 'lib'
        package_dir.mkdir()
        self.assertFalse(self.backend._has_package_files(package_dir))
        self.assertFalse(self.backend._has_package_files(self.root / 'missing'))
        (package_dir / 'lib').mkdir()
        (package_dir / 'lib' / 'module.py').write_text('a = 1')
        self.assertTrue(self.backend._has_package_files(package_dir))

    def test_single_file_requires_matching_byte_count_from_target(self):
        source = self.root / 'main.py'
        source.write_bytes(b'abc')
        commands = []
        device = self._device(b'OK_PUT:3\r\n')
        device._exec_raw_no_exit = lambda code, **kwargs: (
            commands.append(code) or 0, b'OK_PUT:3\r\n', b''
        )
        self.assertEqual(device.put_file(source, '/main.py'), 0)
        self.assertIn('Upload size mismatch', commands[-1])
        self.assertIn("print('OK_PUT:3')", commands[-1])

        device = self._device(b'OK_PUT\r\n')
        self.assertNotEqual(device.put_file(source, '/main.py'), 0)
        device = self._device(b'OK_PUT:2\r\n')
        self.assertNotEqual(device.put_file(source, '/main.py'), 0)

    def test_internal_folder_file_requires_matching_target_ack(self):
        source = self.root / 'config.py'
        source.write_bytes(b'a=2\n')
        code_seen = []
        device = self._device(b'OK_PUT:4\r\n')
        device._exec_raw_no_exit = lambda code, **kwargs: (
            code_seen.append(code) or 0, b'OK_PUT:4\r\n', b''
        )
        self.assertEqual(device._put_file_internal(source, '/lib/config.py'), 0)
        self.assertIn('Upload size mismatch', code_seen[-1])

        device = self._device(b'OK_PUT')
        self.assertEqual(device._put_file_internal(source, '/lib/config.py'), 1)

    def test_folder_aborts_on_failed_file_and_always_exits_raw_repl(self):
        (self.root / 'a.py').write_text('a=1')
        (self.root / 'b.py').write_text('b=1')
        seen = []
        exited = []
        device = self._device(b'')
        device._put_file_internal = lambda path, target: (
            seen.append(target) or (1 if path.name == 'b.py' else 0)
        )
        device._exit_raw_repl = lambda: exited.append(True)
        with self.assertRaisesRegex(RuntimeError, 'folder upload incomplete'):
            device.put_directory(self.root, '/')
        self.assertEqual(seen, ['/a.py', '/b.py'])
        self.assertEqual(exited, [True])
        # The exception reaches cmd_upload and results in nonzero backend exit.

    def test_folder_succeeds_only_if_all_files_confirmed(self):
        (self.root / 'a.py').write_text('a=1')
        (self.root / 'b.py').write_text('b=1')
        seen = []
        device = self._device(b'')
        device._put_file_internal = lambda path, target: (seen.append(target) or 0)
        device.put_directory(self.root, '/')
        self.assertEqual(seen, ['/a.py', '/b.py'])


if __name__ == '__main__':
    unittest.main()
