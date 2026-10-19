#!/usr/bin/python3
"""User-owned host operations; no application deployment or guest credentials."""

import ipaddress
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

H = Path.home()
TART = str(H / ".local/bin/tart")
CONFIG = H / ".config/mini-archipel/host.json"
STOP = False


def stop(*_):
    global STOP
    STOP = True


def output(args):
    return subprocess.check_output(args, text=True, timeout=10).strip()


def missing_vms(config, actual):
    states = {v["Name"]: v["State"] for v in actual if v.get("Source") == "local"}
    # Missing and suspended VMs require an operator; never clone or reset them.
    return [v for v in config["vms"] if states.get(v) == "stopped"]


def addresses(config, vm):
    lan = ipaddress.IPv4Address(
        output(["/usr/sbin/ipconfig", "getifaddr", config["interface"]])
    )
    if lan not in ipaddress.IPv4Network(config["management_subnet"]):
        raise ValueError("host is outside the configured management subnet")
    guest = ipaddress.IPv4Address(output([TART, "ip", vm]))
    if guest not in ipaddress.IPv4Network("192.168.64.0/24"):
        raise ValueError("guest is outside the VM subnet")
    return str(lan), str(guest)


def ssh_args(config, vm, pair):
    lan, guest = pair
    return [
        "/usr/bin/ssh",
        "-N",
        "-L",
        f"{lan}:{config['ports'][vm]}:127.0.0.1:9101",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "UserKnownHostsFile=" + str(H / ".config/mini-archipel/vm-known-hosts"),
        "-o",
        "GlobalKnownHostsFile=/dev/null",
        "-o",
        "HostKeyAlias=" + vm,
        "-o",
        "HostName=" + guest,
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "ExitOnForwardFailure=yes",
        vm,
    ]


def terminate(child):
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()


def supervise(config):
    # A dedicated assertion protects idle VM availability without changing host pmset.
    awake = subprocess.Popen(["/usr/bin/caffeinate", "-i", "-w", str(os.getpid())])
    children = []
    try:
        while not STOP:
            try:
                actual = json.loads(output([TART, "list", "--format", "json"]))
                for vm in missing_vms(config, actual):
                    children = [p for p in children if p.poll() is None]
                    if not any(getattr(p, "vm", None) == vm for p in children):
                        print("Starting stopped VM:", vm, flush=True)
                        p = subprocess.Popen(
                            [TART, "run", "--no-graphics", vm], start_new_session=True
                        )
                        p.vm = vm
                        children.append(p)
            except Exception as e:
                print("VM check deferred:", type(e).__name__, flush=True)
            for _ in range(10):
                if STOP:
                    break
                time.sleep(1)
    finally:
        terminate(awake)
        # Existing and newly started guests survive a supervisor restart.


def relay(config, vm):
    pair = addresses(config, vm)
    child = subprocess.Popen(ssh_args(config, vm, pair))
    try:
        while not STOP and child.poll() is None:
            time.sleep(2)
            if addresses(config, vm) != pair:
                print("Relay address changed; reconnecting", flush=True)
                break
    finally:
        terminate(child)
    if not STOP:
        raise SystemExit(1)


if __name__ == "__main__":
    os.umask(0o077)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    config = json.loads(CONFIG.read_text())
    if sys.argv[1:] == ["vms"]:
        supervise(config)
    elif len(sys.argv) == 3 and sys.argv[1] == "relay" and sys.argv[2] in config["vms"]:
        relay(config, sys.argv[2])
    else:
        raise SystemExit("usage: host-services.py vms | relay VM")
