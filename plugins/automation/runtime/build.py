#!/usr/bin/env python3
"""Build the localized Automation companion without launching it or requesting access."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile

APP_FILE = "Mini Archipel Plugin - Automation.app"
BUNDLE_ID = "local.yaindrop.agent-script-runner"
NAMES = {"en": "Mini Archipel Plugin: Automation", "zh-Hans": "群岛插件：自动化"}


def build_app(app):
    app = Path(app)
    if app.name != APP_FILE or app.exists():
        raise SystemExit("Select a new destination ending in " + APP_FILE)
    app.parent.mkdir(parents=True, exist_ok=True)
    source = Path(__file__).resolve().parent
    with tempfile.TemporaryDirectory(prefix="automation-build-", dir=app.parent) as temporary:
        staged = Path(temporary) / APP_FILE
        executable = staged / "Contents/MacOS/AgentScriptRunner"
        executable.parent.mkdir(parents=True)
        architectures = []
        for arch in ["arm64", "x86_64"]:
            binary = Path(temporary) / ("runner-" + arch)
            subprocess.run(["/usr/bin/xcrun", "swiftc", "-swift-version", "5", "-parse-as-library", "-O", "-target", arch + "-apple-macos15.0",
                "-framework", "AppKit", "-framework", "ApplicationServices", "-framework", "Carbon",
                *[str(p) for p in [source / "Runner.swift", *sorted((source / "input").glob("*.swift"))]], "-o", str(binary)], check=True)
            architectures.append(str(binary))
        subprocess.run(["/usr/bin/lipo", "-create", *architectures, "-output", str(executable)], check=True)
        info = {"CFBundleIdentifier": BUNDLE_ID, "CFBundleName": app.stem, "CFBundleDisplayName": app.stem,
            "CFBundleDevelopmentRegion": "en", "CFBundleLocalizations": ["en", "zh-Hans"],
            "CFBundleExecutable": executable.name, "CFBundlePackageType": "APPL", "CFBundleVersion": "3",
            "CFBundleShortVersionString": "1.2.0", "LSMinimumSystemVersion": "15.0", "LSUIElement": True,
            "NSAppleEventsUsageDescription": "Run your requested scripts and check access to the selected applications."}
        (staged / "Contents/Info.plist").write_bytes(plistlib.dumps(info))
        for language, name in NAMES.items():
            folder = staged / ("Contents/Resources/" + language + ".lproj")
            folder.mkdir(parents=True)
            description = "执行您指定的脚本并检查对所选应用的控制权限。" if language == "zh-Hans" else info["NSAppleEventsUsageDescription"]
            strings = {"CFBundleName": name, "CFBundleDisplayName": name, "NSAppleEventsUsageDescription": description}
            (folder / "InfoPlist.strings").write_text("\n".join(json.dumps(k) + " = " + json.dumps(v, ensure_ascii=False) + ";" for k, v in strings.items()) + "\n")
        (staged / "Contents/Resources/input-protocol.json").write_bytes((source / "input-protocol.json").read_bytes())
        command = ["/usr/bin/codesign", "--force", "--sign", os.environ.get("SIGN_IDENTITY", "-"), "--identifier", BUNDLE_ID, "--timestamp=none"]
        if os.environ.get("SIGN_KEYCHAIN"):
            command += ["--keychain", os.environ["SIGN_KEYCHAIN"]]
        subprocess.run([*command, str(staged)], check=True)
        subprocess.run(["/usr/bin/codesign", "--verify", "--strict", str(staged)], check=True)
        staged.rename(app)
    return app


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path.home() / "Applications" / APP_FILE)
    args = parser.parse_args()
    print(json.dumps({"ok": True, "app": str(build_app(args.output)), "bundle_id": BUNDLE_ID}, ensure_ascii=False))
