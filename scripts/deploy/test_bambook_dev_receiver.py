import importlib.util
from pathlib import Path
import tarfile
import unittest

spec = importlib.util.spec_from_file_location('receiver', Path(__file__).with_name('bambook-dev-receiver.py'))
receiver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receiver)

def entry(name, kind=tarfile.REGTYPE, size=0):
    item = tarfile.TarInfo(name)
    item.type = kind
    item.size = size
    return item

class ArchiveBoundaryTests(unittest.TestCase):
    def valid(self):
        return [entry(name) for name in receiver.REQUIRED]

    def test_git_archive_directory_entries_are_accepted(self):
        receiver.validate_members([entry('server/', tarfile.DIRTYPE), entry('scripts/', tarfile.DIRTYPE), entry('scripts/deploy/', tarfile.DIRTYPE)] + self.valid())

    def test_escape_and_special_entries_are_rejected(self):
        for item in [entry('/etc/passwd'), entry('server/../../outside'), entry('server/link', tarfile.SYMTYPE), entry('server/link', tarfile.LNKTYPE), entry('server/device', tarfile.CHRTYPE), entry('unrelated.txt')]:
            with self.subTest(path=item.name, kind=item.type), self.assertRaises(ValueError):
                receiver.validate_members(self.valid() + [item])

    def test_normalized_duplicate_is_rejected(self):
        with self.assertRaises(ValueError):
            receiver.validate_members(self.valid() + [entry('server//package.json')])

    def test_expansion_limit_is_enforced(self):
        with self.assertRaises(ValueError):
            receiver.validate_members(self.valid() + [entry('server/huge', size=receiver.EXPANDED_LIMIT + 1)])

    def test_incomplete_bundle_is_rejected(self):
        with self.assertRaises(ValueError):
            receiver.validate_members([entry('server/package.json')])

if __name__ == '__main__':
    unittest.main()
