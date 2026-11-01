#!/usr/bin/env python3
"""Install the standalone backend; preserve unrelated proxies and system settings."""

import argparse
import json
import os
import platform
import plistlib
import shutil
import signal
import socket
import subprocess
import time
import uuid
from pathlib import Path

import backend
from backend import service_info
from fetch import LOCK, SOURCE, verify_assets


def managed(paths):
    return {
        **{"bin/" + name: paths.assets / name for name in LOCK["files"]},
        "backend.py": paths.root / "backend.py",
        "nodes.json": paths.nodes,
        "config.json": paths.config,
        "mini-proxy-select": paths.launcher,
        "service.plist": paths.plist,
        "release.json": paths.root / "release.json",
        "rollback.json": paths.root / "rollback.json",
    }


def stop_service(paths):
    pid = service_info(paths)
    if pid is None:
        return
    subprocess.run(["/bin/launchctl", "bootout", paths.service], capture_output=True, timeout=15)
    for _ in range(50):
        alive = False
        if pid:
            try:
                os.kill(pid, 0)
                alive = True
            except ProcessLookupError:
                pass
        if service_info(paths) is None and not alive:
            return
        time.sleep(0.2)
    raise backend.Failure("mini-proxy did not stop; files preserved")


def start_service(paths):
    subprocess.run(
        ["/bin/launchctl", "enable", paths.service], check=True, capture_output=True, timeout=5
    )
    subprocess.run(
        ["/bin/launchctl", "bootstrap", f"gui/{os.getuid()}", str(paths.plist)],
        check=True,
        capture_output=True,
        timeout=15,
    )
    for _ in range(40):
        pid = service_info(paths)
        if backend.owns_listener(pid, 10808):
            if backend.network_latency(10808) is not None:
                return
            raise backend.Failure("Installed proxy failed its HTTP 204 health check")
        time.sleep(0.2)
    raise backend.Failure("Installed proxy did not own port 10808")


def require_free_port(port=10808):
    with socket.socket() as listener:
        # A stopped proxy can leave accepted connections in TIME_WAIT.
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            listener.bind(("127.0.0.1", port))
        except OSError:
            raise backend.Failure(
                "Port 10808 is occupied by another service; no automatic migration is performed"
            ) from None


def backup_root(paths):
    return paths.home / ".local/share/mini-archipel/mini-proxy-backups"


def snapshot(paths, loaded):
    directory = backup_root(paths) / (time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8])
    directory.mkdir(parents=True, mode=0o700)
    present = []
    for name, path in managed(paths).items():
        if path.exists():
            (directory / name).parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            shutil.copy2(path, directory / name)
            (directory / name).chmod(0o600)
            present.append(name)
    backend.atomic_write(
        directory / "snapshot.json", backend.json_bytes({"present": present, "loaded": loaded})
    )
    return directory


def rollback_state(paths, directory):
    if directory.resolve().parent != backup_root(paths).resolve():
        raise backend.Failure("Invalid rollback location")
    state = json.loads((directory / "snapshot.json").read_text())
    if (
        not isinstance(state, dict)
        or not isinstance(state.get("present"), list)
        or any(not isinstance(name, str) for name in state["present"])
        or set(state["present"]) - set(managed(paths))
    ):
        raise backend.Failure("Invalid rollback manifest")
    if type(state.get("loaded")) is not bool or any(
        not (directory / name).is_file() or (directory / name).is_symlink()
        for name in state["present"]
    ):
        raise backend.Failure("Incomplete rollback snapshot")
    return state


def restore(paths, directory):
    state = rollback_state(paths, directory)
    for name, path in managed(paths).items():
        path.unlink(missing_ok=True)
        if name in state["present"]:
            path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
            shutil.copy2(directory / name, path)
            path.chmod(0o700 if name in {"mini-proxy-select", "bin/xray"} else 0o600)
    if state["loaded"]:
        start_service(paths)


def service_plist(paths):
    log = paths.home / "Library/Logs/MiniProxy/xray.log"
    return plistlib.dumps(
        {
            "Label": backend.LABEL,
            "ProgramArguments": [str(paths.xray), "run", "-c", str(paths.config)],
            "EnvironmentVariables": {"XRAY_LOCATION_ASSET": str(paths.assets)},
            "RunAtLoad": True,
            "KeepAlive": True,
            "ThrottleInterval": 10,
            "Umask": 63,
            "StandardOutPath": str(log),
            "StandardErrorPath": str(log),
        }
    )


def install(paths, assets, nodes_source=None, node=None, rollback=False):
    for path in managed(paths).values():
        backend.reject_gui_path(path)
        if path.is_symlink():
            raise backend.Failure("Managed installation paths must not be symlinks")
    with backend.operation_lock(paths):
        backend.ensure_idle()
        if paths.plist.exists():
            backend.verify_owner(paths)
        elif any(path.exists() for path in [paths.config, paths.launcher]):
            raise backend.Failure("Partial installation found; inspect it before installing")
        loaded = service_info(paths) is not None
        if not loaded:
            require_free_port()
        if rollback:
            marker = json.loads((paths.root / "rollback.json").read_text())
            if not isinstance(marker, dict) or not isinstance(marker.get("backup"), str):
                raise backend.Failure("Invalid rollback marker")
            directory = Path(marker["backup"])
            if directory.resolve().parent != backup_root(paths).resolve():
                raise backend.Failure("Invalid rollback location")
            rollback_state(paths, directory)
            backend.ensure_idle()
            stop_service(paths)
            restore(paths, directory)
            return {"ok": True, "rolled_back": True}
        backend.reject_gui_path(assets)
        verify_assets(assets)
        if not paths.nodes.exists() and (nodes_source is None or node is None):
            raise backend.Failure("First installation requires --nodes and --node")
        nodes = backend.load_nodes(nodes_source or paths.nodes)
        previous = json.loads(paths.config.read_text()) if paths.config.exists() else None
        if node is None and previous:
            try:
                node = next(o for o in previous["outbounds"] if o.get("tag") == "proxy")[
                    "settings"
                ]["vnext"][0]["users"][0]["email"]
            except (KeyError, IndexError, StopIteration, TypeError, AttributeError):
                raise backend.Failure(
                    "Existing configuration has no node identity; supply --node"
                ) from None
        candidate = backend.configure(nodes, node, previous)
        staged_paths = backend.Paths(paths.home)
        staged_paths.assets = assets
        staged_paths.xray = assets / "xray"
        backend.check_candidate(staged_paths, candidate)
        backend.ensure_idle()
        saved = snapshot(paths, loaded)
        stopped = False
        try:
            stop_service(paths)
            stopped = True
            require_free_port()
            for name in LOCK["files"]:
                backend.atomic_write(
                    paths.assets / name,
                    (assets / name).read_bytes(),
                    0o700 if name == "xray" else 0o600,
                )
            backend.atomic_write(paths.root / "backend.py", (SOURCE / "backend.py").read_bytes())
            backend.atomic_write(paths.launcher, (SOURCE / "mini-proxy-select").read_bytes(), 0o700)
            backend.atomic_write(paths.nodes, backend.json_bytes(nodes))
            backend.atomic_write(paths.config, backend.json_bytes(candidate))
            (paths.home / "Library/Logs/MiniProxy").mkdir(parents=True, mode=0o700, exist_ok=True)
            backend.atomic_write(paths.plist, service_plist(paths))
            start_service(paths)
            backend.atomic_write(paths.root / "release.json", backend.json_bytes(LOCK))
            backend.atomic_write(
                paths.root / "rollback.json", backend.json_bytes({"backup": str(saved)})
            )
        except BaseException as error:
            if stopped:
                try:
                    stop_service(paths)
                    restore(paths, saved)
                except Exception:
                    raise backend.Failure(
                        "Install failed and recovery needs attention; backup: " + str(saved)
                    ) from error
                raise backend.Failure(
                    "Install failed; previous files/service restored; backup: " + str(saved)
                ) from error
            raise backend.Failure(
                "Installation stopped before replacing files; check service state; backup: "
                + str(saved)
            ) from error
        return {
            "ok": True,
            "xray_version": LOCK["version"],
            "backup": str(saved),
            "service": paths.service,
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets", type=Path, default=SOURCE / ".cache/assets")
    parser.add_argument(
        "--nodes", type=Path, help="Private node file; required on first installation"
    )
    parser.add_argument(
        "--node", help="Initial exit node; omitted upgrades retain the current node"
    )
    parser.add_argument("--rollback", action="store_true")
    args = parser.parse_args()
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        parser.error("This release supports macOS Apple Silicon")
    if os.getuid() == 0:
        parser.error("Run as the logged-in desktop user, not root")
    signal.signal(signal.SIGTERM, backend.interrupted)
    try:
        result = install(
            backend.Paths(Path.home()), args.assets, args.nodes, args.node, args.rollback
        )
    except backend.Failure as error:
        parser.exit(1, str(error) + "\n")
    except (OSError, ValueError, subprocess.SubprocessError, KeyboardInterrupt):
        parser.exit(
            1,
            "mini-proxy installation failed; inspect assets, private profiles, "
            "CI/operation locks, port ownership and local backups\n",
        )
    print(json.dumps(result))


if __name__ == "__main__":
    main()
