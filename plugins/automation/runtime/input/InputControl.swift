import AppKit
import ApplicationServices
import CoreGraphics

func inputMonotonicNS() -> UInt64 { DispatchTime.now().uptimeNanoseconds }
func inputPointer() -> CGPoint { CGEvent(source: nil)?.location ?? CGPoint(x: -99999, y: -99999) }
func inputDistance(_ a: CGPoint, _ b: CGPoint) -> Double { hypot(a.x-b.x, a.y-b.y) }
func inputMakeEvent(_ kind: String,_ point: CGPoint,_ button: CGMouseButton,_ count: Int64,_ code: CGKeyCode,_ flags: CGEventFlags,_ text: String?,_ dx: Int32,_ dy: Int32,_ time: UInt64) throws -> CGEvent {
        let source = CGEventSource(stateID: .combinedSessionState)
        let event: CGEvent?
        if kind == "keyDown" || kind == "keyUp" {
            event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: kind == "keyDown")
            if let text, let event { let units = Array(text.utf16); units.withUnsafeBufferPointer { event.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress!) } }
        } else if kind == "scroll" {
            event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)
        } else {
            let type: CGEventType = kind == "move" ? .mouseMoved : kind == "drag" ? (button == .left ? .leftMouseDragged : button == .right ? .rightMouseDragged : .otherMouseDragged) : kind == "down" ? (button == .left ? .leftMouseDown : button == .right ? .rightMouseDown : .otherMouseDown) : (button == .left ? .leftMouseUp : button == .right ? .rightMouseUp : .otherMouseUp)
            event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button)
            event?.setIntegerValueField(.mouseEventClickState, value: count)
        }
        guard let event else { throw InputFailure("event_construction_failed", "Could not construct native input event") }
        event.flags = flags; event.timestamp = time; return event
}
struct InputIO {
    var now: () -> UInt64 = inputMonotonicNS
    var pointer: () -> CGPoint = inputPointer
    var sleep: (Double) -> Void = Thread.sleep
    var post: (String, CGPoint, CGMouseButton, Int64, CGKeyCode, CGEventFlags, String?, Int32, Int32, UInt64) throws -> Void = { kind, point, button, count, code, flags, text, dx, dy, time in
        #if INPUT_TESTING
        throw InputFailure("test_guard", "OS event dispatch is disabled in test binaries")
        #else
        try inputMakeEvent(kind,point,button,count,code,flags,text,dx,dy,time).post(tap:.cghidEventTap)
        #endif
    }
}
final class NativeInputControl {
    private let lock = NSLock()
    let io: InputIO
    private var closed: String?
    private var lease: UInt64 = 0
    private var down: CGMouseButton?
    private var keys: [CGKeyCode] = []
    private var last = CGPoint.zero
    private var rows: [[String: Any]] = []
    init(io: InputIO = InputIO()) { self.io = io; rows.reserveCapacity(3000) }
    private func append(_ value: [String: Any]) { var row = value; row["monotonic_ns"] = io.now(); rows.append(row) }
    func record(_ value: [String: Any]) { lock.lock(); defer { lock.unlock() }; append(value) }
    func refreshLease(_ checked: UInt64) { lock.lock(); defer { lock.unlock() }; if closed == nil { lease = checked + 180_000_000 } }
    func reason() -> String { lock.lock(); defer { lock.unlock() }; return closed ?? "active" }
    func owned() -> [String: Any] { lock.lock(); defer { lock.unlock() }; return ["buttons": down.map { [$0.rawValue] } ?? [], "keys": keys] }
    private func close(_ why: String) {
        if closed == nil { closed = why }
        if let button = down {
            do { try emit("up", io.pointer(), button, 1, 0, [], nil, 0, 0, ["release_reason": why, "emergency_release": true]); down = nil }
            catch { append(["event": "release_failed", "kind": "mouse", "error": String(describing: error)]) }
        }
        for code in keys.reversed() {
            do { try emit("keyUp", last, .left, 0, code, [], nil, 0, 0, ["release_reason": why, "emergency_release": true]); keys.removeAll { $0 == code } }
            catch { append(["event": "release_failed", "kind": "key", "error": String(describing: error)]) }
        }
        append(["event": "closed", "reason": closed!, "owned_button_count": down == nil ? 0 : 1, "owned_key_count": keys.count])
    }
    func abort(_ why: String) { lock.lock(); defer { lock.unlock() }; close(why) }
    func active() -> Bool { lock.lock(); defer { lock.unlock() }; if closed == nil && io.now() > lease { close("validation_lease_expired") }; return closed == nil }
    private func safe() throws { if closed == nil && io.now() > lease { close("validation_lease_expired") }; try inputRequire(closed == nil, "Input is stopped or its validation lease expired", code: "input_stopped") }
    private func emit(_ kind: String, _ p: CGPoint, _ button: CGMouseButton, _ count: Int64, _ code: CGKeyCode, _ flags: CGEventFlags, _ text: String?, _ dx: Int32, _ dy: Int32, _ extra: [String: Any] = [:]) throws {
        let before = io.pointer(), started = io.now()
        try io.post(kind, p, button, count, code, flags, text, dx, dy, started)
        let actual = io.pointer(); last = p
        var row = extra
        row.merge(["event":kind,"x_screen":p.x,"y_screen":p.y,"actual_pointer_before_x":before.x,"actual_pointer_before_y":before.y,"actual_pointer_after_x":actual.x,"actual_pointer_after_y":actual.y,"mouse_button":button.rawValue,"key_code":code,"flags":flags.rawValue,"unicode_units":text?.utf16.count ?? 0,"scroll_x":dx,"scroll_y":dy,"hostTimeSeconds":Double(started)/1e9,"post_call_ns":started,"post_return_ns":io.now(),"delivery_confirmed_by_log":false]) { _, new in new }
        append(row)
    }
    func move(_ p: CGPoint, drag: Bool = false, flags: CGEventFlags = [], fields: [String: Any] = [:]) throws {
        lock.lock(); defer { lock.unlock() }; try safe()
        try inputRequire(drag ? down != nil : down == nil && keys.isEmpty, "Move-only cannot hold input; drag requires an owned button")
        try emit(drag ? "drag" : "move", p, down ?? .left, 0, 0, flags, nil, 0, 0, fields)
    }
    func buttonDown(_ p: CGPoint, button: CGMouseButton, count: Int64, flags: CGEventFlags = []) throws -> UInt64 {
        lock.lock(); defer { lock.unlock() }; try safe()
        try inputRequire(down == nil && inputDistance(io.pointer(), p) < 2.5, "Actual pointer has not arrived, or a button is already owned", code: "pointer_not_arrived")
        down = button
        do { try emit("down", p, button, count, 0, flags, nil, 0, 0) } catch { close("post_failed"); throw error }
        return io.now()
    }
    func buttonUp(count: Int64 = 1, flags: CGEventFlags = []) throws {
        lock.lock(); defer { lock.unlock() }; try safe()
        guard let b = down else { throw InputFailure("input_not_owned", "No owned mouse button") }
        try emit("up", io.pointer(), b, count, 0, flags, nil, 0, 0); down = nil
    }
    func key(_ code: CGKeyCode, down isDown: Bool, flags: CGEventFlags, text: String? = nil) throws {
        lock.lock(); defer { lock.unlock() }; try safe()
        if isDown { try inputRequire(!keys.contains(code), "Key is already owned"); keys.append(code) }
        else { try inputRequire(keys.contains(code), "Cannot release a key not owned by this request", code: "input_not_owned") }
        do { try emit(isDown ? "keyDown" : "keyUp", io.pointer(), .left, 0, code, flags, text, 0, 0) }
        catch { close("post_failed"); throw error }
        if !isDown { keys.removeAll { $0 == code } }
    }
    func scroll(x: Int32, y: Int32, flags: CGEventFlags) throws { lock.lock(); defer { lock.unlock() }; try safe(); try emit("scroll", io.pointer(), .left, 0, 0, flags, nil, x, y) }
    func flush(_ url: URL) throws {
        lock.lock(); let copy = rows, released = down == nil && keys.isEmpty; lock.unlock()
        // Memory-only while held: disk IO cannot delay release.
        try inputRequire(released, "Owned input could not be released; inspect the failed request", code: "release_failed")
        var data = Data(); for row in copy { data.append(try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])); data.append(10) }
        try data.write(to: url, options: .atomic); try FileManager.default.setAttributes([.posixPermissions:0o600], ofItemAtPath:url.path)
    }
}
func inputPause(_ seconds: Double, _ c: NativeInputControl) throws {
    let end = c.io.now() + UInt64(seconds*1e9)
    while true { let now = c.io.now(); if now >= end { break }; try inputRequire(c.active(), "Input aborted", code: "input_stopped"); c.io.sleep(min(0.004, Double(end-now)/1e9)) }
}
func inputMove(_ c: NativeInputControl, from: CGPoint, to: CGPoint, seconds: Double, easing: String, path: [InputPoint]? = nil, convert: (CGPoint) throws -> CGPoint = { $0 }, drag: Bool = false, flags: CGEventFlags = []) throws {
    let start = c.io.now(), end = start + UInt64(seconds*1e9), ticks = max(1, Int((seconds*60).rounded()))
    var lastTick = -1, lastPost: UInt64 = 0
    while true {
        try inputRequire(c.active(), "Motion aborted", code: "input_stopped")
        let now = c.io.now(); if now >= end { break }
        let tick = min(ticks-1, Int(Double(now-start)/1e9*60))
        if tick <= lastTick || (lastPost > 0 && now-lastPost < 16_000_000) { c.io.sleep(0.001); continue }
        let u = inputEase(Double(tick+1)/Double(ticks), easing)
        var point = CGPoint(x:from.x+(to.x-from.x)*u,y:from.y+(to.y-from.y)*u)
        if let path {
            let t = seconds*u; var j = 1
            while j < path.count-1 && path[j].t < t { j += 1 }
            let a = path[j-1], b = path[j], v = max(0,min(1,(t-a.t)/(b.t-a.t)))
            point = try convert(CGPoint(x:a.x+(b.x-a.x)*v,y:a.y+(b.y-a.y)*v))
        }
        try c.move(point, drag:drag, flags:flags, fields:["tick":tick,"missed_ticks":max(0,tick-lastTick-1),"lag_ns":now-start-UInt64(Double(tick)/60*1e9),"configured_duration_seconds":seconds])
        lastPost = c.io.now(); lastTick = tick
    }
    if !drag {
        let now = c.io.now()
        if lastPost > 0 && now < lastPost+16_000_000 { try inputPause(Double(lastPost+16_000_000-now)/1e9,c) }
        try c.move(to, fields:["event_phase":"final_endpoint"])
    }
    let arrivalDeadline = c.io.now()+100_000_000
    while inputDistance(c.io.pointer(),to) >= 2.5 && c.io.now() < arrivalDeadline { try inputPause(0.004,c) }
    try inputRequire(inputDistance(c.io.pointer(),to)<2.5, "Actual pointer did not reach the endpoint", code:"pointer_not_arrived")
    c.record(["event":"pointer_arrived","actual_x":c.io.pointer().x,"actual_y":c.io.pointer().y,"distance_to_target":inputDistance(c.io.pointer(),to)])
}
