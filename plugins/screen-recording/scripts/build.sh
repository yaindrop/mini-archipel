#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
build_root="${ASR_BUILD_DIR:-build}"
app="$build_root/Mini Archipel Plugin - Screen Recorder.app"
mkdir -p "$app/Contents/MacOS"
for arch in arm64 x86_64; do
  xcrun swiftc -swift-version 5 -O -target "$arch-apple-macos15.0" -parse-as-library Sources/*.swift \
    -framework AppKit -framework ScreenCaptureKit -framework AVFoundation -framework CoreMedia -framework CoreVideo \
    -o "$build_root/recorder-$arch"
done
lipo -create "$build_root/recorder-arm64" "$build_root/recorder-x86_64" -output "$app/Contents/MacOS/AgentScreenRecorder"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>org.agent-screen-recorder.app</string>
<key>CFBundleName</key><string>Mini Archipel Plugin - Screen Recorder</string>
<key>CFBundleDisplayName</key><string>Mini Archipel Plugin - Screen Recorder</string>
<key>CFBundleDevelopmentRegion</key><string>en</string>
<key>CFBundleLocalizations</key><array><string>en</string><string>zh-Hans</string></array>
<key>CFBundleExecutable</key><string>AgentScreenRecorder</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.4.0</string>
<key>CFBundleVersion</key><string>7</string>
<key>LSMinimumSystemVersion</key><string>15.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
PLIST
mkdir -p "$app/Contents/Resources/en.lproj" "$app/Contents/Resources/zh-Hans.lproj"
cat > "$app/Contents/Resources/en.lproj/InfoPlist.strings" <<'EN'
"CFBundleName" = "Mini Archipel Plugin: Screen Recorder";
"CFBundleDisplayName" = "Mini Archipel Plugin: Screen Recorder";
EN
cat > "$app/Contents/Resources/zh-Hans.lproj/InfoPlist.strings" <<'ZH'
"CFBundleName" = "群岛插件：屏幕录制";
"CFBundleDisplayName" = "群岛插件：屏幕录制";
ZH
sign_args=(--force --sign "${SIGN_IDENTITY:--}" --identifier org.agent-screen-recorder.app --timestamp=none)
if [[ -n "${SIGN_KEYCHAIN:-}" ]]; then sign_args+=(--keychain "$SIGN_KEYCHAIN"); fi
codesign "${sign_args[@]}" "$app"
codesign --verify --strict "$app"
cat > "$build_root/agent-screen-recorder" <<'CLI'
#!/bin/bash
set -euo pipefail
exec "$HOME/Applications/Mini Archipel Plugin - Screen Recorder.app/Contents/MacOS/AgentScreenRecorder" --cli "$@"
CLI
chmod +x "$build_root/agent-screen-recorder"
ditto -c -k --keepParent "$app" "$build_root/Agent-Screen-Recorder.zip"
shasum -a 256 "$app/Contents/MacOS/AgentScreenRecorder" "$build_root/Agent-Screen-Recorder.zip" "$build_root/agent-screen-recorder" > "$build_root/SHA256SUMS"
printf '%s\n' 'Built universal macOS 15+ App and CLI. Nothing was installed or launched.'
