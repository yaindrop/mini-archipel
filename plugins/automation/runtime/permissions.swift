import AppKit
import ApplicationServices
import Carbon
import SystemConfiguration
import IOKit

// Launched by the fixed Runner so the check uses the same TCC responsibility.
var systemEvents = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.systemevents").first
if systemEvents == nil {
    let config = NSWorkspace.OpenConfiguration()
    config.activates = false
    NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: "/System/Library/CoreServices/System Events.app"), configuration: config) { app, _ in
        systemEvents = app
    }
    let deadline = Date().addingTimeInterval(5)
    while systemEvents == nil && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
}
let target = systemEvents.map { NSAppleEventDescriptor(processIdentifier: $0.processIdentifier) }
    ?? NSAppleEventDescriptor(bundleIdentifier: "com.apple.systemevents")
let permission = AEDeterminePermissionToAutomateTarget(target.aeDesc, AEEventClass(kAECoreSuite), AEEventID(kAECountElements), false)
let session = CGSessionCopyCurrentDictionary() as? [String: Any] ?? [:]
var consoleUID: uid_t = 0
var consoleGID: gid_t = 0
let consoleUser = SCDynamicStoreCopyConsoleUser(nil, &consoleUID, &consoleGID)
let root = IORegistryGetRootEntry(kIOMainPortDefault)
let screenLocked = IORegistryEntryCreateCFProperty(root, "IOConsoleLocked" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue()
IOObjectRelease(root)
var automation: Any = NSNull()
if permission == noErr { automation = true }
else if permission == -1743 || permission == -1744 { automation = false }
let accessibility = AXIsProcessTrusted()
var focused: CFTypeRef?
let accessibilityCode = accessibility ? AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute as CFString, &focused) : .apiDisabled
var automationVerified = false
if permission == noErr {
    var error: NSDictionary?
    let script = NSAppleScript(source: "tell application \"System Events\" to count application processes")!
    _ = script.executeAndReturnError(&error)
    automationVerified = error == nil
}
let result: [String: Any] = [
    "ok": true,
    "accessibility": accessibility,
    "accessibility_verified": accessibility && accessibilityCode == .success,
    "accessibility_code": accessibilityCode.rawValue,
    "automation_verified": automationVerified,
    "automation": automation,
    "automation_code": permission,
    "screen_locked": screenLocked ?? session["CGSSessionScreenIsLocked"] ?? NSNull(),
    "console_session": consoleUser != nil && consoleUID == getuid(),
    "apps": ["codex": NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.openai.codex") != nil,
             "zcode": NSWorkspace.shared.urlForApplication(withBundleIdentifier: "dev.zcode.app") != nil],
]
print(String(data: try JSONSerialization.data(withJSONObject: result, options: .sortedKeys), encoding: .utf8)!)
