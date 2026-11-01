#!/usr/bin/env python3
"""No GUI helper, TCC request, or screen capture is invoked by these tests."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get('ASR_TEST_BINARY', ROOT / 'build/Mini Archipel Plugin - Screen Recorder.app/Contents/MacOS/AgentScreenRecorder'))

def run(*args):
    return subprocess.run([str(BINARY), '--cli', *args], text=True, capture_output=True, timeout=40)

p = run('--help')
assert p.returncode == 0 and '--window' in p.stdout
for args in [('authorize',), ('pointer-authorize',), ('pointer-event',), ('pointer-import',), ('snapshot',),
             ('start', '--output', 'unused.mp4', '--pointer-source', 'native'), ('start',), ('start', '--output', 'unused.mp4', '--fps', 'nan'),
             ('start', '--output', 'unused.mp4', '--window', '1', '--display', '2')]:
    p = run(*args)
    value = json.loads(p.stdout)
    assert p.returncode == 1 and value['ok'] is False, (args, p.stdout, p.stderr)
p = run('start', '--output', 'unused.mp4', '--pointer-output', 'unused.pointer.json', '--pointer-source', 'external-authorized')
assert p.returncode == 1 and json.loads(p.stdout)['code'] == 'external_pointer_unavailable'
p = run('identity')
value = json.loads(p.stdout)
assert value['bundleID'] == 'org.agent-screen-recorder.app'
assert value['appName'] in ('Mini Archipel Plugin: Screen Recorder', '群岛插件：屏幕录制')
assert value['appPath'].endswith('/Applications/Mini Archipel Plugin - Screen Recorder.app')
with tempfile.TemporaryDirectory(prefix='asr-media-', dir=ROOT / 'test-results') as folder:
    output = Path(folder) / 'synthetic.mp4'
    p = run('self-test-media', '--output', str(output))
    assert p.returncode == 0, (p.stdout, p.stderr)
    info = json.loads(p.stdout)
    assert info['width'] == 320 and info['height'] == 180
    assert 1.49 <= info['durationSeconds'] <= 1.55 and info['bytes'] > 1000
    original = hashlib.sha256(output.read_bytes()).hexdigest()
    collision = run('self-test-media', '--output', str(output))
    assert collision.returncode == 1 and json.loads(collision.stdout)['code'] == 'output_exists'
    assert hashlib.sha256(output.read_bytes()).hexdigest() == original
print('PASS: help, invalid arguments, explicit authorization, identity, synthetic MP4/tail and no-overwrite. No screen capture or permission request.')
