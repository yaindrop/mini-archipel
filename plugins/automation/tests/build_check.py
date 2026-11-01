"""Build and inspect a disposable companion without installing or launching it."""
import json
import importlib.util
from pathlib import Path
import plistlib
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("automation_build", root / "runtime/build.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory(prefix="automation-build-check-") as directory:
    app = module.build_app(Path(directory) / module.APP_FILE)
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    assert info["CFBundleIdentifier"] == module.BUNDLE_ID
    assert info["CFBundleName"] == info["CFBundleDisplayName"] == app.stem
    protocol = app / "Contents/Resources/input-protocol.json"
    assert protocol.read_bytes() == (root / "runtime/input-protocol.json").read_bytes()
    schema = json.loads(protocol.read_bytes())
    assert schema["properties"]["operation"]["const"] == "input"
    for language, expected in module.NAMES.items():
        result = subprocess.check_output(["/usr/bin/plutil", "-convert", "json", "-o", "-", str(app / f"Contents/Resources/{language}.lproj/InfoPlist.strings")])
        strings = json.loads(result)
        assert strings["CFBundleName"] == strings["CFBundleDisplayName"] == expected
        identity = json.loads(subprocess.check_output([str(app / "Contents/MacOS/AgentScriptRunner"), "--identity", "-AppleLanguages", f"({language})"]))
        assert identity["app_name"] == expected
        assert identity["bundle_id"] == module.BUNDLE_ID
        assert identity["file_display_name"] == expected
    subprocess.run(["/usr/bin/codesign", "--verify", "--strict", str(app)], check=True)
    print("PASS: universal companion build, localized metadata and signature; no GUI launch or installation")
