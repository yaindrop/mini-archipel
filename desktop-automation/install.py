#!/usr/bin/env python3
"""Install node helpers while preserving an already-authorized Runner App."""
import json
import argparse
import hashlib
import fcntl
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile


def install_locked():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rollback", action="store_true", help="Restore the previous helper release without replacing the App")
    args = parser.parse_args()
    if sys.platform != "darwin":
        raise SystemExit("Desktop automation requires macOS")
    source = Path(__file__).resolve().parent / "runtime"
    target = Path.home() / ".local/libexec/mini-archipel-desktop"
    app = Path.home() / "Agent Script Runner.app"
    runner = Path.home() / "agent-script-runner"
    previous = target.with_name(target.name + ".previous")
    if target.exists():
        state = subprocess.run([str(target / "desktop-automation"), "status"], capture_output=True, text=True, check=True)
        if any(job["status"] in {"queued", "running", "waiting_user"} for job in json.loads(state.stdout)["data"]["jobs"]):
            raise SystemExit("Desktop jobs are active; wait or cancel before upgrading")
    if args.rollback:
        if not previous.is_dir():
            raise SystemExit("No previous helper release is available")
        with tempfile.TemporaryDirectory(prefix=".desktop-rollback-", dir=target.parent) as temporary:
            displaced = Path(temporary) / "current"
            if target.exists():
                target.rename(displaced)
            previous.rename(target)
            try:
                subprocess.run([str(target / "desktop-automation"), "status"], check=True, capture_output=True)
            except Exception:
                target.rename(previous)
                if displaced.exists():
                    displaced.rename(target)
                raise
            if displaced.exists():
                displaced.rename(previous)
        print(json.dumps({"ok": True, "rolled_back": True, "toolkit": str(target)}))
        return
    if app.exists():
        with (app / "Contents/Info.plist").open("rb") as stream:
            if plistlib.load(stream).get("CFBundleIdentifier") != "local.yaindrop.agent-script-runner":
                raise SystemExit("Existing App has a different identity; no files changed")
    elif runner.exists():
        raise SystemExit("Runner CLI exists without its App; inspect the partial installation first")
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".desktop-install-", dir=target.parent) as temporary:
        staged = Path(temporary) / "toolkit"
        shutil.copytree(source, staged, ignore=shutil.ignore_patterns("__pycache__", "test_*"))
        for name in ["codex-ui", "zcode-ui", "permissions"]:
            subprocess.run(["/usr/bin/xcrun", "swiftc", str(staged / (name + ".swift")), "-o", str(staged / name)], check=True)
        for name in ["desktop-automation", "codex-chat", "zcode-chat", "agent-script-runner"]:
            (staged / name).chmod(0o700)
        manifest = {"version": "1.0.0", "sha256": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in staged.iterdir() if p.is_file()}}
        (staged / "manifest.json").write_text(json.dumps(manifest, indent=2))
        if not app.exists():
            subprocess.run([sys.executable, str(staged / "build.py")], check=True)
        elif not runner.exists():
            shutil.copy2(staged / "agent-script-runner", runner)
            runner.chmod(0o700)
        if previous.exists():
            shutil.rmtree(previous)
        if target.exists():
            target.rename(previous)
        try:
            staged.rename(target)
            subprocess.run([str(target / "desktop-automation"), "status"], check=True, capture_output=True)
        except Exception:
            if target.exists():
                shutil.rmtree(target)
            if previous.exists():
                previous.rename(target)
            raise
    print(json.dumps({"ok": True, "toolkit": str(target / "desktop-automation"), "app": str(app)}))


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
