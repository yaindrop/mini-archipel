import AppKit
import ApplicationServices

struct Request: Decodable {
    let request_id: String?
    let message: String
    let session_id: String?
    let title: String?
    let probe: Bool?
    let new_chat: Bool
}
struct Failure: Error { let message: String }
func fail(_ message: String) throws -> Never { throw Failure(message: message) }
func attr(_ e: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(e, name as CFString, &value) == .success ? value : nil
}
func text(_ e: AXUIElement, _ name: String) -> String { attr(e, name) as? String ?? "" }
func clean(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }
func elements(_ root: AXUIElement) -> [AXUIElement] {
    var pending = [root], result = [AXUIElement]()
    while let e = pending.popLast(), result.count < 4000 {
        result.append(e)
        pending.append(contentsOf: attr(e, "AXChildren") as? [AXUIElement] ?? [])
    }
    return result
}
func waitUntil(_ seconds: Double, _ condition: () -> Bool) -> Bool {
    let end = ProcessInfo.processInfo.systemUptime + seconds
    repeat {
        if condition() { return true }
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    } while ProcessInfo.processInfo.systemUptime < end
    return false
}
let chatKeyboard = ChatKeyboard()
func key(_ code: CGKeyCode, command: Bool = false) throws { try chatKeyboard.key(code,command:command) }

func axFrameOf(_ e: AXUIElement) -> CGRect? {
    guard let p = attr(e, "AXPosition"), let s = attr(e, "AXSize"),
          CFGetTypeID(p as AnyObject) == AXValueGetTypeID(), CFGetTypeID(s as AnyObject) == AXValueGetTypeID() else { return nil }
    var pt = CGPoint.zero, sz = CGSize.zero
    AXValueGetValue(p as! AXValue, .cgPoint, &pt); AXValueGetValue(s as! AXValue, .cgSize, &sz)
    return CGRect(origin: pt, size: sz)
}
func cgClickPoint(_ p: CGPoint) {
    let src = CGEventSource(stateID: .hidSystemState)
    CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
    usleep(60_000)
    CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
    usleep(60_000)
    CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
}
func composerOrNil(_ window: AXUIElement) -> AXUIElement? {
    let fields = elements(window).filter { text($0, "AXRole") == "AXTextArea" }
    return fields.count == 1 ? fields[0] : nil
}
func sendButton(_ window: AXUIElement) -> AXUIElement? {
    elements(window).first { text($0, "AXRole") == "AXButton" && text($0, "AXDescription") == "发送" && (attr($0, "AXEnabled") as? Bool ?? false) }
}
func inputReady(_ window: AXUIElement) -> Bool {
    if composerOrNil(window) != nil { return true }
    if sendButton(window) != nil { return true }
    return elements(window).contains { text($0, "AXRole") == "AXWebArea" }
}
func composer(_ window: AXUIElement) throws -> AXUIElement {
    let fields = elements(window).filter { text($0, "AXRole") == "AXTextArea" }
    guard fields.count == 1 else { try fail("Expected exactly one ZCode composer") }
    return fields[0]
}
func copySessionID(_ node: AXUIElement, _ window: AXUIElement, _ version: inout Int) throws -> String {
    let menuError = AXUIElementPerformAction(node, kAXShowMenuAction as CFString)
    guard menuError == .success else { try fail("Cannot open task menu (AX error \(menuError.rawValue))") }
    var item: AXUIElement?
    guard waitUntil(2, {
        item = elements(window).first { text($0, "AXRole") == "AXMenuItem" && text($0, "AXTitle") == "复制会话 ID" }
        return item != nil
    }), let item else { try? key(53); try fail("Session ID menu item unavailable") }
    let board = NSPasteboard.general
    let before = board.changeCount
    guard AXUIElementPerformAction(item, kAXPressAction as CFString) == .success,
          waitUntil(2, { board.changeCount != before }) else { try? key(53); try fail("Could not copy session ID") }
    version = board.changeCount
    let copied = clean(board.string(forType: .string) ?? "")
    guard waitUntil(2, { !elements(window).contains { text($0, "AXRole") == "AXMenuItem" } }) else { try? key(53); try fail("Task menu did not close") }
    return copied
}

@main enum ZCodeUIMain {
static func main() throws {
chatKeyboard.installSignals()
let start = ProcessInfo.processInfo.systemUptime
var sent = false
var sendAttempted = false
var output: [String: Any]
do {
    guard CommandLine.arguments.count == 2 else { try fail("Expected request JSON path") }
    let request = try JSONDecoder().decode(Request.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
    chatKeyboard.configure(request.request_id)
    try chatKeyboard.checkIdle()
    guard (request.probe == true || !clean(request.message).isEmpty), AXIsProcessTrusted() else { try fail("Empty message or missing inherited Accessibility permission") }
    let nativeLock = Darwin.open(NSHomeDirectory() + "/.agent-chat-native.lock", O_CREAT | O_RDWR, 0o600)
    guard nativeLock >= 0 else { try fail("Cannot open native UI lock") }
    defer { Darwin.close(nativeLock) }
    guard flock(nativeLock, LOCK_EX | LOCK_NB) == 0 else { try fail("Another native UI action is still running") }
    var readyApp: NSRunningApplication?
    guard waitUntil(8, { readyApp = NSRunningApplication.runningApplications(withBundleIdentifier: "dev.zcode.app").first; return readyApp != nil }), let running = readyApp else { try fail("ZCode is not running") }
    let app = AXUIElementCreateApplication(running.processIdentifier)
    AXUIElementSetMessagingTimeout(app, 2)
    AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    running.activate()
    var readyWindow: AXUIElement?
    guard waitUntil(8, {
        let ws = (attr(app, "AXWindows") as? [AXUIElement]) ?? []
        readyWindow = ws.first { text($0, "AXTitle") == "ZCode" } ?? ws.first
        return running.isActive && readyWindow.map { inputReady($0) } == true
    }), let window = readyWindow else { try fail("ZCode window is not ready") }
    if let f0 = composerOrNil(window), !clean(text(f0, "AXValue")).isEmpty { try fail("Existing ZCode draft; nothing overwritten") }
    let board = NSPasteboard.general
    let saved = (board.pasteboardItems ?? []).map { item -> NSPasteboardItem in
        let copy = NSPasteboardItem()
        for type in item.types { if let data = item.data(forType: type) { copy.setData(data, forType: type) } }
        return copy
    }
    var version = board.changeCount
    defer { if board.changeCount == version { board.clearContents(); if !saved.isEmpty { board.writeObjects(saved) } } }
    if request.new_chat {
        try key(45, command: true)
        guard waitUntil(4, { inputReady(window) }) else {
            try fail("New ZCode chat is not ready")
        }
    } else {
        guard let target = request.session_id, let title = request.title else { try fail("Missing target session") }
        var verified = false
        if !verified {
            func candidates() -> [AXUIElement] {
                let rows = elements(window).filter {
                let classes = attr($0, "AXDOMClassList") as? [String] ?? []
                return (classes.contains("group/task-item") || classes.contains("group/task-row")) && elements($0).contains { text($0, "AXValue") == title }
                }
                return rows.filter { (attr($0, "AXDOMClassList") as? [String] ?? []).contains("bg-selected") }
                    + rows.filter { !(attr($0, "AXDOMClassList") as? [String] ?? []).contains("bg-selected") }
            }
            for index in 0..<candidates().count {
                let currentRows = candidates()
                guard index < currentRows.count else { try fail("Task list changed during selection") }
                let row = currentRows[index]
                let alreadySelected = (attr(row, "AXDOMClassList") as? [String] ?? []).contains("bg-selected")
                guard try copySessionID(row, window, &version) == target else { continue }
                if alreadySelected { verified = true; break }
                // Opening/closing the React menu replaces AX row objects.
                let refreshedRows = candidates()
                guard index < refreshedRows.count, AXUIElementPerformAction(refreshedRows[index], kAXPressAction as CFString) == .success else { try fail("Could not select target task") }
                var selected: AXUIElement?
                guard waitUntil(8, {
                    selected = elements(window).first {
                        let classes = attr($0, "AXDOMClassList") as? [String] ?? []
                        return (classes.contains("group/task-item") || classes.contains("group/task-row")) && classes.contains("bg-selected") && elements($0).contains { text($0, "AXValue") == title }
                    }
                    return selected != nil && (try? composer(window)) != nil
                }), let selected else { try fail("Target chat is not ready") }
                verified = try copySessionID(selected, window, &version) == target
                break
            }
        }
        guard verified else { try fail("Target session ID could not be verified; not sent") }
    }
    let field = composerOrNil(window)
    if field == nil && request.probe != true { try fail("Cannot verify an empty writable ZCode composer; nothing pasted or sent") }
    if let f = field, !clean(text(f, "AXValue")).isEmpty { try fail("Existing draft") }
    if let f = field {
        // Force real window focus: CG click composer center, then AX focus with retries.
        if let ff = axFrameOf(f) { cgClickPoint(CGPoint(x: ff.midX, y: ff.midY)); usleep(160_000) }
        var focused = false
        for _ in 0..<3 {
            if AXUIElementSetAttributeValue(f, "AXFocused" as CFString, kCFBooleanTrue) == .success,
               waitUntil(1, { attr(f, "AXFocused") as? Bool == true }) { focused = true; break }
            usleep(150_000)
        }
        guard focused else { try fail("Cannot focus ZCode composer") }
    } else {
        // Web composer fallback: activate app and click bottom input area to establish focus.
        running.activate(options: [.activateIgnoringOtherApps])
        usleep(150_000)
        if let wf = axFrameOf(window) { cgClickPoint(CGPoint(x: wf.midX, y: wf.maxY - 140)); usleep(180_000) }
    }
    if request.probe == true {
        output = ["ok": true, "sent": false, "target_verified": true]
    } else {
    board.clearContents(); board.setString(request.message, forType: .string)
    version = board.changeCount
    guard running.isActive else { try fail("ZCode lost focus") }
    try key(9, command: true)
    if let f = field {
        guard waitUntil(3, { clean(text(f, "AXValue")) == clean(request.message) }) else { try fail("Paste not verified; inspect draft before retry") }
    } else { try fail("Writable composer unavailable; nothing sent") }
    guard running.isActive else { try fail("ZCode lost focus") }
    sendAttempted = true
    if let btn = sendButton(window) {
        guard AXUIElementPerformAction(btn, kAXPressAction as CFString) == .success else { try fail("Send click acknowledgement failed; reconcile history") }
    } else { try fail("Send button not ready; inspect draft before retry") }
    sent = true
    output = ["ok": true, "sent": sent, "target_verified": true]
    }
} catch {
    output = ["ok": false, "sent": sent, "error": (error as? Failure)?.message ?? String(describing: error)]
    // AX can time out after delivering the action. Only history can settle it.
    if sendAttempted && !sent { output["sent"] = NSNull() }
}
output["ui_ms"] = Int((ProcessInfo.processInfo.systemUptime - start) * 1000)
output["input_cleanup"] = chatKeyboard.summary()
output["input_state"] = inputStateSnapshot()
output["related_request_id"] = chatKeyboard.requestID
print(String(data: try JSONSerialization.data(withJSONObject: output, options: .sortedKeys), encoding: .utf8)!)
exit(output["ok"] as? Bool == true ? 0 : 1)

}
}
