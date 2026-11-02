#!/usr/bin/env python3
"""Move installed plugin paths, retaining one writable copy and reversible aliases.

Run from the fixed source checkout, under the operator's drained maintenance window.
This does not stop Agent/Apps/Runners or operate any GUI proxy client.
"""
import argparse
import base64
from contextlib import contextmanager, ExitStack
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import re
import stat
import subprocess
import sys
import tempfile

SOURCE = Path(__file__).resolve().parent
sys.path.insert(0, str(SOURCE / "proxy"))
import backend
import install as proxy_install

spec = importlib.util.spec_from_file_location("service_migration", SOURCE / "proxy/migrate-service.py")
service_migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service_migration)
Failure = backend.Failure
PLUGINS = ("proxy", "automation", "screen-recording", "fan-control")


def exists(path):
    return path.exists() or path.is_symlink()


def sync(directory):
    fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic(path, data, mode=0o600):
    fd, name = tempfile.mkstemp(prefix=".layout-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        sync(path.parent)
    finally:
        Path(name).unlink(missing_ok=True)


def identity(path):
    s = path.lstat()
    if s.st_uid != os.getuid():
        raise Failure("Layout object is not owned by the current user")
    if not (stat.S_ISREG(s.st_mode) or stat.S_ISDIR(s.st_mode) or stat.S_ISLNK(s.st_mode)):
        raise Failure("Special files cannot be migrated")
    return [s.st_dev, s.st_ino, stat.S_IFMT(s.st_mode), stat.S_IMODE(s.st_mode)]


def digest(path):
    """No following links, including App/framework links inside historical backups."""
    entries = [path, *sorted(path.rglob("*"))] if path.is_dir() and not path.is_symlink() else [path]
    h = hashlib.sha256()
    for entry in entries:
        info = identity(entry)
        h.update(str(entry.relative_to(path)).encode())
        h.update(str(info[2:]).encode())
        if entry.is_symlink():
            h.update(os.readlink(entry).encode())
        elif entry.is_file():
            with entry.open("rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    h.update(block)
    return h.hexdigest()


def real_parents(path):
    for parent in path.parents:
        if parent.is_symlink():
            raise Failure("Layout path has an unexpected directory alias")
        if parent.exists() and not parent.is_dir():
            raise Failure("Layout parent is not a directory")


class Transaction:
    """Four concrete filesystem actions; every action also recognizes its crash gap."""
    def __init__(self, home, plugin):
        self.home = Path(home).resolve()
        self.plugin = plugin
        self.directory = self.home / ".local/share/mini-archipel/migrations"
        self.path = self.directory / ("layout-v1-" + plugin + ".json")
        self.actions = []
        self.state = {"version": 1, "home": str(self.home), "plugin": plugin,
                      "phase": "planned", "actions": self.actions, "service": None}
        self.after_action = lambda: None  # Tests inject process loss after each filesystem mutation.

    def save(self):
        atomic(self.path, backend.json_bytes(self.state))

    def load(self):
        real_parents(self.path)
        if self.path.is_symlink() or identity(self.path)[3] != 0o600:
            raise Failure("Migration journal must be a private regular file")
        state = json.loads(self.path.read_text())
        if (state.get("version") != 1 or state.get("home") != str(self.home)
                or state.get("plugin") != self.plugin
                or state.get("phase") not in {"planned", "forward", "migrated", "reverse", "rolled_back"}):
            raise Failure("Invalid layout journal")
        self.state = state
        self.actions = state["actions"]
        # A corrupt journal must not turn recovery into writes outside this plugin's paths.
        for a in self.actions:
            if a.get("op") not in {"mkdir", "move", "hardlink", "write"}:
                raise Failure("Unknown layout action")
            for key in ("src", "dst", "path"):
                if key in a:
                    p = Path(a[key])
                    if not p.is_absolute() or ".." in p.parts or not self.allowed(p, parents=a["op"] == "mkdir"):
                        raise Failure("Layout journal contains an out-of-scope path")
        return self

    def allowed(self, p, parents=False):
        h = self.home
        roots = {
            "proxy": [h/".local/mini-proxy", h/".config/mini-proxy", h/".local/libexec/mini-archipel/proxy",
                      h/".local/share/mini-archipel/proxy", h/".local/share/mini-archipel/mini-proxy-backups",
                      h/"Library/Logs/MiniProxy", h/"Library/Logs/MiniArchipel/proxy"],
            "automation": [h/".local/libexec/mini-archipel-desktop", h/".local/libexec/mini-archipel-desktop.previous",
                           h/".local/libexec/mini-archipel/automation", h/".local/share/mini-archipel/desktop-automation",
                           h/".local/share/mini-archipel/automation", h/".agent-chat-requests"],
            "screen-recording": [h/".local/libexec/mini-archipel-screen-recorder", h/".local/libexec/mini-archipel/screen-recording"],
            "fan-control": [h/".local/share/mini-archipel/plugins/fan-control", h/".local/libexec/mini-archipel/fan-control",
                            h/".local/share/mini-archipel/fan-control/backups"],
        }[self.plugin]
        exact = {
            "proxy": [h/".local/bin/mini-proxy-select", h/"Library/LaunchAgents/local.miniarchipel.proxy.plist"],
            "automation": [h/"agent-script-runner", h/".codex-chat.lock", h/".agent-chat-native.lock"],
        }.get(self.plugin, [])
        if self.plugin == "fan-control":
            for part in p.parents:
                if part.parent == h/".local/share/mini-archipel/plugins" and re.fullmatch(r"fan-control.previous-[0-9-]+", part.name):
                    roots.append(part)
            if p.parent == h/".local/share/mini-archipel/plugins" and re.fullmatch(r"fan-control.previous-[0-9-]+", p.name):
                roots.append(p)
        return p in exact or any(p == r or r in p.parents for r in roots) or (parents and any(p in r.parents and p != h for r in roots))

    def original(self, path):
        # Translate a planned destination back through earlier moves, without mutating disk.
        for a in reversed(self.actions):
            if a["op"] == "move":
                dst = Path(a["dst"])
                if path == dst or dst in path.parents:
                    path = Path(a["src"]) / path.relative_to(dst)
        return path

    def mkdir(self, path):
        if any(a["op"] == "mkdir" and a["path"] == str(path) for a in self.actions):
            return
        original = self.original(path)
        if exists(original):
            if original.is_symlink() or not original.is_dir():
                raise Failure("Expected a real layout directory")
            identity(original)
            return
        if path == self.home:
            raise Failure("Home is missing")
        self.mkdir(path.parent)
        self.actions.append({"op": "mkdir", "path": str(path)})

    def move(self, src, dst, mutable=False, hard=False):
        original = self.original(src)
        if not exists(original):
            return
        real_parents(original)
        if original.is_symlink():
            raise Failure("Unjournaled layout aliases must be inspected")
        identity(original)
        if exists(self.original(dst)):
            raise Failure("Both legacy and canonical layout objects exist")
        self.mkdir(dst.parent)
        parent = self.original(dst.parent)
        while not parent.exists():
            parent = parent.parent
        if original.stat().st_dev != parent.stat().st_dev:
            raise Failure("Layout rename/hardlink must stay on one filesystem")
        self.actions.append({"op": "hardlink" if hard else "move", "src": str(src), "dst": str(dst),
                             "identity": identity(original), "digest": digest(original), "mutable": mutable})

    def write(self, path, data):
        original = self.original(path)
        if original.is_symlink() or not original.is_file():
            raise Failure("Management code/plist must be an existing regular file")
        before = original.read_bytes()
        if before == data:
            return
        self.actions.append({"op": "write", "path": str(path), "mode": identity(original)[3],
                             "before": base64.b64encode(before).decode(), "after": base64.b64encode(data).decode()})

    def parents(self, path):
        allowed = {a["src"]: a["dst"] for a in self.actions if a["op"] == "move"}
        for parent in path.parents:
            if parent.is_symlink() and os.readlink(parent) != allowed.get(str(parent)):
                raise Failure("Layout parent alias changed")

    def check_object(self, a, path):
        if not exists(path) or path.is_symlink():
            raise Failure("Migrated object is missing or is an unexpected link")
        current = identity(path)
        if current[2] != a["identity"][2]:
            raise Failure("Migrated object type changed")
        if not a["mutable"]:
            if digest(path) != a["digest"]:
                raise Failure("Program or backup changed; refusing to overwrite external changes")
        elif path.is_dir() or Path(a["src"]).name.endswith(".lock"):
            if current[:2] != a["identity"][:2]:
                raise Failure("State directory or lock inode changed")

    def mutate(self, call, *args):
        call(*args)
        for p in args:
            if isinstance(p, Path) and p.parent.is_dir():
                sync(p.parent)
        self.after_action()

    def step(self, a, reverse=False):
        op = a["op"]
        if op == "mkdir":
            p = Path(a["path"])
            self.parents(p)
            if reverse:
                if exists(p):
                    if p.is_symlink() or not p.is_dir():
                        raise Failure("Created layout directory was replaced")
                    # Nonempty means post-migration data needs an explicit owner; do not delete it.
                    self.mutate(os.rmdir, p)
            elif not exists(p):
                self.mutate(lambda q: q.mkdir(mode=0o700), p)
            elif p.is_symlink() or not p.is_dir() or identity(p)[3] != 0o700:
                raise Failure("Created layout directory changed")
            return
        if op == "write":
            p = Path(a["path"])
            self.parents(p)
            before, after = (base64.b64decode(a[k], validate=True) for k in ("before", "after"))
            source, target = (after, before) if reverse else (before, after)
            if p.is_symlink() or not p.is_file() or identity(p)[3] != a["mode"]:
                raise Failure("Management object was replaced")
            actual = p.read_bytes()
            if actual == target:
                return
            if actual != source:
                raise Failure("Management object changed; recovery will not overwrite it")
            atomic(p, target, a["mode"])
            self.after_action()
            return
        src, dst = Path(a["src"]), Path(a["dst"])
        self.parents(src)
        self.parents(dst)
        if op == "hardlink":
            if src.is_symlink() or identity(src)[:2] != a["identity"][:2]:
                raise Failure("Native lock was replaced")
            if exists(dst):
                if dst.is_symlink() or identity(dst)[:2] != a["identity"][:2]:
                    raise Failure("Native lock aliases do not share an inode")
                if reverse:
                    self.mutate(os.unlink, dst)
            elif not reverse:
                self.mutate(os.link, src, dst)
            return
        if exists(dst):
            self.check_object(a, dst)
            if exists(src):
                if not src.is_symlink() or os.readlink(src) != str(dst):
                    raise Failure("Legacy alias changed or two writable objects exist")
                identity(src)
            if reverse:
                if src.is_symlink():
                    self.mutate(os.unlink, src)
                self.mutate(os.rename, dst, src)
            elif not exists(src):
                self.mutate(os.symlink, dst, src)
        else:
            self.check_object(a, src)
            if not reverse:
                self.mutate(os.rename, src, dst)
                self.mutate(os.symlink, dst, src)

    def verify(self, reverse=False):
        for a in self.actions:
            if a["op"] in {"move", "hardlink"}:
                src, dst = Path(a["src"]), Path(a["dst"])
                self.parents(src)
                self.parents(dst)
                if reverse:
                    if not exists(src) or src.is_symlink() or exists(dst):
                        raise Failure("Rolled-back layout changed")
                elif a["op"] == "hardlink":
                    if src.is_symlink() or dst.is_symlink() or identity(src)[:2] != identity(dst)[:2]:
                        raise Failure("Layout lock aliases changed")
                elif not src.is_symlink() or os.readlink(src) != str(dst) or not exists(dst) or dst.is_symlink():
                    raise Failure("Migrated layout aliases changed")
            elif a["op"] == "write":
                # A parent program may have moved; its retained alias keeps this path usable.
                p = Path(a["path"])
                if not reverse or p.exists():
                    if p.is_symlink() or p.read_bytes() != base64.b64decode(a["before" if reverse else "after"]):
                        raise Failure("Management code/plist changed outside migration")

    def run(self, reverse=False):
        target = "rolled_back" if reverse else "migrated"
        if self.state["phase"] == target:
            return
        self.state["phase"] = "reverse" if reverse else "forward"
        self.save()
        # Record cursor before action. A crash after rename, link, or write is inferred safely.
        indices = range(len(self.actions)-1, -1, -1) if reverse else range(len(self.actions))
        for i in indices:
            a = self.actions[i]
            done = a.get("done", False)
            if (reverse and not done and self.state.get("pending") != i) or (not reverse and done):
                continue
            self.state["pending"] = i
            self.save()
            self.step(a, reverse)
            a["done"] = not reverse
            self.state.pop("pending", None)
            self.save()
        self.state["phase"] = target
        self.save()


def plan(t):
    h = t.home
    program = h/".local/libexec/mini-archipel"/t.plugin
    state = h/".local/share/mini-archipel"/t.plugin
    legacy = {
        "proxy": h/".local/mini-proxy", "automation": h/".local/libexec/mini-archipel-desktop",
        "screen-recording": h/".local/libexec/mini-archipel-screen-recorder",
        "fan-control": h/".local/share/mini-archipel/plugins/fan-control",
    }[t.plugin]
    if not exists(legacy):
        if exists(program) or (t.plugin != "screen-recording" and exists(state)):
            raise Failure("Canonical installation exists without this migration journal")
        return False
    real_parents(legacy)
    if legacy.is_symlink() or not legacy.is_dir() or exists(program):
        raise Failure("Unexpected or duplicate program layout")
    if t.plugin != "screen-recording" and exists(state):
        raise Failure("Canonical state already exists without a journal")
    if t.plugin == "proxy":
        known = {"bin", "backend.py", "nodes.json", "release.json", "rollback.json", ".operation.lock", "service-label-migration.json", "__pycache__"}
        if set(p.name for p in legacy.iterdir()) - known:
            raise Failure("Unknown proxy root contents; classify before migration")
        p = backend.Paths(h)
        if p.label != backend.LABEL:
            raise Failure("Migrate the proxy service label before its directory layout")
        backend.verify_owner(p)
        for required in (p.xray, p.nodes, p.config, p.launcher, legacy/"backend.py", p.lock):
            if required.is_symlink() or not required.is_file():
                raise Failure("Incomplete proxy installation")
        for name in ("bin", "backend.py", "__pycache__"):
            t.move(legacy/name, program/name, mutable=name == "__pycache__")
        t.move(p.launcher, program/"mini-proxy-select")
        for name in ("nodes.json", "release.json", "rollback.json", ".operation.lock", "service-label-migration.json"):
            t.move(legacy/name, state/name, mutable=name != "service-label-migration.json", hard=name == ".operation.lock")
        for name in ("config.json", "config.json.previous"):
            t.move(p.config.parent/name, state/name, mutable=True)
        t.move(p.backups, state/"backups", mutable=True)
        t.move(p.logs, h/"Library/Logs/MiniArchipel/proxy", mutable=True)
        t.write(program/"backend.py", (SOURCE/"proxy/backend.py").read_bytes())
        data = plistlib.loads(p.plist.read_bytes())
        data["ProgramArguments"] = [str(program/"bin/xray"), "run", "-c", str(state/"config.json")]
        data.setdefault("EnvironmentVariables", {})["XRAY_LOCATION_ASSET"] = str(program/"bin")
        for key in ("StandardOutPath", "StandardErrorPath"):
            if key in data:
                oldlog = Path(data[key])
                if oldlog.parent != p.logs:
                    raise Failure("Proxy log path is not the owned legacy directory")
                data[key] = str(h/"Library/Logs/MiniArchipel/proxy"/oldlog.name)
        t.write(p.plist, plistlib.dumps(data))
    elif t.plugin == "automation":
        oldstate = h/".local/share/mini-archipel/desktop-automation"
        if not oldstate.is_dir() or oldstate.is_symlink():
            raise Failure("Automation state must exist as a real directory")
        t.move(oldstate, state, mutable=True)
        t.move(h/".agent-chat-requests", state/"chat-requests", mutable=True)
        for name in (".codex-chat.lock", ".agent-chat-native.lock"):
            t.move(h/name, state/name, mutable=True, hard=True)
        t.move(legacy.with_name(legacy.name+".previous"), state/"backups/previous")
        t.move(legacy/"companion-backup.json", state/"companion-backup.json", mutable=True)
        # Both copies are real launchers in existing installations. Keep both callable.
        runner = (SOURCE/"automation/runtime/agent-script-runner").read_bytes()
        t.write(legacy/"agent-script-runner", runner)
        t.write(h/"agent-script-runner", runner)
        manifest = legacy/"manifest.json"
        if manifest.is_file():
            data = json.loads(manifest.read_text())
            data["sha256"]["agent-script-runner"] = hashlib.sha256(runner).hexdigest()
            t.write(manifest, backend.json_bytes(data))
        # Program identity will change only by the journaled writes above. Verify each write separately.
        t.move(legacy, program, mutable=True)
    elif t.plugin == "screen-recording":
        # Foundation attributesOfItem rejects a symlink supportRoot; retain its real directory.
        t.move(legacy, program, mutable=True)
    else:
        for previous in sorted(legacy.parent.glob("fan-control.previous-*")):
            if not re.fullmatch(r"fan-control.previous-[0-9-]+", previous.name):
                raise Failure("Unknown fan payload backup name")
            t.move(previous, state/"backups"/previous.name)
        t.move(legacy, program, mutable=True)
    return True


def inactive_apps(plugin):
    identifiers = {"automation": "local.yaindrop.agent-script-runner", "screen-recording": "org.agent-screen-recorder.app"}
    if plugin in identifiers:
        script = "ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationsWithBundleIdentifier('"+identifiers[plugin]+"').count.toString();"
        r = subprocess.run(["/usr/bin/osascript", "-l", "JavaScript", "-e", script], check=True, capture_output=True, text=True)
        if r.stdout.strip() != "0":
            raise Failure("Companion is running; finish accepted work and quit it normally first")


def maintenance(plugin):
    service_migration.maintenance_window()
    r = subprocess.run(["/bin/launchctl", "print", "gui/"+str(os.getuid())+"/local.miniarchipel.agent"], capture_output=True)
    if r.returncode == 0:
        raise Failure("Stop the idle Agent under the maintenance window before migrating paths")
    inactive_apps(plugin)


def active_jobs(root):
    for p in root.glob("*.json"):
        value = json.loads(p.read_text())
        if isinstance(value, dict) and value.get("status") in {"queued", "running", "waiting_user"}:
            raise Failure("Automation has accepted work; wait without replaying or recovering it")


@contextmanager
def locks(t, ci_fd=None):
    """Only nonblocking locks; never hold admission while waiting for a worker."""
    h = t.home
    mutex = h/".local/state/mini-archipel/ci/mutex"
    paths = [mutex]
    if ci_fd is not None:
        real_parents(mutex)
        held = os.fstat(ci_fd)
        current = mutex.stat()
        if mutex.is_symlink() or not stat.S_ISREG(held.st_mode) or held.st_uid != os.getuid() or (held.st_dev, held.st_ino) != (current.st_dev, current.st_ino):
            raise Failure("Inherited CI lock fd is not the current mutex inode")
        fcntl.flock(ci_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        paths = []  # Same open-file description remains held by the outer driver.

    if t.plugin == "proxy":
        paths.append(h/".local/mini-proxy/.operation.lock")
    if t.plugin == "automation":
        root = h/".local/share/mini-archipel/desktop-automation"
        if not root.exists():
            root = h/".local/share/mini-archipel/automation"
        active_jobs(root)
        paths += [root/n for n in (".admission.lock", ".install.lock", ".desktop-worker.lock", ".chat-worker.lock")]
        paths += [h/".codex-chat.lock", h/".agent-chat-native.lock"]
        paths += sorted(root.rglob("*.work")) + sorted(root.rglob("*.submit"))
        receipts = h/".agent-chat-requests"
        if not receipts.exists():
            receipts = h/".local/share/mini-archipel/automation/chat-requests"
        paths += sorted(receipts.glob("*.lock"))
    with ExitStack() as stack:
        for p in paths:
            # Locks not yet created by an installed runtime require its normal initialization.
            # A maintenance transaction must never make a second lock after a crash-gap rename.
            if not exists(p) and t.plugin == "proxy" and p.name == ".operation.lock":
                p = h/".local/share/mini-archipel/proxy/.operation.lock"
            if not exists(p):
                if p.name == "mutex":
                    continue  # CI was never installed; no external resource is created.
                if t.plugin == "automation" and p.name in {".desktop-worker.lock", ".chat-worker.lock", ".codex-chat.lock", ".agent-chat-native.lock"}:
                    continue  # Absent optional locks stay absent while Agent/App are stopped.
                raise Failure("Required admission/install lock is missing; inspect runtime state")
            t.parents(p)
            if p.is_symlink():
                aliases = {a["src"]: a["dst"] for a in t.actions if a["op"] == "move"}
                if os.readlink(p) != aliases.get(str(p)):
                    raise Failure("Unexpected lock alias")
                p = Path(os.readlink(p))
            fd = os.open(p, os.O_RDWR | os.O_NOFOLLOW)
            stack.callback(os.close, fd)
            if os.fstat(fd).st_uid != os.getuid():
                raise Failure("Foreign operation lock")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Failure("A runtime/CI/request lock is busy; release and retry later") from None
        if t.plugin == "automation":
            active_jobs(root)
        yield


def service_paths(t):
    # In a crash gap Paths cannot auto-detect the layout; derive only the verified plist's pair.
    p = backend.Paths.__new__(backend.Paths)
    p.home = t.home
    p.label = backend.LABEL
    p.plist = t.home/"Library/LaunchAgents/local.miniarchipel.proxy.plist"
    p.service = "gui/"+str(os.getuid())+"/"+backend.LABEL
    data = plistlib.loads(p.plist.read_bytes())
    allowed = [
        [str(t.home/".local/mini-proxy/bin/xray"), "run", "-c", str(t.home/".config/mini-proxy/config.json")],
        [str(t.home/".local/libexec/mini-archipel/proxy/bin/xray"), "run", "-c", str(t.home/".local/share/mini-archipel/proxy/config.json")],
    ]
    if data.get("Label") != backend.LABEL or data.get("ProgramArguments") not in allowed:
        raise Failure("Proxy plist changed outside the migration")
    p.xray = Path(data["ProgramArguments"][0])
    return p


def migrate(t, reverse=False, ci_fd=None):
    with locks(t, ci_fd):
        maintenance(t.plugin)
        target = "rolled_back" if reverse else "migrated"
        if t.state["phase"] == target and t.state.get("service_restored"):
            t.verify(reverse)
            return
        if t.plugin == "proxy":
            p = service_paths(t)
            if t.state["service"] is None:
                t.state["service"] = {"loaded": backend.service_info(p) is not None, "disabled": service_migration.disabled(p)}
                t.save()
            proxy_install.stop_service(p)
            proxy_install.require_free_port()
        t.state["service_restored"] = False
        t.save()
        try:
            t.run(reverse)
            t.verify(reverse)
            restore_service(t)
        except Exception as error:
            if reverse:
                raise
            try:
                if t.plugin == "proxy":
                    proxy_install.stop_service(service_paths(t))
                    proxy_install.require_free_port()
                t.run(reverse=True)
                t.verify(reverse=True)
                restore_service(t)
            except Exception:
                raise Failure("Layout failed; recovery stopped at a conflict. Preserve the journal and inspect before rollback") from error
            raise Failure("Layout failed; original layout and service state restored. Inspect the private journal before retry") from error


def restore_service(t):
    if t.plugin == "proxy":
        p = service_paths(t)
        if t.state["service"]["loaded"] and backend.service_info(p) is None:
            proxy_install.start_service(p)
        service_migration.set_disabled(p, t.state["service"]["disabled"])
    t.state["service_restored"] = True
    t.save()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plugin", choices=PLUGINS)
    parser.add_argument("action", choices=("plan", "apply", "rollback"))
    parser.add_argument("--ci-lock-fd", type=int, help="Inherited open fd from the maintenance driver; inode and exclusive lock are verified")
    args = parser.parse_args()
    if sys.platform != "darwin" or os.getuid() == 0:
        parser.error("Run as the logged-in macOS user")
    t = Transaction(Path.home(), args.plugin)
    try:
        real_parents(t.path)
        if args.action == "plan":
            if exists(t.path):
                t.load()
            elif not plan(t):
                print(json.dumps({"plugin": args.plugin, "phase": "not_installed"}))
                return
            print(json.dumps({"plugin": args.plugin, "phase": t.state["phase"],
                              "actions": [{k:v for k,v in a.items() if k in {"op","path","src","dst"}} for a in t.actions],
                              "screen_state": "legacy_real_directory_retained" if args.plugin == "screen-recording" else None}))
            return
        t.directory.mkdir(parents=True, mode=0o700, exist_ok=True)
        if t.directory.is_symlink() or identity(t.directory)[3] != 0o700:
            raise Failure("Migration journal directory must be private")
        lock = t.directory/("layout-v1-"+args.plugin+".lock")
        fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if exists(t.path):
                t.load()
            elif args.action == "rollback":
                raise Failure("No layout journal to roll back")
            else:
                if not plan(t):
                    print(json.dumps({"plugin": args.plugin, "phase": "not_installed"}))
                    return
                t.save()
            if args.action == "apply" and t.state["phase"] == "reverse":
                raise Failure("Finish interrupted rollback before applying again")
            migrate(t, reverse=args.action == "rollback", ci_fd=args.ci_lock_fd)
            print(json.dumps({"plugin": args.plugin, "phase": t.state["phase"], "journal": str(t.path),
                              "screen_state": "legacy_real_directory_retained" if args.plugin == "screen-recording" else None}))
        finally:
            os.close(fd)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        # Do not leak private state, command output or backup bytes in diagnostics.
        message = str(error) if isinstance(error, Failure) else "Layout operation stopped; inspect the private journal and retry or roll back under maintenance"
        parser.exit(1, message+"\n")


if __name__ == "__main__":
    main()
