import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "lease", Path(__file__).parents[1] / "ci-lease.py"
)
lease = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lease)


class LeaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name)
        self.identity = {
            "pid": os.getpid(),
            "started": lease.process_stamp(os.getpid()),
            "repo": "a/a",
            "run": "1",
        }

    def test_busy_owner_blocks_other_repository_and_cannot_be_released_by_it(self):
        child = subprocess.Popen(["/bin/sleep", "30"])
        self.addCleanup(child.wait)
        self.addCleanup(child.terminate)
        other = {
            "pid": child.pid,
            "started": lease.process_stamp(child.pid),
            "repo": "b/b",
            "run": "2",
        }
        self.assertTrue(lease.update(self.identity, True, self.state))
        self.assertFalse(lease.update(other, True, self.state))
        self.assertTrue(lease.is_owner(self.identity, self.state))
        self.assertFalse(lease.is_owner(other, self.state))
        lease.update(other, False, self.state)
        self.assertFalse(lease.update(other, True, self.state))
        lease.update(self.identity, False, self.state)
        self.assertTrue(lease.update(other, True, self.state))

    def test_parallel_processes_cannot_both_acquire(self):
        program = """import importlib.util,os,pathlib,sys
spec=importlib.util.spec_from_file_location('lease',sys.argv[1])
lease=importlib.util.module_from_spec(spec);spec.loader.exec_module(lease)
identity={'pid':os.getpid(),'started':lease.process_stamp(os.getpid())}
print(lease.update(identity,True,pathlib.Path(sys.argv[2])),flush=True)
sys.stdin.readline()
"""
        children = [
            subprocess.Popen(
                [
                    sys.executable,
                    "-c",
                    program,
                    str(Path(__file__).parents[1] / "ci-lease.py"),
                    str(self.state),
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                text=True,
            )
            for _ in range(2)
        ]
        try:
            self.assertEqual(
                sorted(c.stdout.readline().strip() for c in children), ["False", "True"]
            )
        finally:
            for child in children:
                child.communicate("done\n", timeout=5)

    def test_dead_owner_and_reused_pid_are_recovered(self):
        for owner in [
            {"pid": 99999999, "started": "gone"},
            {"pid": os.getpid(), "started": "different process birth"},
        ]:
            (self.state / "owner.json").write_text(json.dumps(owner))
            self.assertTrue(lease.update(self.identity, True, self.state))
            self.assertEqual(
                json.loads((self.state / "owner.json").read_text()), self.identity
            )

    def test_corrupt_state_fails_closed(self):
        (self.state / "owner.json").write_text("bad json")
        with self.assertRaises(ValueError):
            lease.update(self.identity, True, self.state)

    def test_reentrant_lease_and_safe_release(self):
        self.assertTrue(lease.update(self.identity, True, self.state))
        self.assertTrue(lease.update(self.identity, True, self.state))
        self.assertEqual((self.state / "owner.json").stat().st_mode & 0o777, 0o600)
        lease.update(self.identity, False, self.state)
        self.assertFalse((self.state / "owner.json").exists())

    def test_rejects_execution_outside_runner_worker(self):
        pid = os.getpid()
        ppid = os.getppid()
        fake = f"{ppid} 1 bash\n{pid} {ppid} python3\n"
        with patch.object(lease.subprocess, "check_output", return_value=fake):
            with self.assertRaises(RuntimeError) as caught:
                lease.worker_identity()
        self.assertIn("Runner.Worker", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
