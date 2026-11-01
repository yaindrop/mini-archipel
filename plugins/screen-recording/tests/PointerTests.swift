import Foundation
import CoreGraphics
@main struct PointerTests {
    static func check(_ value: Bool, _ message: String) {
        if !value { print("FAIL: \(message)"); exit(1) }
    }
    @MainActor static func main() async throws {
        do { try requirePointerListenerAccess(false); check(false, "Denied listener reached tap creation") }
        catch let error as RecorderError { check(error.code == "pointer_permission_required", "Wrong listener preflight error") }
        try requirePointerListenerAccess(true)
        let scene = PointerWindow(id: 191, rect: CGRect(x: 0, y: 0, width: 1920, height: 1080), alpha: 1, nonInputContainer: false)
        let dock = PointerWindow(id: 27, rect: scene.rect, alpha: 1, nonInputContainer: true)
        let notice = PointerWindow(id: 189, rect: CGRect(x: 830, y: 188, width: 260, height: 299), alpha: 1, nonInputContainer: false)
        let workspace = [CGRect(x: 0, y: 25, width: 1920, height: 980)]
        check(pointerWindowHit(CGPoint(x: 400, y: 450), target: 191, actual: nil, windows: [notice,dock,scene], visibleAreas: workspace), "Dock compositor incorrectly blocked real target input")
        check(!pointerWindowHit(CGPoint(x: 1050, y: 450), target: 191, actual: nil, windows: [notice,dock,scene], visibleAreas: workspace), "Real notification obstruction was ignored")
        check(!pointerWindowHit(CGPoint(x: 400, y: 1050), target: 191, actual: nil, windows: [dock,scene], visibleAreas: workspace), "Unattributed system-edge input was accepted")
        check(!pointerWindowHit(CGPoint(x: 400, y: 450), target: 191, actual: 27, windows: [dock,scene], visibleAreas: workspace), "Attributed Dock input was accepted")
        check(pointerWindowHit(CGPoint(x: 1050, y: 450), target: 191, actual: 191, windows: [notice,dock,scene], visibleAreas: workspace), "Actual event recipient lost to visual containers")
        var timeline = PointerTimeline(origin: 100, screenRect: CGRect(x: -500, y: 200, width: 400, height: 300),
                                       videoRect: CGRect(x: 0, y: 0, width: 800, height: 600))
        func event(_ t: Double, _ kind: String, _ x: Double, _ y: Double, _ button: String = "left") -> PointerInput {
            PointerInput(hostTimeSeconds: t, kind: kind, x: x, y: y, button: button)
        }
        check(try timeline.append(event(99, "down", -400, 250), targetHit: true) == false, "Pre-record event leaked")
        check(try timeline.append(event(100, "down", -400, 250), targetHit: false) == false, "Other window click leaked")
        check(try timeline.append(event(101, "down", -400, 250), targetHit: true), "Target click missing")
        check(timeline.events[0].x == 200 && timeline.events[0].y == 100 && timeline.events[0].t == 1, "Retina, offset or clock mapping wrong")
        check(try timeline.append(event(102, "move", 100, 250), targetHit: false), "Drag exit lost")
        check(timeline.events.last!.inside == false && timeline.events.last!.x == 1200, "Outside coordinates were clamped")
        check(try timeline.append(event(103, "up", 100, 250), targetHit: false), "Outside release lost")
        check(timeline.pressed.isEmpty, "Release left drag active")
        check(try timeline.append(event(104, "move", 100, 250), targetHit: false) == false, "Unrelated outside move leaked")
        do { _ = try timeline.append(event(103, "down", -400, 250), targetHit: true); check(false, "Clock reversal accepted") }
        catch let error as RecorderError { check(error.code == "pointer_clock_order", "Wrong clock error") }
        do { try event(105, "keyboard", 0, 0).validate(); check(false, "Keyboard accepted") }
        catch let error as RecorderError { check(error.code == "invalid_pointer_event", "Wrong kind error") }
        let folder = URL(fileURLWithPath: "test-results/pointer-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let pointer = try PointerCapture(path: folder.appendingPathComponent("geometry.json").path,
            source: "external-authorized", windowID: nil, screenRect: timeline.screenRect, width: 800, height: 600)
        pointer.timeline.origin = 100
        pointer.updateGeometry(hostTime: 100, screen: CGRect(x: -500, y: 200, width: 400, height: 300), video: nil)
        pointer.updateGeometry(hostTime: 102, screen: CGRect(x: -300, y: 200, width: 400, height: 300), video: nil)
        _ = try pointer.append(event(101, "down", -400, 250))
        _ = try pointer.append(event(103, "up", -200, 250))
        check(pointer.timeline.events.map(\.x) == [200, 200], "Historical window movement mapping wrong")
        pointer.stop()
        let video = folder.appendingPathComponent("test.mp4")
        _ = try await syntheticMovie(video.path)
        let input = folder.appendingPathComponent("input.json"), output = folder.appendingPathComponent("output.json")
        let document: [String: Any] = ["schemaVersion": 1, "width": 320, "height": 180,
            "coordinateSpace": "video-pixels-top-left", "timebase": "media-seconds", "source": "external-authorized",
            "mappingEvidence": "test fixture", "events": [["t": 0.1, "kind": "down", "x": 10, "y": 20, "button": "left"],
                ["t": 0.2, "kind": "up", "x": 400, "y": 20, "button": "left", "inside": false]]]
        try writeJSON(document, to: input)
        _ = try await importPointerLog(input: input.path, video: video.path, output: output.path)
        let saved = try JSONSerialization.jsonObject(with: Data(contentsOf: output)) as! [String: Any]
        check(saved["mappingEvidence"] as? String == "test fixture", "Import lost provenance")
        do { _ = try await importPointerLog(input: input.path, video: video.path, output: output.path); check(false, "Existing sidecar overwritten") }
        catch let error as RecorderError { check(error.code == "output_exists", "Wrong overwrite error") }
        var bad = document; bad["width"] = 640; try writeJSON(bad, to: input)
        do { _ = try await importPointerLog(input: input.path, video: video.path, output: folder.appendingPathComponent("bad.json").path); check(false, "Wrong dimensions accepted") }
        catch let error as RecorderError { check(error.code == "pointer_dimension_mismatch", "Wrong dimension error") }
        bad = document; bad["events"] = [["t": 10, "kind": "down", "x": 10, "y": 20, "button": "left"]]; try writeJSON(bad, to: input)
        do { _ = try await importPointerLog(input: input.path, video: video.path, output: folder.appendingPathComponent("late.json").path); check(false, "Post-record event accepted") }
        catch let error as RecorderError { check(error.code == "invalid_pointer_log", "Wrong boundary error") }
        print("PASS: Retina/offset/media clock, other-window filtering, drag exit/release, clock reversal, keyboard rejection, offline schema import/provenance/no-overwrite/dimensions; no GUI/input permission.")
    }
}
