import copy
import hashlib
import http.client
import io
import json
import plistlib
import socket
import subprocess
import sys
import tempfile
import unittest
import zipfile
from contextlib import ExitStack, redirect_stderr
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import backend  # noqa: E402
import fetch  # noqa: E402
import install  # noqa: E402


def profiles():
    node = {
        "address": "proxy.example.com",
        "port": 443,
        "password": "00000000-0000-4000-8000-000000000001",
        "network": "raw",
        "security": "reality",
        "sni": "example.com",
        "fingerprint": "chrome",
        "publicKey": "A" * 43,
        "shortId": "abcd",
        "spiderX": "/",
    }
    return {"old": node, "new": {**node, "address": "new.example.com"}}


class Fixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.paths = backend.Paths(Path(self.temporary.name) / "user")
        self.nodes = profiles()
        backend.atomic_write(self.paths.nodes, backend.json_bytes(self.nodes))
        self.config = backend.configure(self.nodes, "old")
        backend.atomic_write(self.paths.config, backend.json_bytes(self.config))
        backend.atomic_write(self.paths.plist, install.service_plist(self.paths))


class ProfilesAndConfig(Fixture):
    def test_profiles_accept_deployed_schema_and_optional_flow(self):
        self.assertEqual(backend.load_nodes(self.paths.nodes), self.nodes)
        self.nodes["new"]["flow"] = ""
        backend.atomic_write(self.paths.nodes, backend.json_bytes(self.nodes))
        self.assertEqual(backend.load_nodes(self.paths.nodes)["new"]["flow"], "")

    def test_invalid_profiles_fail_without_disclosing_values(self):
        for field, value in [
            ("port", True),
            ("port", 65536),
            ("password", "secret-invalid-uuid"),
            ("publicKey", "secret-key"),
            ("shortId", "abc"),
            ("flow", []),
            ("address", "secret\naddress"),
            ("network", "ws"),
            ("extra", "secret"),
        ]:
            with self.subTest(field=field, value=value):
                nodes = profiles()
                nodes["old"][field] = value
                backend.atomic_write(self.paths.nodes, backend.json_bytes(nodes))
                with self.assertRaises(backend.Failure) as raised:
                    backend.load_nodes(self.paths.nodes)
                self.assertNotIn("secret", str(raised.exception))

    def test_switch_preserves_routing_listeners_and_unrelated_outbounds(self):
        self.config["routing"] = {"rules": [{"custom": "preserved"}]}
        self.config["inbounds"][0]["port"] = 1234
        before = copy.deepcopy(self.config)
        result = backend.configure(self.nodes, "new", self.config)
        self.assertEqual(self.config, before)
        self.assertEqual(result["routing"], before["routing"])
        self.assertEqual(result["inbounds"], before["inbounds"])
        self.assertEqual(result["outbounds"][1:], before["outbounds"][1:])
        self.assertEqual(result["outbounds"][0]["settings"]["vnext"][0]["users"][0]["email"], "new")

    def test_fresh_config_binds_loopback_and_ambiguous_existing_config_fails(self):
        self.assertEqual(self.config["inbounds"][0]["listen"], "127.0.0.1")
        for previous in [
            [],
            {},
            {"outbounds": [None]},
            {"outbounds": []},
            {"outbounds": [self.config["outbounds"][0]] * 2},
        ]:
            with self.subTest(previous=previous), self.assertRaises(backend.Failure):
                backend.configure(self.nodes, "new", previous)

    def test_gui_path_alias_is_refused_before_reading(self):
        target = Path(self.temporary.name) / "v2rayN/private"
        alias = Path(self.temporary.name) / "alias"
        alias.symlink_to(target)
        with self.assertRaisesRegex(backend.Failure, "never GUI"):
            backend.load_nodes(alias)

    def test_lock_blocks_another_operation_and_releases_after_failure(self):
        with self.assertRaises(RuntimeError):
            with backend.operation_lock(self.paths):
                with self.assertRaisesRegex(backend.Failure, "active"):
                    with backend.operation_lock(self.paths):
                        self.fail("second lock acquired")
                raise RuntimeError()
        with backend.operation_lock(self.paths):
            pass
        self.assertEqual(self.paths.nodes.stat().st_mode & 0o777, 0o600)

    def test_ci_guard_covers_other_repositories(self):
        with patch.object(
            backend.subprocess,
            "run",
            return_value=Mock(stdout="/Users/test/runners/other-repo/bin/Runner.Worker\n"),
        ):
            with self.assertRaisesRegex(backend.Failure, "CI runner is busy"):
                backend.ensure_idle()

    def test_foreign_service_is_rejected(self):
        with patch.object(
            backend.subprocess,
            "run",
            return_value=Mock(returncode=0, stdout="program = /some/other/proxy\npid = 42"),
        ):
            with self.assertRaisesRegex(backend.Failure, "not the standalone"):
                backend.service_info(self.paths)


class Switching(Fixture):
    def setUp(self):
        super().setUp()
        self.before = self.paths.config.read_bytes()
        stack = ExitStack()
        self.addCleanup(stack.close)
        self.probe = stack.enter_context(patch.object(backend, "check_candidate", return_value=42))
        self.idle = stack.enter_context(patch.object(backend, "ensure_idle"))
        self.validate = stack.enter_context(patch.object(backend, "validate_config"))
        self.restart = stack.enter_context(
            patch.object(backend, "restart_and_check", return_value=True)
        )

    def test_check_only_never_writes_or_restarts_service(self):
        self.assertEqual(backend.select(self.paths, "new", True), 42)
        self.assertEqual(self.paths.config.read_bytes(), self.before)
        self.restart.assert_not_called()
        self.idle.assert_not_called()
        self.assertFalse(self.paths.config.with_suffix(".json.previous").exists())

    def test_failed_candidate_preserves_live_config(self):
        self.probe.side_effect = backend.Failure("probe failed")
        with self.assertRaises(backend.Failure):
            backend.select(self.paths, "new")
        self.assertEqual(self.paths.config.read_bytes(), self.before)
        self.restart.assert_not_called()

    def test_ci_starting_during_probe_prevents_mutation(self):
        self.idle.side_effect = [None, backend.Failure("CI runner is busy")]
        with self.assertRaisesRegex(backend.Failure, "CI runner is busy"):
            backend.select(self.paths, "new")
        self.assertEqual(self.paths.config.read_bytes(), self.before)
        self.restart.assert_not_called()

    def test_restart_failure_and_interrupt_restore_config_and_verify_recovery(self):
        for failure in [False, OSError("private-detail"), KeyboardInterrupt()]:
            with self.subTest(failure=type(failure).__name__):
                self.restart.side_effect = [failure, True]
                with self.assertRaisesRegex(backend.Failure, "service verified") as raised:
                    backend.select(self.paths, "new")
                self.assertNotIn("private-detail", str(raised.exception))
                self.assertEqual(self.paths.config.read_bytes(), self.before)

    def test_recovery_failure_is_reported_without_losing_previous_bytes(self):
        self.restart.side_effect = [False, OSError("private")]
        with self.assertRaisesRegex(backend.Failure, "service needs attention"):
            backend.select(self.paths, "new")
        self.assertEqual(self.paths.config.read_bytes(), self.before)

    def test_success_persists_node_and_private_previous_config(self):
        self.assertEqual(backend.select(self.paths, "new"), 42)
        current = json.loads(self.paths.config.read_text())
        self.assertEqual(
            current["outbounds"][0]["settings"]["vnext"][0]["users"][0]["email"], "new"
        )
        backup = self.paths.config.with_suffix(".json.previous")
        self.assertEqual(backup.read_bytes(), self.before)
        self.assertEqual(backup.stat().st_mode & 0o777, 0o600)

    def test_cli_sanitizes_raw_parse_errors(self):
        stderr = io.StringIO()
        with (
            patch.object(sys, "argv", ["mini-proxy-select", "new"]),
            patch.object(backend, "select", side_effect=ValueError("secret credential")),
            patch.object(backend.signal, "signal"),
            redirect_stderr(stderr),
        ):
            with self.assertRaises(SystemExit) as raised:
                backend.main()
        self.assertEqual(raised.exception.code, 1)
        self.assertNotIn("secret", stderr.getvalue())


class Probes(unittest.TestCase):
    def test_two_real_204_requests_share_tunnel_and_use_smaller_sample(self):
        response = Mock(status=204, will_close=False)
        connection = Mock()
        connection.getresponse.return_value = response
        factory = Mock(return_value=connection)
        with (
            patch.object(backend.time, "sleep"),
            patch.object(backend.time, "perf_counter", side_effect=[1, 1.100, 2, 2.003]),
        ):
            self.assertEqual(backend.network_latency(12345, factory), 3)
        factory.assert_called_once()
        connection.set_tunnel.assert_called_once_with("www.google.com", 443)
        self.assertEqual(connection.request.call_count, 2)
        self.assertEqual(response.read.call_count, 2)
        connection.close.assert_called_once()

    def test_http_error_closed_connection_and_second_request_failure_are_rejected(self):
        for responses in [
            [Mock(status=500, will_close=False)],
            [Mock(status=204, will_close=True)],
            [Mock(status=204, will_close=False), http.client.RemoteDisconnected()],
        ]:
            connection = Mock()
            connection.getresponse.side_effect = responses
            with patch.object(backend.time, "sleep"):
                self.assertIsNone(backend.network_latency(12345, Mock(return_value=connection)))
            connection.close.assert_called_once()

    def test_candidate_failure_terminates_and_reaps_its_process(self):
        process = Mock(pid=42)
        process.poll.return_value = None
        process.wait.side_effect = [subprocess.TimeoutExpired("xray", 3), 0]
        paths = backend.Paths(Path("/tmp/isolated-test-user"))
        with (
            patch.object(backend, "validate_config"),
            patch.object(backend.subprocess, "Popen", return_value=process),
            patch.object(backend.socket, "create_connection"),
            patch.object(backend, "network_latency", return_value=None),
        ):
            with self.assertRaisesRegex(backend.Failure, "two HTTP 204"):
                backend.check_candidate(paths, backend.configure(profiles(), "old"))
        process.terminate.assert_called_once()
        process.kill.assert_called_once()
        self.assertEqual(process.wait.call_count, 2)


class Assets(unittest.TestCase):
    def test_pinned_archive_checks_both_archive_and_member_hashes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "release.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("xray", b"fake binary")
                bundle.writestr("../../outside", b"never extracted")
            lock = {
                "archive_sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
                "files": {"xray": hashlib.sha256(b"fake binary").hexdigest()},
            }
            with patch.object(fetch, "LOCK", lock):
                fetch.prepare(root / "assets", archive)
                self.assertEqual(list(p.name for p in (root / "assets").iterdir()), ["xray"])
                self.assertEqual((root / "assets/xray").stat().st_mode & 0o777, 0o700)
                (root / "assets/xray").write_bytes(b"tampered")
                with self.assertRaisesRegex(ValueError, "Asset checksum"):
                    fetch.prepare(root / "assets", archive)
                lock["files"]["xray"] = "wrong"
                with self.assertRaisesRegex(ValueError, "Asset checksum"):
                    fetch.prepare(root / "bad-member", archive)
                self.assertFalse((root / "bad-member").exists())
                lock["archive_sha256"] = "wrong"
                with self.assertRaisesRegex(ValueError, "Archive checksum"):
                    fetch.prepare(root / "bad-archive", archive)
                self.assertFalse((root / "bad-archive").exists())


class PortAvailability(unittest.TestCase):
    def test_closed_listener_with_time_wait_does_not_block_upgrade(self):
        with socket.socket() as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            port = listener.getsockname()[1]
            with socket.create_connection(("127.0.0.1", port), timeout=1) as client:
                accepted, _ = listener.accept()
                accepted.close()
                self.assertEqual(client.recv(1), b"")
        install.require_free_port(port)

    def test_live_listener_is_still_rejected(self):
        with socket.socket() as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            with self.assertRaisesRegex(backend.Failure, "occupied"):
                install.require_free_port(listener.getsockname()[1])


class Installation(Fixture):
    def setUp(self):
        super().setUp()
        self.assets = Path(self.temporary.name) / "assets"
        for name in fetch.LOCK["files"]:
            backend.atomic_write(self.assets / name, b"new asset " + name.encode())
            backend.atomic_write(self.paths.assets / name, b"old asset " + name.encode())
        backend.atomic_write(self.paths.launcher, b"old launcher", 0o700)
        backend.atomic_write(self.paths.root / "backend.py", b"old backend")
        self.unrelated = self.paths.assets / "unrelated-user-file"
        self.unrelated.write_bytes(b"preserve me")
        self.before = {
            name: path.read_bytes()
            for name, path in install.managed(self.paths).items()
            if path.exists()
        }
        stack = ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(install, "verify_assets"))
        self.idle = stack.enter_context(patch.object(backend, "ensure_idle"))
        stack.enter_context(patch.object(backend, "check_candidate", return_value=1))
        self.info = stack.enter_context(patch.object(install, "service_info", return_value=123))
        self.free = stack.enter_context(patch.object(install, "require_free_port"))
        self.stop = stack.enter_context(patch.object(install, "stop_service"))
        self.start = stack.enter_context(patch.object(install, "start_service"))

    def assert_restored(self):
        for name, path in install.managed(self.paths).items():
            if name in self.before:
                self.assertEqual(path.read_bytes(), self.before[name], name)
            else:
                self.assertFalse(path.exists(), name)
        self.assertEqual(self.unrelated.read_bytes(), b"preserve me")
        self.assertEqual(self.paths.xray.stat().st_mode & 0o777, 0o700)

    def test_upgrade_and_explicit_rollback_preserve_unrelated_files(self):
        result = install.install(self.paths, self.assets)
        self.assertEqual(result["xray_version"], fetch.LOCK["version"])
        self.assertEqual(self.paths.nodes.stat().st_mode & 0o777, 0o600)
        self.assertEqual(Path(result["backup"]).stat().st_mode & 0o777, 0o700)
        plist = plistlib.loads(self.paths.plist.read_bytes())
        self.assertEqual(plist["Label"], backend.LABEL)
        self.assertEqual(plist["ProgramArguments"][0], str(self.paths.xray))
        install.install(self.paths, self.assets, rollback=True)
        self.assert_restored()

    def test_failed_upgrade_restores_binary_config_credentials_and_service(self):
        self.start.side_effect = [backend.Failure("unhealthy"), None]
        with self.assertRaisesRegex(backend.Failure, "previous files/service restored"):
            install.install(self.paths, self.assets)
        self.assert_restored()
        self.assertEqual(self.start.call_count, 2)

    def test_fresh_install_and_rollback_remove_only_managed_files(self):
        fresh = backend.Paths(Path(self.temporary.name) / "fresh-user")
        self.info.return_value = None
        install.install(fresh, self.assets, self.paths.nodes, "new")
        self.info.return_value = 456
        install.install(fresh, self.assets, rollback=True)
        self.assertTrue(all(not path.exists() for path in install.managed(fresh).values()))

    def test_foreign_port_is_rejected_before_service_or_file_changes(self):
        self.info.return_value = None
        self.free.side_effect = backend.Failure("Port 10808 is occupied")
        with self.assertRaisesRegex(backend.Failure, "occupied"):
            install.install(self.paths, self.assets)
        self.stop.assert_not_called()
        self.assertFalse(install.backup_root(self.paths).exists())

    def test_busy_ci_and_foreign_plist_are_rejected_before_service_stop(self):
        self.idle.side_effect = backend.Failure("CI runner is busy")
        with self.assertRaisesRegex(backend.Failure, "busy"):
            install.install(self.paths, self.assets)
        self.idle.side_effect = None
        backend.atomic_write(self.paths.plist, plistlib.dumps({"Label": "foreign"}))
        with self.assertRaisesRegex(backend.Failure, "not owned"):
            install.install(self.paths, self.assets)
        self.stop.assert_not_called()

    def test_incomplete_rollback_snapshot_is_rejected_before_stop(self):
        result = install.install(self.paths, self.assets)
        self.stop.reset_mock()
        (Path(result["backup"]) / "nodes.json").unlink()
        with self.assertRaisesRegex(backend.Failure, "Incomplete rollback"):
            install.install(self.paths, self.assets, rollback=True)
        self.stop.assert_not_called()

    def test_failure_to_stop_keeps_all_current_files(self):
        self.stop.side_effect = backend.Failure("still running")
        with self.assertRaisesRegex(backend.Failure, "before replacing files"):
            install.install(self.paths, self.assets)
        for name, expected in self.before.items():
            self.assertEqual(install.managed(self.paths)[name].read_bytes(), expected)

    def test_malformed_rollback_marker_and_manifest_fail_before_stop(self):
        result = install.install(self.paths, self.assets)
        self.stop.reset_mock()
        marker = self.paths.root / "rollback.json"
        original = marker.read_bytes()
        backend.atomic_write(marker, b"[]")
        with self.assertRaisesRegex(backend.Failure, "Invalid rollback marker"):
            install.install(self.paths, self.assets, rollback=True)
        backend.atomic_write(marker, original)
        backend.atomic_write(Path(result["backup"]) / "snapshot.json", b"[]")
        with self.assertRaisesRegex(backend.Failure, "Invalid rollback manifest"):
            install.install(self.paths, self.assets, rollback=True)
        self.stop.assert_not_called()


if __name__ == "__main__":
    unittest.main()
