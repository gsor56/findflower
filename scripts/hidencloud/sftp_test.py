import importlib.util
import io
from pathlib import Path
import stat
import sys
import tempfile
import types
import unittest

# Exercise transfer safety without a network connection or installed Paramiko.
sys.modules.setdefault('paramiko', types.ModuleType('paramiko'))
spec = importlib.util.spec_from_file_location('deploy_sftp', Path(__file__).with_name('sftp.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class MemorySFTP:
    def __init__(self):
        self.files = {'how.html': b'original'}
        self.fail_install = False

    def lstat(self, name):
        if name == '.':
            return types.SimpleNamespace(st_mode=stat.S_IFDIR)
        if name not in self.files:
            raise FileNotFoundError(name)
        return types.SimpleNamespace(st_mode=stat.S_IFREG)

    def open(self, name, mode):
        if mode == 'rb':
            return io.BytesIO(self.files[name])
        owner = self
        class Writer(io.BytesIO):
            def close(self):
                owner.files[name] = self.getvalue()
                super().close()
        return Writer()

    def posix_rename(self, source, target):
        raise OSError('Unsupported')

    def rename(self, source, target):
        if self.fail_install and source.endswith('.ff-upload'):
            raise OSError('Simulated interruption')
        if target in self.files:
            raise OSError('Already exists')
        self.files[target] = self.files.pop(source)

    def remove(self, name):
        del self.files[name]


class TransferSafety(unittest.TestCase):
    def test_hidencloud_rename_installs_verified_bytes(self):
        sftp = MemorySFTP()
        deploy.atomic_write(sftp, 'how.html', b'new')
        self.assertEqual(sftp.files, {'how.html': b'new'})

    def test_failed_replacement_restores_original(self):
        sftp = MemorySFTP()
        sftp.fail_install = True
        with self.assertRaises(OSError):
            deploy.atomic_write(sftp, 'how.html', b'new')
        self.assertEqual(sftp.files['how.html'], b'original')

    def test_recovery_copy_is_never_overwritten(self):
        sftp = MemorySFTP()
        sftp.files['how.html.ff-previous'] = b'pending recovery'
        with self.assertRaises(RuntimeError):
            deploy.atomic_write(sftp, 'how.html', b'new')
        self.assertEqual(sftp.files['how.html.ff-previous'], b'pending recovery')

    def test_manifest_paths_cannot_escape_root(self):
        for name in ['../.env', '/etc/passwd', 'assets/../../.env', 'assets\\..\\.env']:
            with self.assertRaises(RuntimeError):
                deploy.safe_path(name)


if __name__ == '__main__':
    unittest.main()
