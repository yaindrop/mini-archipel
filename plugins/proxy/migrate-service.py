#!/usr/bin/env python3
"""Rename only the standalone proxy service, with a durable recovery journal."""

import argparse
import base64
import fcntl
import hashlib
import json
import os
import plistlib
import re
import signal
import subprocess
from contextlib import contextmanager
from pathlib import Path

import backend
import install


@contextmanager
def ci_maintenance(home):
    """Use the same mutex as ci-lease.py and the Agent's reconciliation."""
    state = Path(home) / ".local/state/mini-archipel/ci"
    state.mkdir(parents=True, mode=0o700, exist_ok=True)
    with (state / "mutex").open("a+") as stream:
        os.fchmod(stream.fileno(), 0o600)
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise backend.Failure(
                "CI coordination is busy; retry after it releases the mutex"
            ) from None
        yield


def maintenance_window():
    """The operator drains jobs and freezes idle Listeners before entering."""
    result = subprocess.run(
        ["/bin/ps", "-axo", "stat=,comm="],
        capture_output=True,
        text=True,
        check=True,
        timeout=5,
    )
    for line in result.stdout.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) != 2:
            continue
        state, command = fields
        if command.endswith("/Runner.Worker") or (
            command.endswith("/Runner.Listener") and "T" not in state
        ):
            raise backend.Failure("Drain CI jobs and pause all idle Listeners before migration")


def disabled(paths):
    result = subprocess.run(
        ["/bin/launchctl", "print-disabled", f"gui/{os.getuid()}"],
        capture_output=True,
        text=True,
        check=True,
        timeout=5,
    )
    match = re.search(r'"' + re.escape(paths.label) + r'"\s*=>\s*(true|false)', result.stdout)
    return bool(match and match[1] == "true")


def set_disabled(paths, value):
    subprocess.run(
        ["/bin/launchctl", "disable" if value else "enable", paths.service],
        capture_output=True,
        check=True,
        timeout=5,
    )


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def protected_files(paths):
    # Include every resource in bin, not just the executable or a version string.
    files = [paths.config, paths.nodes, paths.launcher, *sorted(paths.assets.iterdir())]
    for path in files:
        backend.reject_gui_path(path)
        if path.is_symlink() or not path.is_file():
            raise backend.Failure("Protected proxy files must be regular files")
    return {
        str(path.relative_to(paths.home)): [digest(path), path.stat().st_mode & 0o777]
        for path in files
    }


def journal_path(paths):
    return paths.root / "service-label-migration.json"


def encoded(path):
    return {
        "bytes": base64.b64encode(path.read_bytes()).decode(),
        "mode": path.stat().st_mode & 0o777,
    }


def decode(saved):
    if (
        not isinstance(saved, dict)
        or set(saved) != {"bytes", "mode"}
        or type(saved["mode"]) is not int
        or not 0 <= saved["mode"] <= 0o777
    ):
        raise backend.Failure("Invalid service migration snapshot")
    return base64.b64decode(saved["bytes"], validate=True)


def write_saved(path, saved):
    backend.atomic_write(path, decode(saved), saved["mode"])


def validate_paths(old, new):
    for path in [
        old.root,
        old.assets,
        old.plist,
        new.plist,
        old.root / "backend.py",
        journal_path(old),
    ]:
        backend.reject_gui_path(path)
        if path.is_symlink():
            raise backend.Failure("Migration paths must not be symlinks")
    for paths in (old, new):
        if paths.plist.exists():
            backend.verify_owner(paths)
        backend.service_info(paths)  # Refuse a foreign loaded job even without a plist.


def validate_journal(old, new, state):
    if (
        not isinstance(state, dict)
        or state.get("version") != 1
        or state.get("phase") not in {"pending", "migrated", "rolled_back"}
        or any(
            type(state.get(key)) is not bool for key in ("loaded", "old_disabled", "new_disabled")
        )
        or state.get("protected") != protected_files(old)
    ):
        raise backend.Failure(
            "Migration snapshot or protected files changed; inspect before recovery"
        )
    for key in ("old_plist", "new_plist", "old_backend", "new_backend"):
        decode(state[key])
    for paths, key in ((old, "old_plist"), (new, "new_plist")):
        data = plistlib.loads(decode(state[key]))
        if data.get("Label") != paths.label or data.get("ProgramArguments") != [
            str(paths.xray),
            "run",
            "-c",
            str(paths.config),
        ]:
            raise backend.Failure("Snapshot does not belong to this proxy")
        if paths.plist.exists() and paths.plist.read_bytes() != decode(state[key]):
            raise backend.Failure("Service plist changed after snapshot; inspect before recovery")
    code = (old.root / "backend.py").read_bytes()
    if code not in (decode(state["old_backend"]), decode(state["new_backend"])):
        raise backend.Failure("Proxy management code changed; inspect before recovery")


def restore(old, new, state):
    validate_journal(old, new, state)
    maintenance_window()
    install.stop_service(new)
    install.stop_service(old)
    install.require_free_port()
    write_saved(old.root / "backend.py", state["old_backend"])
    write_saved(old.plist, state["old_plist"])
    new.plist.unlink(missing_ok=True)
    if state["loaded"]:
        install.start_service(old)
    set_disabled(old, state["old_disabled"])
    set_disabled(new, state["new_disabled"])
    state["phase"] = "rolled_back"
    backend.atomic_write(journal_path(old), backend.json_bytes(state))


def migrate(home, rollback=False):
    with ci_maintenance(home):
        return migrate_locked(home, rollback)


def migrate_locked(home, rollback=False):
    """Caller holds ci_maintenance through drain, migration and Listener restoration."""
    old = backend.Paths(home, backend.LEGACY_LABEL)
    new = backend.Paths(home, backend.LABEL)
    with backend.operation_lock(old):
        validate_paths(old, new)
        path = journal_path(old)
        state = json.loads(path.read_text()) if path.exists() else None
        if state is not None:
            validate_journal(old, new, state)
        if rollback:
            if state is None:
                raise backend.Failure("No service-label migration snapshot exists")
            if state["phase"] != "rolled_back":
                restore(old, new, state)
            return {"ok": True, "phase": "rolled_back", "loaded": state["loaded"]}
        if state and state["phase"] == "pending":
            restore(old, new, state)
        old_pid, new_pid = backend.service_info(old), backend.service_info(new)
        if old.plist.exists() and new.plist.exists() or old_pid is not None and new_pid is not None:
            raise backend.Failure("Conflicting mini-proxy labels; no service changed")
        if new.plist.exists():
            if old.plist.exists() or old_pid is not None:
                raise backend.Failure("Legacy service still present; inspect before migration")
            if state is None or state["phase"] != "migrated":
                raise backend.Failure("New service exists without a completed migration snapshot")
            if state["loaded"] and (
                not backend.owns_listener(new_pid, 10808) or backend.network_latency(10808) is None
            ):
                raise backend.Failure("Migrated service is unhealthy; use --rollback")
            return {"ok": True, "phase": "migrated", "unchanged": True}
        if not old.plist.exists() or new_pid is not None:
            raise backend.Failure("Expected only the installed legacy proxy service")
        maintenance_window()
        if old_pid is not None and (
            not backend.owns_listener(old_pid, 10808) or backend.network_latency(10808) is None
        ):
            raise backend.Failure("Legacy proxy is unhealthy; migration not started")
        if old_pid is None:
            install.require_free_port()
        plist = plistlib.loads(old.plist.read_bytes())
        plist["Label"] = new.label
        state = {
            "version": 1,
            "phase": "pending",
            "loaded": old_pid is not None,
            "old_disabled": disabled(old),
            "new_disabled": disabled(new),
            "protected": protected_files(old),
            "old_plist": encoded(old.plist),
            "new_plist": {
                "bytes": base64.b64encode(plistlib.dumps(plist)).decode(),
                "mode": old.plist.stat().st_mode & 0o777,
            },
            "old_backend": encoded(old.root / "backend.py"),
            "new_backend": {
                **encoded(Path(backend.__file__)),
                "mode": (old.root / "backend.py").stat().st_mode & 0o777,
            },
        }
        backend.atomic_write(path, backend.json_bytes(state))
        try:
            install.stop_service(old)
            install.require_free_port()
            write_saved(old.root / "backend.py", state["new_backend"])
            write_saved(new.plist, state["new_plist"])
            old.plist.unlink()
            if state["loaded"]:
                install.start_service(new)
            set_disabled(new, state["old_disabled"])
            if protected_files(old) != state["protected"]:
                raise backend.Failure("Protected proxy files changed during migration")
            state["phase"] = "migrated"
            backend.atomic_write(path, backend.json_bytes(state))
        except BaseException as error:
            try:
                restore(old, new, state)
            except BaseException:
                raise backend.Failure(
                    "Migration recovery incomplete; retain journal and run --rollback"
                ) from error
            raise backend.Failure(
                "Migration failed; original service and management code restored"
            ) from error
        return {"ok": True, "phase": "migrated", "loaded": state["loaded"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rollback", action="store_true")
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, backend.interrupted)
    try:
        result = migrate(Path.home(), args.rollback)
    except backend.Failure as error:
        parser.exit(1, str(error) + "\n")
    except (
        OSError,
        ValueError,
        KeyError,
        TypeError,
        subprocess.SubprocessError,
        KeyboardInterrupt,
    ):
        parser.exit(1, "Service migration failed; inspect the private journal and service state\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
