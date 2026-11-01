import Foundation
import AppKit
import CoreMedia
import CoreVideo

@main struct StateTests {
    static func check(_ condition: Bool, _ message: String = "Check failed") {
        if !condition { FileHandle.standardError.write(Data(("FAIL: " + message + "\n").utf8)); exit(1) }
    }
    @MainActor static func main() async throws {
        try prepareSupport()
        let pending = Request(action: "authorize")
        let requestFile = supportRoot.appendingPathComponent("requests/\(pending.id).request")
        try JSONEncoder().encode(pending).write(to: requestFile)
        let claimed = try claimRequest(requestFile)
        check(!FileManager.default.fileExists(atPath: requestFile.path), "Accepted authorization remained replayable")
        check(FileManager.default.fileExists(atPath: claimed.path), "Missing accepted-request evidence")
        try recoverClaimedRequests()
        check(!FileManager.default.fileExists(atPath: claimed.path), "Recovered request remained replayable")
        let resultFile = supportRoot.appendingPathComponent("responses/\(pending.id).json")
        let interrupted = try JSONSerialization.jsonObject(with: Data(contentsOf: resultFile)) as! [String: Any]
        check(interrupted["code"] as? String == "operation_interrupted", "Interrupted authorization was not reported")
        try FileManager.default.removeItem(at: resultFile)
        let folder = supportRoot.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let existing = folder.appendingPathComponent("existing.mp4")
        let original = Data("keep-original".utf8)
        try original.write(to: existing)
        let service = Service()
        service.activeRequestID = pending.id; service.activeAction = "authorize-check"
        service.publish()
        let processing = try JSONSerialization.jsonObject(with: Data(contentsOf: supportRoot.appendingPathComponent("state.json"))) as! [String: Any]
        check(processing["state"] as? String == "processing" && processing["activeAction"] as? String == "authorize-check", "Active authorization was misreported as an old completed recording")
        let liveStatus = try await service.handle(Request(action: "status"))
        check(liveStatus["code"] as? String == "processing" && liveStatus["activeAction"] as? String == "authorize-check", "Live status reported old completion during active authorization")
        service.last = response(true, "completed", "Existing completed recording.", ["state": "completed"])
        service.activeAction = "status"
        check(service.statusResponse()["state"] as? String == "completed", "Status misclassified itself as a long-running operation")
        service.publish()
        let selfQuery = try JSONSerialization.jsonObject(with: Data(contentsOf: supportRoot.appendingPathComponent("state.json"))) as! [String: Any]
        check(selfQuery["state"] as? String == "completed", "Persisted status misclassified its own query")
        service.activeRequestID = nil; service.activeAction = nil
        var request = Request(action: "start"); request.output = existing.path
        do { _ = try await service.handle(request); check(false, "Existing output must be rejected") }
        catch let error as RecorderError { check(error.code == "output_exists", error.code) }
        check(service.capture == nil, "Failed start leaked the capture slot")
        request.output = folder.appendingPathComponent("missing-parent/retry.mp4").path
        do { _ = try await service.handle(request); check(false, "Missing parent must be rejected") }
        catch let error as RecorderError { check(error.code == "write_failed", "Retry got \(error.code), expected real path validation rather than busy") }
        check(service.capture == nil)
        let unchanged = try Data(contentsOf: existing)
        check(unchanged == original)
        let sampleCapture = Capture()
        do { _ = try sampleCapture.snapshot(path: folder.appendingPathComponent("missing.snapshot.png").path); check(false) }
        catch let error as RecorderError { check(error.code == "snapshot_unavailable") }
        var pixels: CVPixelBuffer?
        check(CVPixelBufferCreate(kCFAllocatorDefault, 32, 16, kCVPixelFormatType_32BGRA, nil, &pixels) == kCVReturnSuccess)
        var format: CMVideoFormatDescription?
        check(CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pixels!, formatDescriptionOut: &format) == noErr)
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 60), presentationTimeStamp: CMTime(value: 12, timescale: 1), decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        check(CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pixels!, formatDescription: format!, sampleTiming: &timing, sampleBufferOut: &sample) == noErr)
        sampleCapture.latestCompleteFrame = sample; sampleCapture.firstFrameHostSeconds = 10
        sampleCapture.outputStarted = true; sampleCapture.windowID = 238; sampleCapture.windowPID = 123
        sampleCapture.reservation = try OutputReservation(path: folder.appendingPathComponent("snapshot-recording.mp4").path)
        let snapshotService = Service(); snapshotService.capture = sampleCapture
        var wrongRecording = Request(action: "snapshot")
        wrongRecording.output = folder.appendingPathComponent("wrong.snapshot.png").path
        wrongRecording.video = folder.appendingPathComponent("another-recording.mp4").path
        do { _ = try await snapshotService.handle(wrongRecording); check(false) }
        catch let error as RecorderError { check(error.code == "snapshot_recording_changed") }
        snapshotService.capture = nil
        let pngPath = folder.appendingPathComponent("fixture.snapshot.png").path
        let snapshot = try sampleCapture.snapshot(path: pngPath)
        check(snapshot["mediaTimeSeconds"] as? Double == 2 && snapshot["hostTimeSeconds"] as? Double == 12)
        check(snapshot["windowID"] as? UInt32 == 238 && snapshot["pid"] as? pid_t == 123)
        let png = NSBitmapImageRep(data: try Data(contentsOf: URL(fileURLWithPath: pngPath)))!
        check(png.pixelsWide == 32 && png.pixelsHigh == 16)
        do { _ = try sampleCapture.snapshot(path: pngPath); check(false) }
        catch let error as RecorderError { check(error.code == "output_exists") }
        sampleCapture.stopping = true
        do { _ = try sampleCapture.snapshot(path: folder.appendingPathComponent("stopped.snapshot.png").path); check(false) }
        catch let error as RecorderError { check(error.code == "snapshot_unavailable") }
        sampleCapture.reservation = nil
        try FileManager.default.removeItem(at: folder)
        print("PASS: latest complete frame PNG dimensions, media PTS, identity, no overwrite and active-frame gate; synthetic buffers only.")
        print("PASS: accepted authorization cannot replay after restart; output_exists → released slot → retry reaches write validation; original bytes intact. No GUI or screen capture.")
    }
}
