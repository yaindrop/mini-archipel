import importlib.util
import json
import os
import shutil
import signal
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "lease", Path(__file__).parents[1] / "ci-lease.py"
)
lease = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lease)


class RunnerPolicyTests(unittest.TestCase):
    """Real isolated processes; never connect to Actions or touch installed runners."""

    @classmethod
    def setUpClass(cls):
        cls.build = tempfile.TemporaryDirectory()
        cls.binary = Path(cls.build.name) / "probe"
        subprocess.run(
            ["/usr/bin/clang", "-x", "c", "-", "-o", cls.binary],
            input="#include <unistd.h>\nint main(void) { for (;;) pause(); }\n",
            text=True,
            check=True,
        )

    @classmethod
    def tearDownClass(cls):
        cls.build.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        self.state = self.home / ".local/state/mini-archipel/ci"
        self.children = []
        hooks = self.home / ".local/libexec/mini-archipel/ci"
        hooks.mkdir(parents=True)
        for name in ("job-started.sh", "job-completed.sh"):
            (hooks / name).write_text("#!/bin/bash\nexit 0\n")
        for name in ("a", "b", "manual"):
            directory = self.home / "runners" / name
            (directory / "bin").mkdir(parents=True)
            (directory / ".runner").write_text(
                json.dumps({"gitHubUrl": "https://github.com/owner/" + name})
            )
            (directory / ".env").write_text(
                f"ACTIONS_RUNNER_HOOK_JOB_STARTED={hooks / 'job-started.sh'}\n"
                f"ACTIONS_RUNNER_HOOK_JOB_COMPLETED={hooks / 'job-completed.sh'}\n"
            )
            for executable in ("Runner.Listener", "Runner.Worker"):
                shutil.copy2(self.binary, directory / "bin" / executable)
        self.a = self.spawn("a", "Runner.Listener")
        self.b = self.spawn("b", "Runner.Listener")
        self.worker = self.spawn("a", "Runner.Worker")
        self.state.mkdir(parents=True)
        self.owner = {
            "pid": self.worker.pid,
            "started": lease.process_stamp(self.worker.pid),
            "repo": "owner/a",
        }
        lease.save(self.state / "owner.json", self.owner)
        self.addCleanup(self.cleanup_children)

    def spawn(self, directory, executable):
        child = subprocess.Popen(
            [self.home / "runners" / directory / "bin" / executable]
        )
        self.children.append(child)
        return child

    def cleanup_children(self):
        for child in self.children:
            if child.poll() is None:
                child.kill()
            child.wait()

    def status(self, enable=None):
        return lease.coordination(enable, self.state, self.home)

    def stopped(self, child):
        return lease.process_table()[child.pid]["stopped"]

    def test_local_pause_and_completion_restore_only_previously_running_peers(self):
        self.assertFalse(self.status()["enabled"])
        self.assertFalse(self.stopped(self.b))
        state = self.status(True)
        self.assertEqual(state["paused"], ["b"])
        self.assertEqual(state["active_repo"], "owner/a")
        self.assertTrue(self.stopped(self.b))
        self.assertFalse(self.stopped(self.a))
        self.assertFalse(self.stopped(self.worker))
        self.assertEqual(
            (self.state / "runner-policy.json").stat().st_mode & 0o777, 0o600
        )
        with patch.object(lease.Path, "home", return_value=self.home):
            lease.update(self.owner, False, self.state)
        self.assertFalse(self.stopped(self.b))
        self.assertEqual(self.status()["paused"], [])
        self.assertFalse(
            any(
                p["command"].endswith("/manual/bin/Runner.Listener")
                for p in lease.process_table().values()
            )
        )

    def test_disabling_during_job_resumes_peers_and_does_not_interrupt_worker(self):
        self.status(True)
        state = self.status(False)
        self.assertFalse(state["enabled"])
        self.assertFalse(self.stopped(self.b))
        self.assertIsNone(self.worker.poll())
        self.assertEqual(state["paused"], [])

    def test_dead_owner_recovers_after_reload_and_stale_pids_are_not_signalled(self):
        self.status(True)
        self.worker.terminate()
        self.worker.wait()
        self.assertEqual(self.status()["paused"], [])
        self.assertFalse(self.stopped(self.b))
        value = lease.policy(self.state)
        value["paused"]["b"] = {"pid": self.b.pid, "started": "reused PID"}
        lease.save(self.state / "runner-policy.json", value)
        with patch.object(lease.os, "kill", wraps=os.kill) as kill:
            self.status()
            kill.assert_not_called()

    def test_waiting_job_keeps_its_listener_available_for_cancellation(self):
        waiting = self.spawn("b", "Runner.Worker")
        state = self.status(True)
        self.assertEqual(state["waiting"], ["b"])
        self.assertFalse(self.stopped(self.b))
        self.assertIsNone(waiting.poll())

    def test_external_pause_is_not_owned_and_cannot_be_automatically_resumed(self):
        os.kill(self.b.pid, signal.SIGSTOP)
        self.assertEqual(self.status(True)["paused"], [])
        self.status(False)
        self.assertTrue(self.stopped(self.b))

    def test_journal_recovery_and_failed_write_before_signal(
        self,
    ):
        value = {
            "enabled": True,
            "paused": {
                "b": {"pid": self.b.pid, "started": lease.process_stamp(self.b.pid)}
            },
        }
        lease.save(self.state / "runner-policy.json", value)
        self.status()
        self.assertTrue(self.stopped(self.b))
        self.status(False)
        with patch.object(lease, "save", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.status(True)
        self.assertFalse(self.stopped(self.b))

    def test_missing_hooks_and_malformed_commands_are_rejected(self):
        (self.home / "runners/manual/.env").unlink()
        self.assertFalse(self.status()["available"])
        with self.assertRaises(RuntimeError):
            self.status(True)
        for name in ("../a", "/a", "..", "a/b"):
            with self.assertRaises(ValueError):
                lease.service(
                    {"repo": "owner/a", "runner": name, "enable": True},
                    self.state,
                    self.home,
                )

    def test_manual_stop_of_a_paused_runner_is_not_reversed(self):
        agents = self.home / "Library/LaunchAgents"
        agents.mkdir(parents=True)
        (self.home / "runners/b/.service").write_text(
            str(agents / "actions.runner.fixture.b.plist")
        )
        self.status(True)
        with self.assertRaises(RuntimeError):
            lease.service(
                {"repo": "owner/b", "runner": "b", "enable": True},
                self.state,
                self.home,
            )
        original_run = subprocess.run
        calls = []

        def launch(args, **kwargs):
            if args[0] != "/bin/launchctl":
                return original_run(args, **kwargs)
            calls.append(args[1:])
            if args[1] == "bootout":
                self.b.terminate()
            return subprocess.CompletedProcess(args, 0)

        with patch.object(lease.subprocess, "run", side_effect=launch):
            lease.service(
                {"repo": "owner/b", "runner": "b", "enable": False},
                self.state,
                self.home,
            )
        self.b.wait(timeout=3)
        self.assertEqual([args[0] for args in calls], ["disable", "print", "bootout"])
        (self.state / "owner.json").unlink()
        self.assertEqual(self.status()["paused"], [])
        self.assertIsNotNone(self.b.returncode)


if __name__ == "__main__":
    unittest.main()
