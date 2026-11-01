import json
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch
import desktop_jobs as jobs
import chat_requests


class InputJobs(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.patches = [patch.object(jobs, "native_input_installed", return_value=True), patch.object(jobs, "ROOT", self.root), patch.multiple(chat_requests, GUI_LOCK=self.root / "gui", NATIVE_LOCK=self.root / "native")]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.temp.cleanup()

    def request(self, action=None, **fields):
        return {"request_id":"input-1", "operation":"input", "mode":"execute", "target":{"bundle_id":"test.app", "pid":123, "window_id":456, "frame":{"x":10,"y":20,"width":800,"height":600}, "observed_at_ms":time.time()*1000}, "coordinates":{"space":"window","unit":"points"}, "action":action or {"kind":"click","x":200,"y":200}, **fields}

    def test_old_companion_does_not_advertise_or_dispatch_native_input(self):
        with patch.object(jobs,"native_input_installed",return_value=False), patch.object(subprocess,"Popen") as spawn:
            self.assertNotIn("input",jobs.status()["capabilities"])
            with self.assertRaisesRegex(jobs.Failure,"upgraded Automation"):
                jobs.submit(self.request())
            with self.assertRaisesRegex(jobs.Failure,"upgraded Automation"):
                jobs.input_info()
            spawn.assert_not_called()

    def test_validated_actions_are_at_most_once_with_existing_jobs(self):
        request = self.request()
        with patch.object(subprocess,"Popen") as spawn:
            first = jobs.submit(request)
            self.assertFalse(first["reused"])
            self.assertTrue(jobs.submit(request)["reused"])
            self.assertEqual(spawn.call_count,1)
        self.assertEqual(jobs.command(request), ([str(jobs.RUNNER),"input",str(jobs.job_path("input-1"))],None))
        changed = json.loads(json.dumps(request)); changed["action"]["x"] += 1
        with self.assertRaisesRegex(jobs.Failure,"different content"):
            jobs.submit(changed)
        self.assertEqual(jobs.job_path("input-1").stat().st_mode & 0o777,0o600)

    def test_input_boundaries_reject_invalid_and_underbudget_requests(self):
        cases = [self.request(mode=[]), self.request(timeout=121), self.request(action={"kind":"click","x":float("nan"),"y":10}), self.request(action={"kind":"click","x":200,"y":200,"shell":"echo"}), self.request(action={"kind":"key","key":"a","key_code":0}), self.request(action={"kind":"scroll","x":200,"y":200}), self.request(action={"kind":"move","x":200,"y":200,"modifiers":["command"]}), self.request(action={"kind":"key","key":[]}), self.request(coordinates={"space":"screen","unit":"pixels"}), self.request(action={"kind":"text","text":"x"*16001}), self.request(action={"kind":"text","text":"x"*1000})]
        for case in cases:
            with self.subTest(case=case.get("mode")), self.assertRaises(jobs.Failure):
                jobs.validate(case)
        jobs.validate(self.request(action={"kind":"text","text":"x"*1000,"text_chunk_units":20},timeout=30))
        jobs.validate(self.request(action={"kind":"click","x":200,"y":200,"move_seconds":0,"settle_seconds":0}))
        jobs.validate(self.request(action={"kind":"move","x":200,"y":200,"move_seconds":12},timeout=30))
        jobs.validate(self.request(action={"kind":"activate"}))

    def test_optional_control_hit_expectations_are_explicit_and_bounded(self):
        r = self.request()
        r["target"].update(hit_text="Save",hit_role="AXButton")
        jobs.validate(r)
        for change in [{"hit_text":""},{"hit_role":"x"*101},{"hit_text":123}]:
            bad = json.loads(json.dumps(r)); bad["target"].update(change)
            with self.assertRaises(jobs.Failure):
                jobs.validate(bad)
        r["action"] = {"kind":"key","key":"a"}
        with self.assertRaises(jobs.Failure):
            jobs.validate(r)

    def test_preflight_and_cancel_share_the_same_explicit_command(self):
        request = self.request(mode="preflight")
        with patch.object(subprocess,"Popen"):
            jobs.submit(request)
        self.assertEqual(jobs.command(request)[0][1],"input")
        self.assertTrue(jobs.cancel("input-1")["ok"])
        self.assertTrue(jobs.job_path("input-1").with_suffix(".cancel").exists())

    def test_global_stop_is_persistent_resume_does_not_dispatch(self):
        with patch.object(subprocess,"Popen") as spawn:
            self.assertTrue(jobs.input_stop(True)["stopped"])
            self.assertTrue(jobs.status()["input_stopped"])
            self.assertFalse(jobs.input_stop(False)["stopped"])
            spawn.assert_not_called()
        with self.assertRaises(jobs.Failure):
            jobs.input_stop(1)

    def test_stop_and_immediate_resume_cannot_revive_an_old_request(self):
        request = self.request()
        with patch.object(subprocess,"Popen"):
            jobs.submit(request)
        jobs.input_stop(True)
        with self.assertRaises(jobs.Failure):
            jobs.submit(self.request(request_id="new-input"))
        jobs.input_stop(False)
        self.assertTrue(jobs.job_path("input-1").with_suffix(".cancel").exists())
        with patch.object(jobs,"execute") as execute:
            jobs.worker("input-1")
        execute.assert_not_called()
        self.assertEqual(jobs.get("input-1")["status"],"cancelled")
        with patch.object(subprocess,"Popen") as spawn:
            self.assertTrue(jobs.submit(request)["reused"])
            spawn.assert_not_called()

    def test_input_log_is_scoped_paged_and_rejects_symlinks(self):
        with patch.object(subprocess,"Popen"):
            jobs.submit(self.request())
        folder = self.root / "input/input-1"; folder.mkdir(parents=True)
        path = folder / "events.jsonl"; path.write_text("\n".join(json.dumps({"event":"move","n":i}) for i in range(300)))
        result = jobs.input_log("input-1")
        self.assertEqual(result["next_offset"],256)
        self.assertEqual(jobs.input_log("input-1",256)["events"][0]["n"],256)
        path.unlink(); path.symlink_to(jobs.job_path("input-1"))
        with self.assertRaises(OSError):
            jobs.input_log("input-1")
        with self.assertRaises(jobs.Failure):
            jobs.input_log("../secret")

    def test_worker_uses_native_app_result_and_keeps_release_proof(self):
        with patch.object(subprocess,"Popen"):
            jobs.submit(self.request())
        result = {"ok":False,"code":"input_stopped","status":"cancelled","owned_input_at_exit":{"buttons":[],"keys":[]},"events_may_have_been_posted":True}
        with patch.object(jobs,"execute",return_value=result):
            jobs.worker("input-1")
        job = jobs.get("input-1")
        self.assertEqual(job["status"],"cancelled")
        self.assertEqual(job["result"]["owned_input_at_exit"],{"buttons":[],"keys":[]})
