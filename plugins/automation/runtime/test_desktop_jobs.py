import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import desktop_jobs as jobs
import chat_requests


class Jobs(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.patches = [patch.object(jobs, "ROOT", self.root),
                        patch.multiple(chat_requests, GUI_LOCK=self.root / "gui.lock", NATIVE_LOCK=self.root / "native.lock")]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.temp.cleanup()

    def request(self, **fields):
        return {"request_id": "job-1", "operation": "script", "mode": "exec", "path": "/usr/bin/true", **fields}

    def queued(self, request=None):
        with patch.object(subprocess, "Popen") as spawn:
            result = jobs.submit(request or self.request())
        return result, spawn

    def test_durable_duplicate_and_changed_content(self):
        result, spawn = self.queued()
        self.assertFalse(result["reused"])
        self.assertEqual(jobs.job_path("job-1").stat().st_mode & 0o777, 0o600)
        with patch.object(subprocess, "Popen") as again:
            self.assertTrue(jobs.submit(self.request())["reused"])
            again.assert_not_called()
        self.assertEqual(spawn.call_count, 1)
        with self.assertRaisesRegex(jobs.Failure, "different content"):
            jobs.submit(self.request(path="/bin/false"))

    def test_stale_worker_is_interrupted_never_restarted(self):
        self.queued()
        path = jobs.job_path("job-1")
        data = json.loads(path.read_text())
        data.update(status="running", updated_at=time.time() - 60)
        jobs.save(path, data)
        self.assertEqual(jobs.get("job-1")["status"], "interrupted")
        with patch.object(subprocess, "Popen") as spawn:
            self.assertTrue(jobs.submit(self.request())["reused"])
            spawn.assert_not_called()

    def test_running_worker_lock_prevents_false_interruption(self):
        self.queued()
        path = jobs.job_path("job-1")
        data = json.loads(path.read_text())
        data.update(status="running", updated_at=time.time() - 60)
        jobs.save(path, data)
        with jobs.lock(path.with_suffix(".work")):
            self.assertEqual(jobs.get("job-1")["status"], "running")

    def test_pause_stops_queued_dispatch_and_resume_allows_new_jobs(self):
        self.queued()
        jobs.coordinate(True)
        with patch.object(jobs, "command") as dispatch:
            jobs.worker("job-1")
            dispatch.assert_not_called()
        self.assertEqual(jobs.get("job-1")["status"], "failed")
        with self.assertRaisesRegex(jobs.Failure, "paused"):
            jobs.submit(self.request(request_id="job-2"))
        jobs.coordinate(False)
        self.assertFalse(self.queued(self.request(request_id="job-2"))[0]["reused"])

    def test_cancel_before_dispatch_and_diagnostics_redaction(self):
        self.queued(self.request(arguments=["private content"]))
        jobs.cancel("job-1")
        with patch.object(jobs, "command") as dispatch:
            jobs.worker("job-1")
            dispatch.assert_not_called()
        self.assertEqual(jobs.get("job-1")["status"], "cancelled")
        jobs.permission_result({"ok": True, "accessibility": False, "automation": False, "error": "private permission details"})
        self.assertNotIn("private content", json.dumps(jobs.diagnostics()))
        self.assertNotIn("private permission details", json.dumps(jobs.diagnostics()))

    def test_real_child_timeout_is_bounded(self):
        self.queued(self.request(timeout=1))
        with patch.object(jobs, "command", return_value=([sys.executable, "-c", "import time; time.sleep(30)"], None)):
            jobs.worker("job-1")
        job = jobs.get("job-1")
        self.assertEqual(job["result"]["status"], "timed_out")

    def test_literal_arguments_and_result(self):
        marker = "$(echo NEVER) `echo NEVER` 中文\nnext"
        request = self.request(arguments=[marker])
        argv, _ = jobs.command(request)
        self.assertEqual(argv[-1], marker)
        self.queued(request)
        with patch.object(jobs, "command", return_value=([sys.executable, "-c", "import json,sys; print(json.dumps({'ok':True,'value':sys.argv[1]}))", marker], None)):
            jobs.worker("job-1")
        self.assertEqual(jobs.get("job-1")["result"]["value"], marker)

    def test_rejects_invalid_ids_and_unsupported_commands(self):
        for job_id in ["../escape", "--help", "", "a/b"]:
            with self.assertRaises(jobs.Failure):
                jobs.validate(self.request(request_id=job_id))
        for fields in [{"operation": "shell"}, {"operation": []}, {"path": "relative"}, {"mode": []}, {"arguments": "sh"}, {"timeout": True}, {"extra": 1}]:
            with self.assertRaises(jobs.Failure):
                jobs.validate(self.request(**fields))

    def test_unknown_permission_is_preserved_and_install_lock_blocks_submit(self):
        result = jobs.permission_result({"ok": True, "accessibility": True, "automation": None, "automation_code": -600})
        self.assertIsNone(result["automation"])
        self.assertIsNone(jobs.status()["permissions"]["automation"])
        with jobs.lock(self.root / ".install.lock"):
            with self.assertRaisesRegex(jobs.Failure, "installation"):
                jobs.submit(self.request())

    def test_cancelling_permission_prompt_is_not_reported_as_a_check_failure(self):
        self.queued({"request_id": "job-1", "operation": "permissions", "permission": "accessibility"})
        with patch.object(subprocess, "run"), patch.object(jobs, "execute", return_value={"ok": False, "status": "cancelled"}):
            jobs.worker("job-1")
        self.assertEqual(jobs.get("job-1")["status"], "cancelled")

    def test_permission_success_requires_native_recheck_and_preserves_cancel(self):
        for index, (response, expected) in enumerate([
            ({"ok": False, "error": "helper unavailable"}, "needs_user"),
            ({"ok": False, "status": "cancelled"}, "cancelled"),
        ]):
            job_id = f"recheck-{index}"
            self.queued({"request_id": job_id, "operation": "permissions", "permission": "automation"})
            granted = {"ok": True, "accessibility": True, "automation": True}
            with patch.object(subprocess, "run"), patch.object(jobs, "execute", side_effect=[granted, response]):
                jobs.worker(job_id)
            self.assertEqual(jobs.get(job_id)["status"], expected)

    def test_exempt_version_query_cannot_complete_authorization(self):
        self.queued({"request_id": "job-1", "operation": "permissions", "permission": "automation"})
        granted = {"ok": True, "accessibility": True, "automation": True}
        denied = {"ok": False, "error": "Not authorized to send Apple events"}
        with patch.object(subprocess, "run"), patch.object(jobs, "execute", side_effect=[granted, denied]) as execute:
            jobs.worker("job-1")
        self.assertEqual(jobs.get("job-1")["status"], "needs_user")
        self.assertEqual(execute.call_args_list[1].args[0][1:], ["exec", str(jobs.SOURCE / "permissions")])

    def test_consent_connection_reset_is_verified_before_reporting_failure(self):
        self.queued({"request_id": "job-1", "operation": "permissions", "permission": "automation"})
        granted = {"ok": True, "accessibility": True, "automation": True}
        reset = {"ok": False, "accessibility": True, "automation": False, "apple_script_error": -609, "error": "Connection is invalid"}
        with patch.object(subprocess, "run"), patch.object(jobs, "execute", side_effect=[reset, {**granted, "automation_verified": True}]):
            jobs.worker("job-1")
        self.assertEqual(jobs.get("job-1")["status"], "completed")

    def test_permission_scope_and_native_capability_are_independent(self):
        request={"request_id":"job-1","operation":"permissions","permission":"accessibility"}
        self.assertEqual(jobs.command(request)[0][1:], ["authorize","--permission","accessibility"])
        self.queued(request)
        pending={"ok":False,"accessibility":False,"automation":False}
        checked={"ok":True,"accessibility":True,"accessibility_verified":True,"automation":False,"automation_verified":False}
        with patch.object(subprocess,"run"),patch.object(jobs,"execute",side_effect=[pending,checked]):
            jobs.worker("job-1")
        self.assertEqual(jobs.get("job-1")["status"],"completed")
        self.assertEqual(jobs.status()["jobs"][0]["permission"],"accessibility")


if __name__ == "__main__":
    unittest.main()
