#!/usr/bin/env python3
"""Build once; changing an external script does not require rebuilding the app."""
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile

source = Path(__file__).resolve().parent
home = Path.home()
app = home / "Agent Script Runner.app"
helper = home / "agent-script-runner"
if app.exists() or helper.exists():
    sys.exit("Destination exists; refusing to replace the app or its permission identity.")
with tempfile.TemporaryDirectory(prefix="agent-script-runner-build-", dir=home) as temporary:
    staged = Path(temporary) / app.name
    executable = staged / "Contents/MacOS/AgentScriptRunner"
    executable.parent.mkdir(parents=True)
    subprocess.run([
        "/usr/bin/xcrun", "swiftc", "-swift-version", "5", "-O",
        "-framework", "AppKit", "-framework", "ApplicationServices", "-framework", "Carbon",
        str(source / "Runner.swift"), "-o", str(executable),
    ], check=True)
    info = {
        "CFBundleIdentifier": "local.yaindrop.agent-script-runner",
        "CFBundleName": "Agent Script Runner",
        "CFBundleDisplayName": "Agent Script Runner",
        "CFBundleExecutable": executable.name,
        "CFBundlePackageType": "APPL",
        "CFBundleVersion": "1",
        "CFBundleShortVersionString": "1.0",
        "LSUIElement": True,
        "NSAppleEventsUsageDescription": "执行你指定的脚本，通过 Apple Events 控制所选应用。",
    }
    with (staged / "Contents/Info.plist").open("wb") as file:
        plistlib.dump(info, file)
    subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", str(staged)], check=True)
    subprocess.run(["/usr/bin/codesign", "--verify", "--strict", str(staged)], check=True)
    staged.rename(app)
shutil.copy2(source / "agent-script-runner", helper)
helper.chmod(0o700)
print(app)
print(helper)
