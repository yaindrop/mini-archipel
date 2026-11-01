import Foundation
import CoreGraphics
import AppKit

func requirePointerListenerAccess(_ granted: Bool) throws {
    guard granted else {
        throw RecorderError("pointer_permission_required", localized("Input Monitoring is not granted to \(appName). Run pointer-authorize --interactive only if native mouse listening is wanted; ordinary capture and external-authorized events do not need it.", "尚未授予“\(appName)”输入监控权限。如需原生鼠标监听，请显式运行 pointer-authorize --interactive；普通录屏及外部已授权事件无需此权限。"))
    }
}

struct PointerInput: Codable {
    let hostTimeSeconds: Double
    let kind: String
    let x: Double
    let y: Double
    let button: String
    var targetWindowID: UInt32? = nil
    func validate() throws {
        guard hostTimeSeconds.isFinite, x.isFinite, y.isFinite,
              ["down", "move", "up"].contains(kind),
              ["none", "left", "right", "middle", "other"].contains(button),
              kind == "move" || button != "none" else {
            throw RecorderError("invalid_pointer_event", "Expected finite hostTimeSeconds/x/y, down|move|up and a valid mouse button.")
        }
    }
}
struct PointerEvent: Codable {
    let t: Double
    let kind: String
    let x: Double
    let y: Double
    let button: String
    let inside: Bool?
    var targetWindowID: UInt32? = nil
}
// Both native taps and authorized external input use Quartz global screen points.
// Mapping remains separate from hit testing so Retina/offset/drag boundaries can
// be checked without reading a desktop or requesting any input permission.
struct PointerTimeline {
    var origin: Double?
    var screenRect: CGRect
    var videoRect: CGRect
    var events: [PointerEvent] = []
    var pressed: Set<String> = []
    var lastHostTime = -Double.infinity
    mutating func append(_ event: PointerInput, targetHit: Bool) throws -> Bool {
        try event.validate()
        guard let origin, event.hostTimeSeconds >= origin else { return false }
        guard event.hostTimeSeconds >= lastHostTime else {
            throw RecorderError("pointer_clock_order", "Pointer events must use monotonically ordered host timestamps.")
        }
        lastHostTime = event.hostTimeSeconds
        guard screenRect.width > 0, screenRect.height > 0 else {
            throw RecorderError("pointer_geometry_unavailable", "Capture geometry is unavailable.")
        }
        let point = CGPoint(x: event.x, y: event.y)
        let inside = screenRect.contains(point) && targetHit
        switch event.kind {
        case "down":
            guard inside else { return false }
            guard !pressed.contains(event.button) else {
                throw RecorderError("invalid_pointer_event", "Duplicate mouse-down without a release.")
            }
            pressed.insert(event.button)
        case "up":
            guard pressed.remove(event.button) != nil else { return false }
        default:
            guard inside || !pressed.isEmpty else { return false }
        }
        guard events.count < 1_000_000 else { throw RecorderError("pointer_limit", "Pointer event limit reached; sidecar cannot be claimed complete.") }
        events.append(PointerEvent(t: event.hostTimeSeconds - origin, kind: event.kind,
            x: videoRect.minX + (point.x - screenRect.minX) / screenRect.width * videoRect.width,
            y: videoRect.minY + (point.y - screenRect.minY) / screenRect.height * videoRect.height,
            button: event.button, inside: inside, targetWindowID: event.targetWindowID))
        return true
    }
}
struct PointerGeometry {
    let hostTime: Double
    let screen: CGRect
    let video: CGRect
    var json: [String: Any] {
        ["hostTimeSeconds": hostTime,
         "screenPointsTopLeft": [screen.minX, screen.minY, screen.width, screen.height],
         "videoPixelsTopLeft": [video.minX, video.minY, video.width, video.height]]
    }
}
struct PointerWindow {
    let id: UInt32
    let rect: CGRect
    let alpha: Double
    let nonInputContainer: Bool
}
func pointerWindowHit(_ point: CGPoint, target: UInt32, actual: UInt32?, windows: [PointerWindow], visibleAreas: [CGRect]) -> Bool {
    if let actual, actual > 0 { return actual == target }
    // Quartz's Dock compositor can span the display without owning its input.
    // Without event attribution, reserve system edges and ignore that container.
    if windows.contains(where: { $0.nonInputContainer }), !visibleAreas.contains(where: { $0.contains(point) }) { return false }
    return windows.first(where: { !$0.nonInputContainer && $0.alpha > 0 && $0.rect.contains(point) })?.id == target
}
@MainActor final class PointerCapture {
    let source: String
    let sessionID = UUID().uuidString
    let reservation: OutputReservation
    let windowID: UInt32?
    let width: Int
    let height: Int
    var timeline: PointerTimeline
    var geometry: [PointerGeometry] = []
    var failure: Error?
    var tap: CFMachPort?
    var runLoopSource: CFRunLoopSource?
    var active = true

    init(path: String, source: String, windowID: UInt32?, screenRect: CGRect, width: Int, height: Int) throws {
        self.source = source; self.windowID = windowID; self.width = width; self.height = height
        reservation = try OutputReservation(path: path, fileExtension: "json")
        timeline = PointerTimeline(screenRect: screenRect, videoRect: CGRect(x: 0, y: 0, width: width, height: height))
    }
    static let mouseTypes: [CGEventType] = [.leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp,
        .otherMouseDown, .otherMouseUp, .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged]
    func startNative() throws {
        // Even a mouse-only tap can trigger a system prompt on creation.
        // Preflight must gate creation; diagnosis/start never request access.
        try requirePointerListenerAccess(CGPreflightListenEventAccess())
        let mask = Self.mouseTypes.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        tap = CGEvent.tapCreate(tap: .cgAnnotatedSessionEventTap, place: .tailAppendEventTap, options: .listenOnly,
            eventsOfInterest: mask, callback: { _, type, event, context in
                guard let context else { return Unmanaged.passUnretained(event) }
                let owner = Unmanaged<PointerCapture>.fromOpaque(context).takeUnretainedValue()
                // This tap is attached only to the main run loop.
                MainActor.assumeIsolated {
                    guard owner.active else { return }
                    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                        owner.failure = RecorderError("pointer_listener_interrupted", "Mouse listener was disabled; sidecar is incomplete.")
                        return
                    }
                    let kind = [.leftMouseDown, .rightMouseDown, .otherMouseDown].contains(type) ? "down" :
                        ([.leftMouseUp, .rightMouseUp, .otherMouseUp].contains(type) ? "up" : "move")
                    let number = event.getIntegerValueField(.mouseEventButtonNumber)
                    let button = type == .mouseMoved ? "none" : (number == 0 ? "left" : number == 1 ? "right" : number == 2 ? "middle" : "other")
                    do {
                        _ = try owner.append(PointerInput(hostTimeSeconds: Double(event.timestamp) / 1_000_000_000,
                            kind: kind, x: event.location.x, y: event.location.y, button: button, targetWindowID: UInt32(exactly: event.getIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent))))
                    } catch { owner.failure = error }
                }
                return Unmanaged.passUnretained(event)
            }, userInfo: Unmanaged.passUnretained(self).toOpaque())
        guard let tap else {
            throw RecorderError("pointer_permission_required", "Native mouse listening is unavailable. Run pointer-authorize --interactive for \(appName), or use external-authorized events without adding permissions.")
        }
        runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), runLoopSource, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        guard CGEvent.tapIsEnabled(tap: tap) else {
            stop()
            throw RecorderError("pointer_listener_unavailable", "The mouse-only listener could not be enabled.")
        }
    }
    func updateGeometry(hostTime: Double, screen: CGRect?, video: CGRect?) {
        let screen = screen ?? geometry.last?.screen ?? timeline.screenRect
        let video = video ?? geometry.last?.video ?? timeline.videoRect
        guard screen.width > 0, screen.height > 0, video.width > 0, video.height > 0 else { return }
        if let last = geometry.last, last.screen == screen, last.video == video { return }
        geometry.append(PointerGeometry(hostTime: hostTime, screen: screen, video: video))
        timeline.screenRect = screen; timeline.videoRect = video
    }
    func targetHit(_ point: CGPoint, actual: UInt32?) -> Bool {
        guard let windowID else { return timeline.screenRect.contains(point) }
        if let actual, actual > 0 { return actual == windowID }
        guard let entries = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return false }
        let screens = NSScreen.screens
        let desktopTop = screens.first?.frame.maxY ?? 0
        let displayAreas = screens.map { CGRect(x: $0.frame.minX, y: desktopTop - $0.frame.maxY, width: $0.frame.width, height: $0.frame.height) }
        let visibleAreas = screens.map { CGRect(x: $0.visibleFrame.minX, y: desktopTop - $0.visibleFrame.maxY, width: $0.visibleFrame.width, height: $0.visibleFrame.height) }
        let windows: [PointerWindow] = entries.compactMap { entry in
            guard let number = entry[kCGWindowNumber as String] as? NSNumber,
                  let bounds = entry[kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: bounds) else { return nil }
            let pid = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? 0
            let dock = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier == "com.apple.dock"
            let layer = (entry[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
            let fullDisplay = displayAreas.contains { abs($0.minX-rect.minX)<1 && abs($0.minY-rect.minY)<1 && abs($0.width-rect.width)<1 && abs($0.height-rect.height)<1 }
            return PointerWindow(id: number.uint32Value, rect: rect, alpha: (entry[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1, nonInputContainer: dock && layer == 20 && fullDisplay)
        }
        return pointerWindowHit(point, target: windowID, actual: actual, windows: windows, visibleAreas: visibleAreas)
    }
    func append(_ event: PointerInput) throws -> Bool {
        guard active else { throw RecorderError("pointer_not_recording", "Pointer capture has stopped.") }
        if let snapshot = geometry.last(where: { $0.hostTime <= event.hostTimeSeconds }) {
            timeline.screenRect = snapshot.screen; timeline.videoRect = snapshot.video
        }
        do { return try timeline.append(event, targetHit: targetHit(CGPoint(x: event.x, y: event.y), actual: event.targetWindowID)) }
        catch { failure = error; throw error }
    }
    func stop() {
        active = false
        if let tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }
        if let runLoopSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), runLoopSource, .commonModes) }
        tap = nil; runLoopSource = nil
    }
    func finalize(duration: Double, captureDuration: Double) throws {
        if let failure { throw failure }
        let events = timeline.events.filter { $0.t <= captureDuration }
        let value: [String: Any] = ["schemaVersion": 1, "width": width, "height": height,
            "coordinateSpace": "video-pixels-top-left", "timebase": "media-seconds", "source": source,
            "sessionID": sessionID, "clockOriginHostSeconds": timeline.origin ?? 0,
            "mappingSamples": geometry.map(\.json), "captureWindowID": windowID.map { $0 as Any } ?? NSNull(),
            "durationSeconds": duration, "captureDurationSeconds": captureDuration,
            "buttonsHeldAtStop": timeline.pressed.sorted(),
            "events": try JSONSerialization.jsonObject(with: JSONEncoder().encode(events))]
        try writeJSON(value, to: reservation.partial)
    }
}

// Offline adapter for agents that already possess a real authorized input log.
// The caller owns the coordinate/time conversion; its provenance is preserved.
func importPointerLog(input: String, video: String, output: String) async throws -> [String: Any] {
    let data = try Data(contentsOf: URL(fileURLWithPath: input), options: .mappedIfSafe)
    guard data.count <= 128 * 1024 * 1024,
          var document = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          document["schemaVersion"] as? Int == 1,
          document["coordinateSpace"] as? String == "video-pixels-top-left",
          document["timebase"] as? String == "media-seconds",
          document["source"] as? String == "external-authorized",
          let rows = document["events"] else {
        throw RecorderError("invalid_pointer_log", "Expected schemaVersion 1 video-pixels-top-left/media-seconds log with source external-authorized.")
    }
    let events = try JSONDecoder().decode([PointerEvent].self, from: JSONSerialization.data(withJSONObject: rows))
    let info = try await inspectMovie(URL(fileURLWithPath: video))
    guard document["width"] as? Int == info.width, document["height"] as? Int == info.height else {
        throw RecorderError("pointer_dimension_mismatch", "Sidecar dimensions do not match the actual video pixels.")
    }
    let boundary = (document["captureDurationSeconds"] as? NSNumber)?.doubleValue ?? info.duration
    guard boundary.isFinite, boundary >= 0, boundary <= info.duration + 0.05 else {
        throw RecorderError("invalid_pointer_log", "Invalid capture boundary.")
    }
    var previous = -Double.infinity
    var held = Set<String>()
    for event in events {
        try PointerInput(hostTimeSeconds: event.t, kind: event.kind, x: event.x, y: event.y, button: event.button).validate()
        guard event.t >= 0, event.t <= boundary, event.t >= previous else {
            throw RecorderError("invalid_pointer_log", "Events must be ordered media seconds inside the actual video duration.")
        }
        if event.kind == "down" {
            guard held.insert(event.button).inserted else { throw RecorderError("invalid_pointer_log", "Duplicate mouse-down.") }
        } else if event.kind == "up" {
            guard held.remove(event.button) != nil else { throw RecorderError("invalid_pointer_log", "Mouse-up has no matching down.") }
        }
        previous = event.t
    }
    let declaredHeld = Set(document["buttonsHeldAtStop"] as? [String] ?? [])
    guard held == declaredHeld else { throw RecorderError("invalid_pointer_log", "Unreleased buttons must match buttonsHeldAtStop; do not invent a release.") }
    document["durationSeconds"] = info.duration
    let reservation = try OutputReservation(path: output, fileExtension: "json")
    try writeJSON(document, to: reservation.partial)
    try reservation.commit(reservation.partial)
    return response(true, "pointer_log_imported", "External authorized pointer log validated without listening or changing the video.",
        ["output": reservation.url.path, "events": events.count, "source": "external-authorized"])
}
