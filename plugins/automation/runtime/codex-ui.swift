import AppKit
import ApplicationServices

// Run as a child of the already-authorized Agent Script Runner.app.
struct Request: Decodable {
    let mode: String
    let thread_id: String
    let title: String
    let message: String?
}
struct Failure: Error { let message: String }
func fail(_ message: String) throws -> Never { throw Failure(message: message) }
func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func text(_ element: AXUIElement, _ name: String) -> String {
    attr(element, name) as? String ?? ""
}
func elements(_ root: AXUIElement) -> [AXUIElement] {
    var pending = [root], result = [AXUIElement]()
    while let element = pending.popLast(), result.count < 3000 {
        result.append(element)
        pending.append(contentsOf: attr(element, "AXChildren") as? [AXUIElement] ?? [])
    }
    return result
}
func clean(_ value: String) -> String { value.trimmingCharacters(in: .whitespacesAndNewlines) }
func composerIsEmpty(_ composer: AXUIElement) -> Bool {
    let value = clean(text(composer, "AXValue"))
    if value.isEmpty { return true }
    // The editor includes its CSS placeholder in AXValue. A real draft with
    // the same text has no placeholder node and must still be preserved.
    return value == text(composer, "AXDescription") && elements(composer).contains {
        (attr($0, "AXDOMClassList") as? [String] ?? []).contains("placeholder")
    }
}
func key(_ code: CGKeyCode, command: Bool = false) throws {
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else {
        try fail("Could not create keyboard event")
    }
    down.flags = command ? .maskCommand : []; up.flags = down.flags
    down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
}
func waitUntil(_ seconds: Double, _ condition: () -> Bool) -> Bool {
    let deadline = ProcessInfo.processInfo.systemUptime + seconds
    repeat {
        if condition() { return true }
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    } while ProcessInfo.processInfo.systemUptime < deadline
    return false
}

let started = ProcessInfo.processInfo.systemUptime
var sent = false
var output: [String: Any]
do {
    guard CommandLine.arguments.count == 2 else { try fail("Expected one request JSON file") }
    let request = try JSONDecoder().decode(Request.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
    guard ["probe", "send"].contains(request.mode), UUID(uuidString: request.thread_id) != nil,
          !request.title.isEmpty else { try fail("Invalid request") }
    guard AXIsProcessTrusted() else { try fail("Run through the authorized Agent Script Runner.app") }
    let nativeLock = Darwin.open(NSHomeDirectory() + "/.agent-chat-native.lock", O_CREAT | O_RDWR, 0o600)
    guard nativeLock >= 0 else { try fail("Cannot open native UI lock") }
    defer { Darwin.close(nativeLock) }
    guard flock(nativeLock, LOCK_EX | LOCK_NB) == 0 else { try fail("Another native UI action is still running") }
    var readyApp: NSRunningApplication?
    guard waitUntil(8, { readyApp = NSRunningApplication.runningApplications(withBundleIdentifier: "com.openai.codex").first; return readyApp != nil }), let running = readyApp else {
        try fail("Codex app is not running")
    }
    let app = AXUIElementCreateApplication(running.processIdentifier)
    AXUIElementSetMessagingTimeout(app, 2)
    AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    guard NSWorkspace.shared.open(URL(string: "codex://threads/\(request.thread_id)")!) else {
        try fail("Could not open chat deep link")
    }
    running.activate()
    var composer: AXUIElement?
    let ready = waitUntil(8) {
        guard running.isActive, let window = attr(app, "AXFocusedWindow"),
              CFGetTypeID(window) == AXUIElementGetTypeID() else { return false }
        let axWindow = unsafeBitCast(window, to: AXUIElement.self)
        guard text(axWindow, "AXTitle") == request.title else { return false }
        let matches = elements(axWindow).filter {
            text($0, "AXRole") == "AXTextArea" && text($0, "AXDescription") == "和 Codex 一起工作"
        }
        guard matches.count == 1 else { return false }
        composer = matches[0]
        return true
    }
    guard ready, let composer else { try fail("Chat title/composer did not become ready; nothing sent") }
    guard AXUIElementSetAttributeValue(composer, "AXFocused" as CFString, kCFBooleanTrue) == .success,
          waitUntil(1, { attr(composer, "AXFocused") as? Bool == true }) else {
        try fail("Could not focus composer")
    }
    output = ["ok": true, "sent": false, "title": request.title,
              "description": text(composer, "AXDescription"),
              "draft_empty": composerIsEmpty(composer)]
    if request.mode == "send" {
        guard let message = request.message, !clean(message).isEmpty else { try fail("Message is empty") }
        guard composerIsEmpty(composer) else { try fail("Existing draft; nothing overwritten") }
        let board = NSPasteboard.general
        let saved = (board.pasteboardItems ?? []).map { item -> NSPasteboardItem in
            let copy = NSPasteboardItem()
            for type in item.types { if let data = item.data(forType: type) { copy.setData(data, forType: type) } }
            return copy
        }
        board.clearContents(); board.setString(message, forType: .string)
        let clipboardVersion = board.changeCount
        defer {
            // Do not overwrite a clipboard change made by the user during paste.
            if board.changeCount == clipboardVersion {
                board.clearContents(); if !saved.isEmpty { board.writeObjects(saved) }
            }
        }
        guard running.isActive else { try fail("App lost focus; nothing sent") }
        try key(9, command: true)
        guard waitUntil(3, { clean(text(composer, "AXValue")) == clean(message) }) else {
            try fail("Paste was not verified; check draft before retrying")
        }
        guard running.isActive, attr(composer, "AXFocused") as? Bool == true,
              let window = attr(app, "AXFocusedWindow"),
              CFGetTypeID(window) == AXUIElementGetTypeID(),
              text(unsafeBitCast(window, to: AXUIElement.self), "AXTitle") == request.title else {
            try fail("Chat changed during paste; not sent")
        }
        try key(36)
        sent = true
        output["sent"] = true
    }
} catch {
    output = ["ok": false, "sent": sent,
              "error": (error as? Failure)?.message ?? error.localizedDescription]
}
output["ui_ms"] = Int((ProcessInfo.processInfo.systemUptime - started) * 1000)
print(String(data: try JSONSerialization.data(withJSONObject: output, options: .sortedKeys), encoding: .utf8)!)
exit(output["ok"] as? Bool == true ? 0 : 1)
