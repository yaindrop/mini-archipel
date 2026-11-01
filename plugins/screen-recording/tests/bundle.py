"""Check actual main-bundle localization without launching the GUI helper."""
import json
from pathlib import Path
import plistlib
import subprocess
import sys

app = Path(sys.argv[1])
info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
assert info['CFBundleIdentifier'] == 'org.agent-screen-recorder.app'
assert info['CFBundleName'] == info['CFBundleDisplayName'] == app.stem
assert ':' not in app.name
binary = app / 'Contents/MacOS/AgentScreenRecorder'
for language, name in [('en', 'Mini Archipel Plugin: Screen Recorder'), ('zh-Hans', '群岛插件：屏幕录制')]:
    strings = json.loads(subprocess.check_output(['plutil', '-convert', 'json', '-o', '-', str(app / f'Contents/Resources/{language}.lproj/InfoPlist.strings')]))
    assert strings['CFBundleDisplayName'] == strings['CFBundleName'] == name
    # Foundation consumes the system language flag; the strict CLI then rejects
    # it before any helper launch, returning identity from its real main bundle.
    result = subprocess.run([binary, '--cli', 'identity', '-AppleLanguages', f'({language})'], capture_output=True, text=True, check=False)
    value = json.loads(result.stdout)
    assert result.returncode == 1 and value['code'] == 'invalid_argument'
    assert value['appName'] == name and value['bundleID'] == info['CFBundleIdentifier']
    print('PASS: actual main bundle localized display name:', name)
