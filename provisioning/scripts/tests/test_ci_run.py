import importlib.util
import json
import os
import signal
import stat
import subprocess
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location(
    "ci_run", ROOT / ".github/actions/quality/ci-run.py"
)
ci_run = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ci_run)


def stage(check="echo check", prepare="echo prepare", **extra):
    body = {"id": "unit", "prepare": prepare, "check": check, "require": []}
    body.update(extra)
    return {
        "schema": 1,
        "capabilities": [],
        "stages": [body],
    }


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def workspace(self, requirements, sha=None):
        root = Path(self.temp.name)
        workspace = root / "ws"
        state = root / "state"
        workspace.mkdir()
        (workspace / "ci").mkdir()
        (workspace / "ci" / "requirements.json").write_text(
            json.dumps(requirements), encoding="utf-8"
        )
        subprocess.check_call(["git", "init", "-q"], cwd=workspace)
        subprocess.check_call(
            ["git", "config", "user.email", "ci@example.com"], cwd=workspace
        )
        subprocess.check_call(["git", "config", "user.name", "ci"], cwd=workspace)
        (workspace / "README").write_text("pin\n", encoding="utf-8")
        subprocess.check_call(["git", "add", "README"], cwd=workspace)
        subprocess.check_call(["git", "commit", "-q", "-m", "pin"], cwd=workspace)
        head = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=workspace, text=True
        ).strip()
        env = {
            "PATH": os.environ["PATH"],
            "HOME": str(root / "home"),
            "MINI_CI_REQUEST": "run-ci",
            "MINI_CI_SHA": sha or head,
            "MINI_CI_LEASE": "local",
            "MINI_CI_REPO": "yaindrop/mini-archipel",
            "MINI_CI_PR": "12",
            "MINI_CI_REQUESTER": "ada",
            "MINI_CI_RUN_ID": "99",
            "MINI_CI_ATTEMPT": "2",
            "MINI_CI_NODE": "yd-mini",
            "MINI_CI_SHARED_REF": "a" * 40,
        }
        (root / "home").mkdir()
        return workspace, state, env

    def execute_case(
        self, requirements, shell=None, env_update=None, facts=None, sha=None
    ):
        workspace, state, env = self.workspace(requirements, sha)
        if env_update:
            env.update(env_update)
        kwargs = {}
        if shell:
            kwargs["shell"] = shell
        if facts:
            kwargs["facts"] = facts
        try:
            report = ci_run.execute(workspace, env, state, **kwargs)
        except SystemExit as exc:
            report = json.loads((workspace / "ci-report.json").read_text())
            report["_code"] = exc.code
            return workspace, state, report
        report["_code"] = 0
        return workspace, state, report

    def test_missing_request_does_not_run_or_record_a_pass(self):
        workspace, state, env = self.workspace(stage())
        env.pop("MINI_CI_REQUEST")
        with self.assertRaises(SystemExit) as caught:
            ci_run.execute(workspace, env, state, shell=lambda *_: (0, "", ""))
        self.assertEqual(caught.exception.code, 2)
        self.assertFalse((workspace / "ci-report.json").exists())
        self.assertFalse((state / "reports").exists())

    def test_push_event_and_fork_are_not_explicit_requests(self):
        self.assertFalse(
            ci_run.request_allowed(
                {"GITHUB_EVENT_NAME": "push", "MINI_CI_REQUEST": "run-ci"}
            )[0]
        )
        event = Path(self.temp.name) / "event.json"
        event.write_text(
            json.dumps(
                {
                    "action": "labeled",
                    "label": {"name": "run-ci"},
                    "repository": {"full_name": "yaindrop/mini-archipel"},
                    "pull_request": {
                        "number": 4,
                        "head": {
                            "sha": "b" * 40,
                            "repo": {"full_name": "other/mini-archipel"},
                        },
                    },
                }
            ),
            encoding="utf-8",
        )
        allowed, reason = ci_run.request_allowed(
            {
                "MINI_CI_REQUEST": "run-ci",
                "GITHUB_EVENT_NAME": "pull_request",
                "GITHUB_EVENT_PATH": str(event),
            }
        )
        self.assertFalse(allowed)
        self.assertIn("fork", reason)

    def test_environment_mismatch_does_not_start_the_check(self):
        calls = []

        def shell(command, _env, _cwd):
            calls.append(command)
            return 0, "", ""

        _workspace, _state, report = self.execute_case(
            stage(require=[{"kind": "file", "file": "missing.txt"}]),
            shell=shell,
        )
        self.assertEqual(report["conclusion"], "environment")
        self.assertFalse(report["env_ok"])
        self.assertEqual(calls, ["echo prepare"])
        self.assertIn("missing.txt", report["failure"])
        self.assertEqual(report["stages"][0]["accept"][0]["ok"], False)

    def test_toolchain_mismatch_stops_before_prepare(self):
        calls = []

        def shell(command, _env, _cwd):
            calls.append(command)
            return 0, "", ""

        _workspace, _state, report = self.execute_case(
            stage(toolchain={"node": "9.9.9"}),
            shell=shell,
            env_update={"MINI_CI_TOOLCHAIN_ROOT": str(Path(self.temp.name) / "tools")},
        )
        self.assertEqual(report["conclusion"], "environment")
        self.assertEqual(calls, [])
        self.assertIn("node 9.9.9", report["failure"])

    def test_selected_toolchain_is_what_acceptance_measures(self):
        root = Path(self.temp.name) / "tools" / "node" / "24.21.0" / "bin"
        root.mkdir(parents=True)
        binary = root / "node"
        binary.write_text("#!/bin/sh\necho v24.21.0\n", encoding="utf-8")
        binary.chmod(binary.stat().st_mode | stat.S_IEXEC)
        seen = {}

        def shell(command, env, _cwd):
            seen["path"] = env["PATH"]
            seen["identity"] = env["MINI_CI_ENV_ID"]
            return 0, "", ""

        _workspace, _state, report = self.execute_case(
            stage(
                toolchain={"node": "24.21.0"},
                require=[{"kind": "tool", "tool": "node", "version": "24.21.0"}],
            ),
            shell=shell,
            env_update={"MINI_CI_TOOLCHAIN_ROOT": str(Path(self.temp.name) / "tools")},
        )
        self.assertEqual(report["_code"], 0, report.get("failure"))
        self.assertTrue(report["env_ok"])
        self.assertTrue(seen["path"].startswith(str(root)))
        self.assertIn("console" if False else "unit", seen["identity"])
        self.assertNotIn("super-secret", json.dumps(report))

    def test_declared_pnpm_wins_over_path_pnpm(self):
        bindir = Path(self.temp.name) / "bin"
        bindir.mkdir()
        (bindir / "pnpm").write_text("#!/bin/sh\necho 11.22.0\n", encoding="utf-8")
        (bindir / "corepack").write_text(
            "#!/bin/sh\n"
            'if [ "$1" = prepare ]; then exit 0; fi\n'
            'if [ "$1" = pnpm ]; then echo 12.10.1; exit 0; fi\n'
            "exit 1\n",
            encoding="utf-8",
        )
        for name in ("pnpm", "corepack"):
            path = bindir / name
            path.chmod(path.stat().st_mode | stat.S_IEXEC)
        workspace, state, env = self.workspace(
            stage(
                prepare="pnpm --version > pnpm-version.txt",
                require=[{"kind": "tool", "tool": "pnpm", "version": "12.10"}],
            )
        )
        (workspace / "package.json").write_text(
            json.dumps({"packageManager": "pnpm@12.10.1"}), encoding="utf-8"
        )
        env["PATH"] = str(bindir) + os.pathsep + "/usr/bin:/bin"
        env["RUNNER_TEMP"] = str(Path(self.temp.name) / "runner-temp")
        report = ci_run.execute(workspace, env, state)
        self.assertEqual(report["conclusion"], "passed", report.get("failure"))
        self.assertIn("12.10.1", (workspace / "pnpm-version.txt").read_text())

    def test_uv_python_is_selected_when_path_python_is_newer(self):
        bindir = Path(self.temp.name) / "bin"
        py314 = Path(self.temp.name) / "py314" / "bin"
        bindir.mkdir()
        py314.mkdir(parents=True)
        (py314 / "python3").write_text(
            "#!/bin/sh\necho Python 3.14.8\n", encoding="utf-8"
        )
        (bindir / "python3").write_text(
            "#!/bin/sh\necho Python 3.15.0\n", encoding="utf-8"
        )
        (bindir / "uv").write_text(
            "#!/bin/sh\n"
            'if [ "$1" = python ] && [ "$2" = find ]; then\n'
            f"  echo {py314 / 'python3'}\n"
            "  exit 0\n"
            "fi\n"
            "exit 1\n",
            encoding="utf-8",
        )
        for path in (py314 / "python3", bindir / "python3", bindir / "uv"):
            path.chmod(path.stat().st_mode | stat.S_IEXEC)
        workspace, state, env = self.workspace(
            stage(require=[{"kind": "tool", "tool": "python3", "version": "3.14"}])
        )
        env["PATH"] = str(bindir) + os.pathsep + "/usr/bin:/bin"
        env["RUNNER_TEMP"] = str(Path(self.temp.name) / "runner-temp")
        report = ci_run.execute(workspace, env, state)
        self.assertEqual(report["conclusion"], "passed", report.get("failure"))

    def test_project_check_failure_is_not_a_pass(self):
        def shell(command, _env, _cwd):
            if command == "echo check":
                return 1, "suite output", "assertion failed"
            return 0, "", ""

        workspace, state, report = self.execute_case(stage(), shell=shell)
        self.assertEqual(report["conclusion"], "check")
        self.assertTrue(report["env_ok"])
        self.assertNotEqual(report["conclusion"], "passed")
        self.assertIn("assertion failed", report["failure"])
        self.assertTrue(Path(report["diagnostics"]).is_file())
        self.assertIn(report["sha"], (workspace / "ci-report.md").read_text())
        saved = json.loads((state / "reports" / "mini-archipel.json").read_text())
        self.assertEqual(saved["conclusion"], "check")
        self.assertEqual(saved["pr"], 12)
        self.assertEqual(saved["requester"], "ada")
        self.assertEqual(saved["run_id"], "99")
        self.assertEqual(saved["run_attempt"], 2)
        self.assertEqual(saved["node"], "yd-mini")
        self.assertEqual(saved["shared_ref"], "a" * 40)

    def test_credential_value_is_not_copied_into_the_report(self):
        def shell(_command, _env, _cwd):
            return 0, "", ""

        _workspace, _state, report = self.execute_case(
            stage(require=[{"kind": "env", "env": "SECRET"}]),
            shell=shell,
            env_update={"SECRET": "super-secret-value"},
        )
        self.assertEqual(report["_code"], 0, report.get("failure"))
        self.assertNotIn("super-secret-value", json.dumps(report))
        self.assertEqual(report["stages"][0]["accept"][0]["actual"], "present")

    def test_later_stage_does_not_run_after_an_environment_failure(self):
        calls = []

        def shell(command, _env, _cwd):
            calls.append(command)
            return 0, "", ""

        requirements = {
            "schema": 1,
            "capabilities": [],
            "stages": [
                {
                    "id": "first",
                    "prepare": "echo first-prepare",
                    "check": "echo first-check",
                    "require": [{"kind": "file", "file": "missing.txt"}],
                },
                {
                    "id": "second",
                    "prepare": "echo second-prepare",
                    "check": "echo second-check",
                    "require": [],
                },
            ],
        }
        _workspace, _state, report = self.execute_case(requirements, shell=shell)
        self.assertEqual(report["conclusion"], "environment")
        self.assertEqual(calls, ["echo first-prepare"])

    def test_wrong_commit_is_infrastructure_and_does_not_check(self):
        calls = []

        def shell(command, _env, _cwd):
            calls.append(command)
            return 0, "", ""

        _workspace, _state, report = self.execute_case(
            stage(), shell=shell, sha="0" * 40
        )
        self.assertEqual(report["conclusion"], "infrastructure")
        self.assertIn("pinned commit", report["failure"])
        self.assertEqual(calls, [])

    def test_missing_lease_does_not_check(self):
        calls = []

        def shell(command, _env, _cwd):
            calls.append(command)
            return 0, "", ""

        _workspace, _state, report = self.execute_case(
            stage(),
            shell=shell,
            env_update={"GITHUB_ACTIONS": "true", "MINI_CI_LEASE": "required"},
        )
        self.assertEqual(report["conclusion"], "infrastructure")
        self.assertIn("lease", report["failure"])
        self.assertEqual(calls, [])

    def test_live_owner_allows_the_check(self):
        workspace, state, env = self.workspace(stage())
        env["GITHUB_ACTIONS"] = "true"
        env["MINI_CI_LEASE"] = "required"
        (state / "owner.json").parent.mkdir(parents=True)
        (state / "owner.json").write_text(
            json.dumps({"pid": os.getpid()}), encoding="utf-8"
        )

        def shell(_command, _env, _cwd):
            return 0, "", ""

        report = ci_run.execute(workspace, env, state, shell=shell)
        self.assertEqual(report["conclusion"], "passed")

    def test_host_and_label_mismatch_stop_before_the_check(self):
        calls = []

        def shell(command, _env, _cwd):
            calls.append(command)
            return 0, "", ""

        requirements = stage()
        requirements["capabilities"] = ["macOS", "ARM64", "ci"]
        _workspace, _state, report = self.execute_case(
            requirements,
            shell=shell,
            facts=lambda: {"system": "Linux", "machine": "x86_64", "version": "0"},
            env_update={"MINI_CI_RUNS_ON": '["self-hosted"]'},
        )
        self.assertEqual(report["conclusion"], "environment")
        self.assertEqual(report["phase"], "accept:host")
        self.assertEqual(calls, [])

    def test_cleanup_runs_after_a_failed_check_and_can_fail_the_run(self):
        calls = []

        def shell(command, _env, _cwd):
            calls.append(command)
            if command == "echo clean":
                return 1, "", "cleanup broke"
            if command == "echo check":
                return 1, "", "nope"
            return 0, "", ""

        _workspace, _state, report = self.execute_case(
            stage(cleanup="echo clean"), shell=shell
        )
        self.assertEqual(calls, ["echo prepare", "echo check", "echo clean"])
        self.assertEqual(report["conclusion"], "check")
        self.assertIn("cleanup", report["failure"])

    def test_signal_marks_the_run_interrupted(self):
        workspace, state, env = self.workspace(stage(check="sleep 30", prepare="true"))
        env["MINI_CI_WORKSPACE"] = str(workspace)
        env["MINI_CI_STATE"] = str(state)
        process = subprocess.Popen(
            ["python3", str(ROOT / ".github/actions/quality/ci-run.py")],
            env=env,
            cwd=workspace,
        )
        self.addCleanup(process.kill)
        deadline = time.monotonic() + 10
        phase = ""
        while time.monotonic() < deadline:
            path = state / "reports" / "mini-archipel.json"
            if path.is_file():
                phase = json.loads(path.read_text()).get("phase", "")
                if phase.startswith("check:"):
                    break
            time.sleep(0.05)
        self.assertTrue(phase.startswith("check:"), phase)
        process.send_signal(signal.SIGTERM)
        self.assertEqual(process.wait(timeout=10), 128 + signal.SIGTERM)
        report = json.loads((state / "reports" / "mini-archipel.json").read_text())
        self.assertEqual(report["conclusion"], "interrupted")
        self.assertEqual(report["sha"], env["MINI_CI_SHA"])

    def test_repository_requirements_and_workflows(self):
        data = json.loads((ROOT / "ci" / "requirements.json").read_text())
        ci_run.validate_requirements(data)
        self.assertEqual(
            [item["id"] for item in data["stages"]],
            [
                "provisioning",
                "fan-control",
                "console",
                "agent",
            ],
        )
        by_id = {item["id"]: item for item in data["stages"]}
        self.assertIn("git", json.dumps(by_id["provisioning"]["require"]))
        self.assertIn("0.13", json.dumps(by_id["provisioning"]["require"]))
        self.assertIn("3.14", json.dumps(by_id["provisioning"]["require"]))
        self.assertIn("pypi.org", json.dumps(by_id["provisioning"]["require"]))
        self.assertNotIn("ruff>=", json.dumps(by_id["provisioning"]["require"]))
        self.assertIn("clang", json.dumps(by_id["fan-control"]["require"]))
        self.assertIn("/usr/bin/python3", json.dumps(by_id["fan-control"]["require"]))
        self.assertEqual(by_id["console"]["toolchain"]["node"], "26.12")
        self.assertIn("12.10", json.dumps(by_id["console"]["require"]))
        self.assertIn("playwright", json.dumps(by_id["console"]["require"]))
        self.assertIn(".node-version", json.dumps(by_id["console"]["require"]))
        self.assertEqual(by_id["agent"]["toolchain"]["node"], "26.12")
        self.assertIn("rustup toolchain install", by_id["agent"]["prepare"])
        self.assertIn("cargo fetch", by_id["agent"]["prepare"])
        self.assertIn("rust-toolchain.toml", json.dumps(by_id["agent"]["require"]))
        self.assertIn("1.99", json.dumps(by_id["agent"]["require"]))
        self.assertIn("Cargo.lock", json.dumps(by_id["agent"]["require"]))
        self.assertIn("clippy", json.dumps(by_id["agent"]["require"]))
        self.assertNotIn("RUSTUP_TOOLCHAIN", json.dumps(by_id["agent"]))
        self.assertEqual(
            ci_run.audit_reusable(
                (ROOT / ".github/workflows/reusable-quality.yml").read_text()
            ),
            [],
        )
        self.assertEqual(
            ci_run.audit_caller(
                (ROOT / ".github/workflows/pr-quality.yml").read_text(), True
            ),
            [],
        )
        bad = textwrap.dedent(
            """
            on:
              push:
              pull_request:
                types: [opened]
            jobs:
              quality:
                if: true
            """
        )
        self.assertIn("push or schedule trigger", ci_run.audit_caller(bad, False))
        pinned = "\n".join(
            [
                "on:",
                "  pull_request:",
                "    types: [labeled]",
                "concurrency:",
                "  cancel-in-progress: false",
                "jobs:",
                "  quality:",
                "    if: github.event.label.name == 'run-ci' && "
                "github.event.pull_request.head.repo.full_name == github.repository",
                "    uses: yaindrop/mini-archipel/.github/workflows/"
                "reusable-quality.yml@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ]
        )
        self.assertEqual(ci_run.audit_caller(pinned, False), [])

    def test_cross_repo_callers_pin_the_shared_commit(self):
        callers = sorted((ROOT / "ci" / "callers").glob("*.yml"))
        self.assertEqual(
            [path.name for path in callers],
            ["flowbit-knowledge.yml", "flowbit.yml", "in-frames.yml"],
        )
        for path in callers:
            text = path.read_text(encoding="utf-8")
            self.assertEqual(ci_run.audit_caller(text, False), [])
            sha = text.rsplit("@", 1)[1].split()[0]
            self.assertEqual(len(sha), 40)
            subprocess.check_call(
                [
                    "git",
                    "cat-file",
                    "-e",
                    sha + ":.github/workflows/reusable-quality.yml",
                ],
                cwd=ROOT,
            )

    def test_version_ok_accepts_patch_within_minor(self):
        self.assertTrue(ci_run.version_ok("v26.12.0", "26.12"))
        self.assertTrue(ci_run.version_ok("v26.12.1", "26.12"))
        self.assertTrue(ci_run.version_ok("ruff 0.17.1\n", "0.17"))
        self.assertTrue(ci_run.version_ok("rustc 1.99.1 (9a7dcb4 2026-10-01)", "1.99"))
        self.assertFalse(ci_run.version_ok("v26.13.0", "26.12"))
        self.assertFalse(ci_run.version_ok("ruff 0.18.0", "0.17"))
        self.assertFalse(ci_run.version_ok("rustc 1.98.1", "1.99"))


if __name__ == "__main__":
    unittest.main()
