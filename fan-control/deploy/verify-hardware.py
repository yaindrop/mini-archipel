#!/usr/bin/env python3
"""Bounded fan write/readback check. Always restore Apple auto on exit.

Stops the daemon first so its per-second auto handback cannot override the
test writes, and restarts it afterwards if it was running.
"""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

base = Path(__file__).resolve().parent
binary = base / 'fanctl'
config = base / 'fanctl.conf'
LABEL = 'com.macmini.fan-control'
PLIST = f'/Library/LaunchDaemons/{LABEL}.plist'
assert os.geteuid() == 0, 'Run with sudo'

def run(*args):
    return subprocess.run([str(binary), '-c', str(config), *args],
                          check=True, capture_output=True, text=True, timeout=8).stdout

def daemon_running():
    return subprocess.run(['launchctl', 'print', f'system/{LABEL}'],
                          capture_output=True).returncode == 0

def interrupted(signum, frame):
    raise KeyboardInterrupt()

signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
was_running = daemon_running()
if was_running:
    subprocess.run(['launchctl', 'bootout', f'system/{LABEL}'], check=True)
    time.sleep(1)
try:
    run('auto')
    before = json.loads(run('-j', 'status'))
    assert before['ok'] and before['have_temp'] and before['nsensors'] == 48
    assert not before['forced'] and before['max_rpm'] == 4900
    for rpm in (2170, 2950, 3730, 4900):
        run('force', str(rpm))
        deadline = time.monotonic() + 12
        stable = 0
        while time.monotonic() < deadline:
            state = json.loads(run('-j', 'status'))
            if state['forced'] and abs(state['target'] - rpm) < 2 and abs(state['rpm'] - rpm) < 150:
                stable += 1
            else:
                stable = 0
            if stable >= 2:
                print(f"PASS target={rpm} actual={state['rpm']} RPM", flush=True)
                break
            time.sleep(1)
        else:
            raise RuntimeError(f'Fan did not reach {rpm} RPM: {state}')
finally:
    run('auto')
    state = json.loads(run('-j', 'status'))
    assert not state['forced'], 'FAILED TO RESTORE APPLE AUTOMATIC CONTROL'
    print('RESTORED Apple automatic control', flush=True)
    if was_running or '--restart' in sys.argv:
        subprocess.run(['launchctl', 'bootstrap', 'system', PLIST], check=True)
        time.sleep(2)
        print('daemon restarted:', subprocess.run(
            ['launchctl', 'print', f'system/{LABEL}'],
            capture_output=True, text=True).stdout.split('pid = ')[1].splitlines()[0].strip())
