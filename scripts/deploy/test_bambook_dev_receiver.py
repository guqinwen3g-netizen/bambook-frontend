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

    def test_node_version_pin_is_required(self):
        with self.assertRaises(ValueError):
            receiver.validate_members([item for item in self.valid() if item.name != '.nvmrc'])

    def test_other_root_files_are_rejected(self):
        for name in ['.env', 'package.json', '.nvmrc.bak']:
            with self.subTest(path=name), self.assertRaises(ValueError):
                receiver.validate_members(self.valid() + [entry(name)])

    def test_incomplete_bundle_is_rejected(self):
        with self.assertRaises(ValueError):
            receiver.validate_members([entry('server/package.json')])


import os, tempfile, time
from unittest import mock

class ActivationBudgetTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.patches = [mock.patch.object(receiver, 'ROOT', self.tmp), mock.patch.object(receiver, 'MARKER', self.tmp / '.activation.json'), mock.patch.object(receiver, 'ACTIVATE_TIMEOUT', 2), mock.patch.object(receiver, 'KILL_GRACE', 1)]
        for p in self.patches: p.start()
        self.run = mock.patch.object(receiver.subprocess, 'run').start()
        self.old = self.tmp / 'releases' / ('a' * 40); self.new = self.tmp / 'releases' / ('b' * 40)
        for r in (self.old, self.new): (r / 'scripts/deploy').mkdir(parents=True)
        (self.tmp / 'current').symlink_to(self.old)
    def tearDown(self):
        mock.patch.stopall()
    def script(self, body):
        (self.new / 'scripts/deploy/bambook-dev-release.sh').write_text(body)

    def test_timeout_kills_grandchildren_and_restores_previous_after_switch(self):
        late = self.tmp / 'late'
        self.script(f"""trap '' TERM
printf '{{"previous": "{self.old}", "release": "{self.new}"}}' > {self.tmp}/.activation.json
ln -sfn {self.new} {self.tmp}/current
(sleep 4; touch {late}) &
sleep 30
""")
        with self.assertRaisesRegex(ValueError, 'exceeded'):
            receiver.activate(self.new)
        self.assertEqual(os.readlink(self.tmp / 'current'), str(self.old))
        self.assertFalse((self.tmp / '.activation.json').exists())
        self.assertTrue(any('restart' in c.args[0] for c in self.run.call_args_list))
        time.sleep(4.5)
        self.assertFalse(late.exists(), 'grandchild survived the timeout')

    def test_timeout_before_switch_keeps_current_untouched(self):
        self.script('sleep 30\n')
        with self.assertRaises(ValueError):
            receiver.activate(self.new)
        self.assertEqual(os.readlink(self.tmp / 'current'), str(self.old))
        self.run.assert_not_called()

    def test_successful_script_needs_no_recovery(self):
        self.script('exit 0\n')
        receiver.activate(self.new)
        self.run.assert_not_called()

    def test_failed_script_reports_exit_code(self):
        self.script('exit 3\n')
        with self.assertRaisesRegex(ValueError, 'exited with 3'):
            receiver.activate(self.new)

if __name__ == '__main__':
    unittest.main()
