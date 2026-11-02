import importlib.util
import itertools
import json
import plistlib
import subprocess
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import backend  # noqa: E402
import install  # noqa: E402

spec = importlib.util.spec_from_file_location(
    "migration", Path(__file__).resolve().parents[1] / "migrate-service.py"
)
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class ServiceMigration(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.old = backend.Paths(self.home, backend.LEGACY_LABEL)
        self.new = backend.Paths(self.home, backend.LABEL)
        for path, data in [
            (self.old.xray, b"original xray"),
            (self.old.assets / "geoip.dat", b"original asset"),
            (self.old.config, b'{ "unformatted": "original config" }'),
            (self.old.nodes, b'{ "original": "private profile" }'),
            (self.old.launcher, b"original launcher"),
            (self.old.root / "backend.py", b"original backend"),
            (self.old.plist, install.service_plist(self.old)),
        ]:
            backend.atomic_write(path, data)
        self.original = {p: p.read_bytes() for p in self.home.rglob("*") if p.is_file()}
        self.loaded = {backend.LEGACY_LABEL: 42}
        self.disabled = {backend.LEGACY_LABEL: False, backend.LABEL: True}
        self.events = []
        stack = ExitStack()
        self.addCleanup(stack.close)
        self.window = stack.enter_context(patch.object(migration, "maintenance_window"))
        stack.enter_context(patch.object(migration.subprocess, "run", side_effect=self.launchctl))
        stack.enter_context(
            patch.object(backend, "service_info", side_effect=lambda p: self.loaded.get(p.label))
        )
        stack.enter_context(
            patch.object(backend, "owns_listener", side_effect=lambda pid, port: bool(pid))
        )
        stack.enter_context(patch.object(backend, "network_latency", return_value=42))
        self.free = stack.enter_context(patch.object(install, "require_free_port"))
        self.stop = stack.enter_context(
            patch.object(install, "stop_service", side_effect=self.stop_service)
        )
        self.start = stack.enter_context(
            patch.object(install, "start_service", side_effect=self.start_service)
        )

    def launchctl(self, args, **kwargs):
        self.assertEqual(args[0], "/bin/launchctl")
        if args[1] == "print-disabled":
            entries = [
                f'"{label}" => {str(value).lower()}' for label, value in self.disabled.items()
            ]
            return subprocess.CompletedProcess(args, 0, "{\n" + "\n".join(entries) + "\n}")
        self.assertIn(args[1], ("enable", "disable"))
        self.disabled[args[2].rsplit("/", 1)[1]] = args[1] == "disable"
        return subprocess.CompletedProcess(args, 0)

    def stop_service(self, paths):
        self.events.append(("stop", paths.label))
        self.loaded.pop(paths.label, None)

    def start_service(self, paths):
        self.assertFalse(self.loaded, "two proxy services must never be loaded together")
        backend.verify_owner(paths)
        self.events.append(("start", paths.label))
        self.loaded[paths.label] = 55

    def assert_original(self, loaded=True):
        for path, data in self.original.items():
            self.assertEqual(path.read_bytes(), data, str(path))
        self.assertFalse(self.new.plist.exists())
        self.assertEqual(set(self.loaded), {backend.LEGACY_LABEL} if loaded else set())
        self.assertEqual(self.disabled, {backend.LEGACY_LABEL: not loaded, backend.LABEL: True})

    def test_migrate_rollback_remigrate_preserves_all_protected_bytes(self):
        before = migration.protected_files(self.old)
        self.assertEqual(migration.migrate(self.home)["phase"], "migrated")
        self.assertEqual(migration.protected_files(self.new), before)
        self.assertFalse(self.old.plist.exists())
        original_plist = plistlib.loads(self.original[self.old.plist])
        migrated_plist = plistlib.loads(self.new.plist.read_bytes())
        self.assertEqual(migrated_plist, {**original_plist, "Label": backend.LABEL})
        self.assertEqual(backend.Paths(self.home).label, backend.LABEL)
        self.assertEqual(set(self.loaded), {backend.LABEL})
        migration.migrate(self.home, rollback=True)
        self.assert_original()
        self.assertEqual(backend.Paths(self.home).label, backend.LEGACY_LABEL)
        migration.migrate(self.home)
        self.assertEqual(set(self.loaded), {backend.LABEL})

    def test_repeated_migrate_and_rollback_do_not_restart_services(self):
        migration.migrate(self.home)
        events = self.events.copy()
        self.assertTrue(migration.migrate(self.home)["unchanged"])
        self.assertEqual(self.events, events)
        migration.migrate(self.home, rollback=True)
        events = self.events.copy()
        migration.migrate(self.home, rollback=True)
        self.assertEqual(self.events, events)

    def test_unloaded_disabled_service_stays_unloaded_through_rollback(self):
        self.loaded.clear()
        self.disabled[backend.LEGACY_LABEL] = True
        migration.migrate(self.home)
        self.assertFalse(self.loaded)
        self.assertTrue(self.disabled[backend.LABEL])
        self.start.assert_not_called()
        migration.migrate(self.home, rollback=True)
        self.assert_original(loaded=False)
        self.start.assert_not_called()

    def test_plist_defaults_and_explicit_overrides_survive_migration_and_rollback(self):
        self.loaded.clear()
        for default, old_override, new_override in itertools.product((True, False, None), repeat=3):
            with self.subTest(default=default, old=old_override, new=new_override):
                migration.journal_path(self.old).unlink(missing_ok=True)
                self.new.plist.unlink(missing_ok=True)
                backend.atomic_write(
                    self.old.root / "backend.py", self.original[self.old.root / "backend.py"]
                )
                plist = plistlib.loads(install.service_plist(self.old))
                if default is not None:
                    plist["Disabled"] = default
                original = plistlib.dumps(plist)
                backend.atomic_write(self.old.plist, original)
                self.disabled = {
                    label: value
                    for label, value in (
                        (backend.LEGACY_LABEL, old_override),
                        (backend.LABEL, new_override),
                    )
                    if value is not None
                }
                effective = old_override if old_override is not None else bool(default)
                migration.migrate(self.home)
                self.assertEqual(migration.disabled(self.new), effective)
                self.assertFalse(self.loaded)
                state = json.loads(migration.journal_path(self.old).read_text())
                self.assertEqual(state["old_disabled"], effective)
                self.assertEqual(state["new_disabled"], bool(new_override))
                migration.migrate(self.home, rollback=True)
                self.assertEqual(self.old.plist.read_bytes(), original)
                self.assertEqual(migration.disabled(self.old), effective)
                # An absent new-label override is restored as explicitly enabled.
                self.assertEqual(self.disabled[backend.LABEL], bool(new_override))
                self.assertFalse(self.new.plist.exists())
                self.assertFalse(self.loaded)
        self.start.assert_not_called()

    def test_invalid_plist_disabled_default_fails_before_service_changes(self):
        self.disabled.pop(backend.LEGACY_LABEL)
        plist = plistlib.loads(self.old.plist.read_bytes())
        plist["Disabled"] = "true"
        backend.atomic_write(self.old.plist, plistlib.dumps(plist))
        with self.assertRaisesRegex(backend.Failure, "Disabled default must be a boolean"):
            migration.migrate(self.home)
        self.stop.assert_not_called()
        self.assertFalse(migration.journal_path(self.old).exists())

    def test_both_plists_or_both_loaded_jobs_are_conflicts(self):
        for on_disk in (True, False):
            with self.subTest(on_disk=on_disk):
                if on_disk:
                    backend.atomic_write(self.new.plist, install.service_plist(self.new))
                else:
                    self.new.plist.unlink()
                    self.loaded[backend.LABEL] = 99
                with self.assertRaisesRegex(backend.Failure, "Conflicting"):
                    migration.migrate(self.home)
                self.stop.assert_not_called()
                self.assertEqual(self.old.plist.read_bytes(), self.original[self.old.plist])

    def test_foreign_plist_and_symlink_fail_before_any_stop(self):
        backend.atomic_write(self.new.plist, plistlib.dumps({"Label": "foreign"}))
        with self.assertRaisesRegex(backend.Failure, "not owned"):
            migration.migrate(self.home)
        self.new.plist.unlink()
        self.new.plist.symlink_to(self.old.plist)
        with self.assertRaisesRegex(backend.Failure, "symlinks"):
            migration.migrate(self.home)
        self.stop.assert_not_called()

    def test_live_ci_or_failed_original_health_prevents_mutation(self):
        self.window.side_effect = backend.Failure("Drain CI")
        with self.assertRaisesRegex(backend.Failure, "Drain CI"):
            migration.migrate(self.home)
        self.window.side_effect = None
        with patch.object(backend, "network_latency", return_value=None):
            with self.assertRaisesRegex(backend.Failure, "Legacy proxy is unhealthy"):
                migration.migrate(self.home)
        self.stop.assert_not_called()
        self.assertFalse(migration.journal_path(self.old).exists())

    def test_bootstrap_failure_and_interrupt_restore_original(self):
        for error in (subprocess.CalledProcessError(5, "bootstrap"), KeyboardInterrupt()):
            with self.subTest(error=type(error).__name__):

                def start(paths):
                    if paths.label == backend.LABEL:
                        self.loaded[paths.label] = 77
                        raise error
                    self.start_service(paths)

                self.start.side_effect = start
                with self.assertRaisesRegex(
                    backend.Failure, "original service and management code restored"
                ):
                    migration.migrate(self.home)
                self.assert_original()

    def test_failed_recovery_retains_journal_for_explicit_retry(self):
        self.start.side_effect = RuntimeError("start failed")
        with self.assertRaisesRegex(backend.Failure, "recovery incomplete"):
            migration.migrate(self.home)
        self.assertEqual(
            json.loads(migration.journal_path(self.old).read_text())["phase"], "pending"
        )
        self.start.side_effect = self.start_service
        migration.migrate(self.home, rollback=True)
        self.assert_original()

    def test_interrupted_pending_journal_is_recovered_before_retry(self):
        self.start.side_effect = RuntimeError("start failed")
        with self.assertRaises(backend.Failure):
            migration.migrate(self.home)
        self.start.side_effect = self.start_service
        migration.migrate(self.home)
        self.assertEqual(set(self.loaded), {backend.LABEL})

    def test_changed_config_or_backend_rejects_rollback_before_stopping(self):
        migration.migrate(self.home)
        self.stop.reset_mock()
        for path in (self.old.config, self.old.root / "backend.py"):
            data = path.read_bytes()
            path.write_bytes(b"new user work")
            with self.assertRaisesRegex(backend.Failure, "changed"):
                migration.migrate(self.home, rollback=True)
            self.stop.assert_not_called()
            self.assertEqual(path.read_bytes(), b"new user work")
            path.write_bytes(data)

    def test_incomplete_snapshot_rejected_before_stopping(self):
        migration.migrate(self.home)
        self.stop.reset_mock()
        path = migration.journal_path(self.old)
        state = json.loads(path.read_text())
        state["old_plist"]["bytes"] = "broken"
        path.write_text(json.dumps(state))
        with self.assertRaises(ValueError):
            migration.migrate(self.home, rollback=True)
        self.stop.assert_not_called()

    def test_common_operation_lock_blocks_migration(self):
        with backend.operation_lock(self.old):
            with self.assertRaisesRegex(backend.Failure, "Another mini-proxy operation"):
                migration.migrate(self.home)
        self.stop.assert_not_called()

    def test_ci_coordination_lock_blocks_migration(self):
        with migration.ci_maintenance(self.home):
            with self.assertRaisesRegex(backend.Failure, "CI coordination is busy"):
                migration.migrate(self.home)
        self.stop.assert_not_called()

    def test_installer_refuses_pre_migration_snapshot_before_replacement(self):
        directory = install.snapshot(self.old, True)
        migration.migrate(self.home)
        with self.assertRaisesRegex(backend.Failure, "label differs"):
            install.rollback_state(self.new, directory)


class CompatibilityAndWindow(unittest.TestCase):
    def test_path_resolution_accepts_either_label_and_rejects_both(self):
        with tempfile.TemporaryDirectory() as directory:
            old = backend.Paths(directory, backend.LEGACY_LABEL)
            new = backend.Paths(directory, backend.LABEL)
            self.assertEqual(backend.Paths(directory).label, backend.LABEL)
            backend.atomic_write(old.plist, install.service_plist(old))
            self.assertEqual(backend.Paths(directory).label, backend.LEGACY_LABEL)
            backend.verify_owner(backend.Paths(directory))
            backend.atomic_write(new.plist, install.service_plist(new))
            with self.assertRaisesRegex(backend.Failure, "Conflicting"):
                backend.Paths(directory)

    def test_window_requires_suspended_listeners_and_no_worker(self):
        for output in (
            "S /user/bin/Runner.Listener",
            "S /user/bin/Runner.Worker",
            "T /user/bin/Runner.Worker",
        ):
            with self.subTest(output=output):
                with patch.object(subprocess, "run", return_value=Mock(stdout=output)):
                    with self.assertRaisesRegex(backend.Failure, "Drain CI"):
                        migration.maintenance_window()
        with patch.object(
            subprocess, "run", return_value=Mock(stdout="T /user/bin/Runner.Listener")
        ):
            migration.maintenance_window()


if __name__ == "__main__":
    unittest.main()
