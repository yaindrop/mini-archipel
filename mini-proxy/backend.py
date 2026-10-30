"""Standalone mini-proxy authority. Never operates a GUI proxy installation."""

import argparse
import base64
import copy
import fcntl
import http.client
import json
import os
import plistlib
import re
import signal
import socket
import ssl
import subprocess
import tempfile
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

LABEL = "com.mini.proxy"


class Failure(ValueError):
    """A diagnostic that never includes credentials or raw subprocess output."""


class Paths:
    def __init__(self, home):
        self.home = Path(home)
        self.root = self.home / ".local/mini-proxy"
        self.assets = self.root / "bin"
        self.xray = self.assets / "xray"
        self.nodes = self.root / "nodes.json"
        self.config = self.home / ".config/mini-proxy/config.json"
        self.launcher = self.home / ".local/bin/mini-proxy-select"
        self.plist = self.home / "Library/LaunchAgents/com.mini.proxy.plist"
        self.service = f"gui/{os.getuid()}/{LABEL}"


def reject_gui_path(path):
    if any("v2ray" in part.lower() for part in Path(path).resolve().parts):
        raise Failure("Use an independent mini-proxy directory, never GUI proxy files")


@contextmanager
def operation_lock(paths):
    reject_gui_path(paths.root)
    paths.root.mkdir(parents=True, mode=0o700, exist_ok=True)
    with (paths.root / ".operation.lock").open("a") as stream:
        os.fchmod(stream.fileno(), 0o600)
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Failure("Another mini-proxy operation is active") from None
        yield


def atomic_write(path, data, mode=0o600):
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".mini-proxy-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()


def load_nodes(path):
    reject_gui_path(path)
    nodes = json.loads(path.read_text())
    if not isinstance(nodes, dict) or not nodes:
        raise Failure("Node file must be a nonempty object")
    fields = {
        "address",
        "port",
        "password",
        "network",
        "security",
        "sni",
        "fingerprint",
        "publicKey",
        "shortId",
        "spiderX",
        "flow",
    }
    for name, node in nodes.items():
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,31}", name) or not isinstance(node, dict):
            raise Failure("Invalid node name or profile")
        if set(node) - fields or fields - {"flow"} - set(node):
            raise Failure("Invalid profile fields for " + name)
        if type(node["port"]) is not int or not 1 <= node["port"] <= 65535:
            raise Failure("Invalid port for " + name)
        for key in fields - {"port", "flow"}:
            value = node[key]
            if not isinstance(value, str) or len(value) > 512 or any(ord(c) < 32 for c in value):
                raise Failure("Invalid profile value for " + name)
        if (
            not node["address"]
            or not node["sni"]
            or node["security"] != "reality"
            or node["network"] not in {"raw", "tcp"}
        ):
            raise Failure("Only VLESS RAW/TCP Reality profiles are supported: " + name)
        try:
            uuid.UUID(node["password"])
        except ValueError:
            raise Failure("Invalid user ID for " + name) from None
        if (
            not re.fullmatch(r"[A-Za-z0-9_-]{43}", node["publicKey"])
            or len(base64.urlsafe_b64decode(node["publicKey"] + "=")) != 32
        ):
            raise Failure("Invalid Reality key for " + name)
        if (
            not re.fullmatch(r"(?:[0-9a-fA-F]{2}){0,8}", node["shortId"])
            or not isinstance(node.get("flow", ""), str)
            or node.get("flow", "xtls-rprx-vision") not in {"", "xtls-rprx-vision"}
        ):
            raise Failure("Invalid Reality options for " + name)
    return nodes


def configure(nodes, name, previous=None):
    if name not in nodes:
        raise Failure("Unknown node")
    node = nodes[name]
    outbound = {
        "tag": "proxy",
        "protocol": "vless",
        "settings": {
            "vnext": [
                {
                    "address": node["address"],
                    "port": node["port"],
                    "users": [
                        {
                            "id": node["password"],
                            "email": name,
                            "encryption": "none",
                            "flow": node.get("flow", "xtls-rprx-vision"),
                        }
                    ],
                }
            ]
        },
        "streamSettings": {
            "network": node["network"],
            "security": "reality",
            "realitySettings": {
                "serverName": node["sni"],
                "fingerprint": node["fingerprint"],
                "publicKey": node["publicKey"],
                "shortId": node["shortId"],
                "spiderX": node["spiderX"],
            },
        },
    }
    if previous is not None:
        if (
            not isinstance(previous, dict)
            or not isinstance(previous.get("outbounds"), list)
            or any(not isinstance(o, dict) for o in previous["outbounds"])
        ):
            raise Failure("Invalid existing outbound configuration")
        result = copy.deepcopy(previous)
        positions = [
            i for i, item in enumerate(result.get("outbounds", [])) if item.get("tag") == "proxy"
        ]
        if len(positions) != 1:
            raise Failure("Expected exactly one proxy outbound")
        result["outbounds"][positions[0]] = outbound
        return result
    return {
        "log": {"loglevel": "warning"},
        "inbounds": [inbound(10808)],
        "outbounds": [outbound, {"tag": "direct", "protocol": "freedom"}],
        "routing": {
            "domainStrategy": "IPIfNonMatch",
            "rules": [
                {"type": "field", "ip": ["geoip:private"], "outboundTag": "direct"},
                {"type": "field", "domain": ["geosite:google"], "outboundTag": "proxy"},
                {"type": "field", "domain": ["geosite:cn"], "outboundTag": "direct"},
                {"type": "field", "ip": ["geoip:cn"], "outboundTag": "direct"},
            ],
        },
    }


def inbound(port):
    return {
        "tag": "local",
        "listen": "127.0.0.1",
        "port": port,
        "protocol": "mixed",
        "settings": {"auth": "noauth", "udp": True},
    }


def ensure_idle():
    result = subprocess.run(
        ["/bin/ps", "-axo", "comm="], capture_output=True, text=True, check=True, timeout=5
    )
    if any(line.strip().endswith("/Runner.Worker") for line in result.stdout.splitlines()):
        raise Failure("CI runner is busy; wait before changing the proxy")


def verify_owner(paths):
    for path in [paths.xray, paths.config, paths.nodes, paths.launcher, paths.plist]:
        reject_gui_path(path)
    if not paths.plist.exists():
        raise Failure("mini-proxy service is not installed")
    data = plistlib.loads(paths.plist.read_bytes())
    if data.get("Label") != LABEL or data.get("ProgramArguments") != [
        str(paths.xray),
        "run",
        "-c",
        str(paths.config),
    ]:
        raise Failure("Existing service is not owned by standalone mini-proxy")


def service_info(paths):
    result = subprocess.run(
        ["/bin/launchctl", "print", paths.service], capture_output=True, text=True, timeout=5
    )
    if result.returncode:
        return None
    lines = [line.strip() for line in result.stdout.splitlines()]
    if "program = " + str(paths.xray) not in lines:
        raise Failure("Loaded service is not the standalone mini-proxy")
    return next((int(line.split(" = ")[1]) for line in lines if line.startswith("pid = ")), 0)


def owns_listener(pid, port):
    return (
        bool(pid)
        and subprocess.run(
            ["/usr/sbin/lsof", "-nP", "-a", "-p", str(pid), f"-iTCP:{port}", "-sTCP:LISTEN"],
            capture_output=True,
            timeout=5,
        ).returncode
        == 0
    )


def validate_config(paths, config):
    reject_gui_path(paths.xray)
    with tempfile.TemporaryDirectory(prefix="mini-proxy-validate-") as directory:
        path = Path(directory) / "config.json"
        atomic_write(path, json_bytes(config))
        result = subprocess.run(
            [str(paths.xray), "run", "-test", "-c", str(path)],
            env={**os.environ, "XRAY_LOCATION_ASSET": str(paths.assets)},
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10,
        )
        if result.returncode:
            raise Failure("Xray rejected the configuration")


def network_latency(port, connection_factory=http.client.HTTPSConnection):
    connection = connection_factory(
        "127.0.0.1", port, timeout=5, context=ssl.create_default_context()
    )
    connection.set_tunnel("www.google.com", 443)
    samples = []
    try:
        for attempt in range(2):
            if attempt:
                time.sleep(0.1)
            started = time.perf_counter()
            connection.request(
                "GET",
                "/generate_204",
                headers={"Host": "www.google.com", "Connection": "keep-alive"},
            )
            response = connection.getresponse()
            if response.status != 204 or response.will_close:
                return None
            response.read()
            samples.append(max(0, round((time.perf_counter() - started) * 1000)))
        return min(samples)
    except (OSError, http.client.HTTPException):
        return None
    finally:
        connection.close()


def check_candidate(paths, candidate):
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    candidate = copy.deepcopy(candidate)
    candidate["inbounds"] = [inbound(port)]
    candidate["routing"] = {
        "rules": [{"type": "field", "inboundTag": ["local"], "outboundTag": "proxy"}]
    }
    validate_config(paths, candidate)
    with tempfile.TemporaryDirectory(prefix="mini-proxy-check-") as directory:
        path = Path(directory) / "config.json"
        atomic_write(path, json_bytes(candidate))
        process = subprocess.Popen(
            [str(paths.xray), "run", "-c", str(path)],
            env={**os.environ, "XRAY_LOCATION_ASSET": str(paths.assets)},
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            for _ in range(30):
                if process.poll() is not None:
                    raise Failure("Candidate proxy could not start")
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                        break
                except OSError:
                    time.sleep(0.1)
            else:
                raise Failure("Candidate proxy did not listen")
            latency = network_latency(port)
            if (
                latency is None
                or process.poll() is not None
                or not owns_listener(process.pid, port)
            ):
                raise Failure("Candidate did not complete two HTTP 204 responses")
            return latency
        finally:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


def restart_and_check(paths):
    if service_info(paths) is None:
        raise Failure("mini-proxy service is not loaded")
    subprocess.run(
        ["/bin/launchctl", "kickstart", "-k", paths.service],
        check=True,
        capture_output=True,
        timeout=15,
    )
    for _ in range(30):
        if owns_listener(service_info(paths), 10808):
            return network_latency(10808) is not None
        time.sleep(0.1)
    return False


def select(paths, name, check_only=False):
    with operation_lock(paths):
        for path in [paths.xray, paths.assets, paths.config, paths.nodes]:
            reject_gui_path(path)
        nodes = load_nodes(paths.nodes)
        previous = paths.config.read_bytes()
        candidate = configure(nodes, name, json.loads(previous))
        if not check_only:
            verify_owner(paths)
            ensure_idle()
        latency = check_candidate(paths, candidate)
        if check_only:
            return latency
        ensure_idle()  # A CI job may have started during the candidate probe.
        validate_config(paths, candidate)
        atomic_write(paths.config.with_suffix(".json.previous"), previous)
        try:
            atomic_write(paths.config, json_bytes(candidate))
            if not restart_and_check(paths):
                raise Failure("New proxy did not pass its health check")
        except BaseException as error:
            atomic_write(paths.config, previous)
            try:
                recovered = restart_and_check(paths)
            except Exception:
                recovered = False
            raise Failure(
                "Switch failed; previous configuration restored; "
                + ("service verified" if recovered else "service needs attention")
            ) from error
        return latency


def interrupted(*_):
    raise KeyboardInterrupt()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Probe a private candidate without switching the service",
    )
    parser.add_argument("node")
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, interrupted)
    try:
        latency = select(Paths(Path.home()), args.node, args.check)
    except Failure as error:
        parser.exit(1, str(error) + "\n")
    except (OSError, ValueError, subprocess.SubprocessError, KeyboardInterrupt):
        # Config parse failures and subprocess details can include credentials.
        parser.exit(
            1,
            "mini-proxy operation failed; check installation, profile, "
            "CI/operation locks and network\n",
        )
    print(f"latency_ms {latency}\nmini-proxy: {args.node}" + (" (checked)" if args.check else ""))


if __name__ == "__main__":
    main()
