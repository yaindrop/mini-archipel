#!/usr/bin/env python3
"""Install Automation helpers and explicitly migrate/roll back the localized companion."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import platform
import shutil
import subprocess
import sys
import tempfile

APP_FILE = "Mini Archipel Plugin - Automation.app"
BUNDLE_ID = "local.yaindrop.agent-script-runner"


def companion_paths():
    return {"current.app": Path.home() / "Applications" / APP_FILE,
            "legacy.app": Path.home() / "Agent Script Runner.app",
            "runner": Path.home() / "agent-script-runner"}


def verify_app(app):
    with (app / "Contents/Info.plist").open("rb") as stream:
        if plistlib.load(stream).get("CFBundleIdentifier") != BUNDLE_ID:
            raise SystemExit("Existing companion has a different identity; no files changed")
    subprocess.run(["/usr/bin/codesign", "--verify", "--strict", str(app)], check=True, capture_output=True)


def assert_companion_idle():
    script = "ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationsWithBundleIdentifier('" + BUNDLE_ID + "').count.toString();"
    result = subprocess.run(["/usr/bin/osascript", "-l", "JavaScript", "-e", script], check=True, capture_output=True, text=True)
    if result.stdout.strip() != "0":
        raise SystemExit("Automation companion is running; finish its accepted request before upgrading")


def snapshot_companion(root):
    root.mkdir(parents=True, mode=0o700, exist_ok=True)
    backup = Path(tempfile.mkdtemp(prefix="automation-", dir=root))
    for name, path in companion_paths().items():
        if path.is_dir():
            shutil.copytree(path, backup / name)
        elif path.is_file():
            shutil.copy2(path, backup / name)
    return backup


def restore_companion(backup):
    for name, path in companion_paths().items():
        if path.is_dir():
            shutil.rmtree(path)
        elif path.exists():
            path.unlink()
        source = backup / name
        if source.is_dir():
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(source, path)
        elif source.is_file():
            shutil.copy2(source, path)


def invalidate_permission_cache(root):
    path = root / ".permissions.json"
    if path.exists():
        # A cached success from a previous signed App is not a current capability check.
        backup = root / "permission-history"
        backup.mkdir(mode=0o700, exist_ok=True)
        path.rename(backup / ("permissions-" + str(os.stat(path).st_mtime_ns) + ".json"))


def register_app():
    register = Path("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister")
    if register.is_file():
        for name, app in companion_paths().items():
            if name.endswith(".app") and app.is_dir():
                subprocess.run([str(register), "-f", str(app)], check=True, capture_output=True)


def install_locked():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rollback", action="store_true", help="Restore the previous helper release and its companion backup")
    parser.add_argument("--upgrade-app", action="store_true", help="Explicitly replace an existing localized companion, preserving a rollback copy")
    parser.add_argument("--companion", type=Path, help="Use an already-built, signed companion instead of building locally")
    args = parser.parse_args()
    if sys.platform != "darwin":
        raise SystemExit("Desktop automation requires macOS")
    source = Path(__file__).resolve().parent / "runtime"
    target = Path.home() / ".local/libexec/mini-archipel-desktop"
    previous = target.with_name(target.name + ".previous")
    root = Path.home() / ".local/share/mini-archipel/desktop-automation"
    app = companion_paths()["current.app"]
    runner = companion_paths()["runner"]
    if target.exists():
        state = subprocess.run([str(target / "desktop-automation"), "status"], capture_output=True, text=True, check=True)
        if any(job["status"] in {"queued", "running", "waiting_user"} for job in json.loads(state.stdout)["data"]["jobs"]):
            raise SystemExit("Desktop jobs are active; wait or cancel before upgrading")
    for name, existing in companion_paths().items():
        if name.endswith(".app") and existing.exists():
            verify_app(existing)
    assert_companion_idle()
    target.parent.mkdir(parents=True, exist_ok=True)
    if args.rollback:
        if not previous.is_dir():
            raise SystemExit("No previous helper release is available")
        manifest = target / "companion-backup.json"
        restore = Path(json.loads(manifest.read_text())["directory"]) if manifest.is_file() else None
        if restore:
            allowed = (root / "companion-backups").resolve()
            if not restore.resolve().is_relative_to(allowed) or not restore.is_dir():
                raise SystemExit("Companion backup is unavailable or outside its owned directory")
        if restore:
            for name in ["current.app", "legacy.app"]:
                if (restore / name).is_dir():
                    verify_app(restore / name)
        current = snapshot_companion(root / "companion-backups")
        with tempfile.TemporaryDirectory(prefix=".desktop-rollback-", dir=target.parent) as temporary:
            displaced = Path(temporary) / "current"
            target.rename(displaced)
            previous.rename(target)
            try:
                if restore:
                    restore_companion(restore)
                register_app()
                subprocess.run([str(target / "desktop-automation"), "status"], check=True, capture_output=True)
            except Exception:
                restore_companion(current)
                target.rename(previous)
                displaced.rename(target)
                raise
            displaced.rename(previous)
            (target / "companion-backup.json").write_text(json.dumps({"directory": str(current)}))
        invalidate_permission_cache(root)
        print(json.dumps({"ok": True, "rolled_back": True, "toolkit": str(target), "backup": str(current)}))
        return
    if runner.exists() and not any(path.is_dir() for name, path in companion_paths().items() if name.endswith(".app")):
        raise SystemExit("Runner CLI exists without its App; inspect the partial installation first")
    with tempfile.TemporaryDirectory(prefix=".desktop-install-", dir=target.parent) as temporary:
        staged = Path(temporary) / "toolkit"
        shutil.copytree(source, staged, ignore=shutil.ignore_patterns("__pycache__", "test_*"))
        for name in ["codex-ui", "zcode-ui", "permissions"]:
            subprocess.run(["/usr/bin/xcrun", "swiftc", "-swift-version", "5", "-target", platform.machine() + "-apple-macos15.0", str(staged / (name + ".swift")), "-o", str(staged / name)], check=True)
        for name in ["desktop-automation", "codex-chat", "zcode-chat", "agent-script-runner"]:
            (staged / name).chmod(0o700)
        replace_app = not app.exists() or args.upgrade_app or args.companion is not None
        candidate = args.companion
        if replace_app:
            if candidate is None:
                candidate = Path(temporary) / APP_FILE
                subprocess.run([sys.executable, str(staged / "build.py"), "--output", str(candidate)], check=True)
            verify_app(candidate)
        backup = snapshot_companion(root / "companion-backups")
        (staged / "companion-backup.json").write_text(json.dumps({"directory": str(backup)}))
        manifest = {"version": "1.1.0", "sha256": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in staged.iterdir() if p.is_file()}}
        (staged / "manifest.json").write_text(json.dumps(manifest, indent=2))
        if previous.exists():
            shutil.rmtree(previous)
        if target.exists():
            target.rename(previous)
        try:
            if replace_app:
                for name, path in companion_paths().items():
                    if name.endswith(".app") and path.exists():
                        shutil.rmtree(path)
                app.parent.mkdir(parents=True, exist_ok=True)
                shutil.copytree(candidate, app)
            shutil.copy2(staged / "agent-script-runner", runner)
            runner.chmod(0o700)
            staged.rename(target)
            register_app()
            subprocess.run([str(target / "desktop-automation"), "status"], check=True, capture_output=True)
        except Exception:
            restore_companion(backup)
            if target.exists():
                shutil.rmtree(target)
            if previous.exists():
                previous.rename(target)
            raise
    if replace_app:
        invalidate_permission_cache(root)
    print(json.dumps({"ok": True, "toolkit": str(target / "desktop-automation"), "app": str(app), "backup": str(backup)}))


def install():
    root = Path.home() / ".local/share/mini-archipel/desktop-automation"
    root.mkdir(parents=True, mode=0o700, exist_ok=True)
    descriptors = []
    try:
        for name in [".install.lock", ".desktop-worker.lock"]:
            fd = os.open(root / name, os.O_CREAT | os.O_RDWR, 0o600)
            descriptors.append(fd)
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        install_locked()
    except BlockingIOError:
        raise SystemExit("Desktop job or installer is active; wait before upgrading") from None
    finally:
        for fd in descriptors:
            os.close(fd)


if __name__ == "__main__":
    install()
