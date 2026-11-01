import AppKit
import ScreenCaptureKit
import CoreMedia
import CoreGraphics
import CoreImage

@MainActor final class Capture: NSObject, SCStreamOutput, SCStreamDelegate, SCRecordingOutputDelegate {
    var latestCompleteFrame: CMSampleBuffer?
    var windowPID: pid_t?
    var pointer: PointerCapture?
    var firstFrameHostSeconds: Double?
    var configuredRect = CGRect.zero
    var videoWidth = 0
    var videoHeight = 0
    var stream: SCStream?
    var recording: SCRecordingOutput?
    var frameCount = 0
    var lastFrameAt: Date?
    var outputStarted = false
    var outputFinished = false
    var failure: Error?
    var reservation: OutputReservation?
    var recordingStartedUptime: Double?
    var startedAt: Date?
    var fps = 60
    var tail = 0.0
    var displayID: UInt32 = 0
    var windowID: UInt32?
    var stopping = false
    var timer: Task<Void, Never>?
    var onStopped: (([String: Any]) -> Void)?
    var isProbe = false

    nonisolated func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .screen, sampleBuffer.isValid,
              let values = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = values.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds
        let metadata = values.first ?? [:]
        let screen = (metadata[.screenRect] as? NSDictionary).flatMap { CGRect(dictionaryRepresentation: $0) }
        let content = (metadata[.contentRect] as? NSDictionary).flatMap { CGRect(dictionaryRepresentation: $0) }
        let scale = (metadata[.scaleFactor] as? NSNumber)?.doubleValue
        Task { @MainActor in
            self.latestCompleteFrame = sampleBuffer
            self.frameCount += 1; self.lastFrameAt = Date()
            if self.firstFrameHostSeconds == nil { self.firstFrameHostSeconds = pts; self.pointer?.timeline.origin = pts }
            let pixelRect: CGRect?
            if let content, let scale, scale > 0 {
                pixelRect = CGRect(x: content.minX * scale, y: content.minY * scale,
                    width: content.width * scale, height: content.height * scale)
            } else { pixelRect = nil }
            self.pointer?.updateGeometry(hostTime: pts, screen: screen, video: pixelRect)
        }
    }
    nonisolated func stream(_ stream: SCStream, didStopWithError error: Error) {
        Task { @MainActor in
            self.failure = RecorderError("capture_failed", error.localizedDescription)
            if !self.isProbe && !self.stopping { _ = await self.stop() }
        }
    }
    nonisolated func recordingOutputDidStartRecording(_ recordingOutput: SCRecordingOutput) {
        let uptime = ProcessInfo.processInfo.systemUptime
        Task { @MainActor in self.outputStarted = true; self.recordingStartedUptime = uptime }
    }
    nonisolated func recordingOutputDidFinishRecording(_ recordingOutput: SCRecordingOutput) {
        Task { @MainActor in self.outputFinished = true }
    }
    nonisolated func recordingOutput(_ recordingOutput: SCRecordingOutput, didFailWithError error: Error) {
        Task { @MainActor in
            self.failure = RecorderError("write_failed", error.localizedDescription)
            if !self.stopping { _ = await self.stop() }
        }
    }
    static func desktopPresent() -> Bool {
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any],
              session[kCGSessionOnConsoleKey as String] as? Bool == true else { return false }
        var count: UInt32 = 0
        return CGGetActiveDisplayList(0, nil, &count) == .success && count > 0
    }
    func configure(_ request: Request) async throws {
        guard Self.desktopPresent() else { throw RecorderError("desktop_unavailable", "No active local GUI desktop is available.") }
        guard CGPreflightScreenCaptureAccess() else { throw RecorderError("permission_required", localized("Screen Recording permission has not been granted to \(appName). Run authorize --interactive.", "尚未授予“\(appName)”屏幕录制权限。请运行 authorize --interactive。")) }
        let content: SCShareableContent
        do { content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false) }
        catch { throw RecorderError("capture_unavailable", "Cannot enumerate screen content: \(error.localizedDescription)") }
        let wanted = request.display ?? CGMainDisplayID()
        let filter: SCContentFilter
        if let id = request.window {
            guard let window = content.windows.first(where: { $0.windowID == id }), window.isOnScreen else {
                throw RecorderError("window_not_found", "Window \(id) is not available on screen.")
            }
            filter = SCContentFilter(desktopIndependentWindow: window)
            windowID = id
            windowPID = window.owningApplication?.processID
            configuredRect = window.frame
        } else {
        guard let display = content.displays.first(where: { $0.displayID == wanted }) else {
            throw RecorderError("display_not_found", "Display \(wanted) is not available. Use displays to list current IDs.")
        }
        configuredRect = display.frame
        let appIDs = Set(request.excludedApps)
        let apps = content.applications.filter { appIDs.contains($0.bundleIdentifier) || $0.bundleIdentifier == bundleID }
        let missingApps = appIDs.subtracting(Set(apps.map(\.bundleIdentifier)))
        guard missingApps.isEmpty else { throw RecorderError("excluded_app_not_found", "Excluded app is not running: \(missingApps.sorted().joined(separator: ", ")).") }
        let windowIDs = Set(request.excludedWindows)
        guard windowIDs.isSubset(of: Set(content.windows.map(\.windowID))) else {
            throw RecorderError("excluded_window_not_found", "An excluded window ID is not available.")
        }
        // Exceptions from an excluded application would re-include its window.
        // Only explicit windows belonging to other apps are exclusion exceptions.
        let exceptions = content.windows.filter { windowIDs.contains($0.windowID) && !appIDs.contains($0.owningApplication?.bundleIdentifier ?? "") }
        filter = SCContentFilter(display: display, excludingApplications: apps, exceptingWindows: exceptions)
        }
        let config = SCStreamConfiguration()
        config.width = Int(filter.contentRect.width * CGFloat(filter.pointPixelScale)) / 2 * 2
        config.height = Int(filter.contentRect.height * CGFloat(filter.pointPixelScale)) / 2 * 2
        videoWidth = config.width; videoHeight = config.height
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(request.fps))
        config.showsCursor = true
        config.ignoreShadowsSingleWindow = true
        config.capturesAudio = false
        config.captureMicrophone = false
        config.queueDepth = 4
        config.pixelFormat = kCVPixelFormatType_32BGRA
        stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream!.addStreamOutput(self, type: .screen, sampleHandlerQueue: .main)
        fps = request.fps; tail = request.tail; displayID = wanted
    }
    func probe(timeout: Double = 5) async throws -> [String: Any] {
        isProbe = true
        try await configure(Request(action: "probe"))
        defer { stream = nil }
        do {
            try await stream!.startCapture()
            let deadline = Date().addingTimeInterval(timeout)
            while frameCount == 0 && failure == nil && Date() < deadline { await deadlineSleep() }
            try? await stream!.stopCapture()
            if let failure { throw failure }
            guard frameCount > 0 else { throw RecorderError("no_frames", "Permission appears granted, but the real capture stream delivered no complete frames.") }
            return ["permission": "granted", "completeFrames": frameCount, "displayID": displayID, "probe": "real_stream"]
        } catch { try? await stream?.stopCapture(); throw error }
    }
    func start(_ request: Request) async throws -> [String: Any] {
        do {
            guard request.pointerSource != "external-authorized" else {
                throw RecorderError("external_pointer_unavailable", "Online external pointer capture is disabled; use native capture or offline pointer-import.")
            }
            guard (request.pointerOutput == nil) == (request.pointerSource == nil),
                  request.pointerSource == nil || ["native", "external-authorized"].contains(request.pointerSource!) else {
                throw RecorderError("invalid_argument", "Pointer output and a valid explicit source must be selected together.")
            }
            guard let path = request.output else { throw RecorderError("invalid_argument", "start requires --output.") }
            reservation = try OutputReservation(path: path)
            try await configure(request)
            if let path = request.pointerOutput, let source = request.pointerSource {
                pointer = try PointerCapture(path: path, source: source, windowID: windowID,
                    screenRect: configuredRect, width: videoWidth, height: videoHeight)
                if source == "native" { try pointer!.startNative() }
            }
            let config = SCRecordingOutputConfiguration()
            config.outputURL = reservation!.partial
            config.outputFileType = .mp4
            config.videoCodecType = .h264
            recording = SCRecordingOutput(configuration: config, delegate: self)
            try stream!.addRecordingOutput(recording!)
            try await stream!.startCapture()
            let deadline = Date().addingTimeInterval(min(request.timeout, 15))
            while (!outputStarted || frameCount == 0) && failure == nil && Date() < deadline { await deadlineSleep() }
            if let failure { throw failure }
            guard outputStarted && frameCount > 0 else { throw RecorderError("no_frames", "Recording did not become ready: a writer-start callback and a complete frame are both required.") }
            if pointer != nil {
                guard let origin = firstFrameHostSeconds, origin.isFinite,
                      abs(origin - ProcessInfo.processInfo.systemUptime) < 30 else {
                    throw RecorderError("pointer_clock_unavailable", "Stream timestamps cannot be aligned with host monotonic time.")
                }
            }
            startedAt = Date()
            if let seconds = request.duration {
                timer = Task { @MainActor [weak self] in
                    do { try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) } catch { return }
                    guard let self, !self.stopping else { return }
                    _ = await self.stop()
                }
            }
            return response(true, "ready", "Recording is receiving real frames; output is not finalized until stopped.", status())
        } catch {
            failure = error
            _ = await stop()
            throw error
        }
    }
    func snapshot(path: String) throws -> [String: Any] {
        guard !stopping, outputStarted, let sample = latestCompleteFrame,
              let pixel = CMSampleBufferGetImageBuffer(sample), let origin = firstFrameHostSeconds,
              let recordingOutput = reservation?.url.path else {
            throw RecorderError("snapshot_unavailable", "A running stream with a real complete frame is required.")
        }
        let hostPTS = CMSampleBufferGetPresentationTimeStamp(sample).seconds
        guard hostPTS.isFinite, hostPTS >= origin else { throw RecorderError("snapshot_clock_invalid", "The complete frame has no valid media timestamp.") }
        let image = CIImage(cvPixelBuffer: pixel)
        guard let cgImage = CIContext().createCGImage(image, from: image.extent),
              let png = NSBitmapImageRep(cgImage: cgImage).representation(using: .png, properties: [:]) else {
            throw RecorderError("snapshot_encode_failed", "Could not encode the complete frame as PNG.")
        }
        let output = try OutputReservation(path: path, fileExtension: "png")
        let metadata = try OutputReservation(path: output.url.deletingPathExtension().appendingPathExtension("json").path, fileExtension: "json")
        let result = response(true, "snapshot_saved", "Latest real complete stream frame saved without interrupting recording.",
            ["snapshotOutput": output.url.path, "recordingOutput": recordingOutput,
             "hostTimeSeconds": hostPTS, "mediaTimeSeconds": hostPTS - origin,
             "clockOriginHostSeconds": origin, "width": cgImage.width, "height": cgImage.height,
             "windowID": windowID.map { $0 as Any } ?? NSNull(),
             "pid": windowPID.map { $0 as Any } ?? NSNull(), "bytes": png.count])
        try png.write(to: output.partial)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: output.partial.path)
        try writeJSON(result, to: metadata.partial)
        try output.commit(output.partial)
        try metadata.commit(metadata.partial)
        return result
    }
    func status() -> [String: Any] {
        var data: [String: Any] = ["state": stopping ? "stopping" : "recording", "completeFrames": frameCount,
            "outputStarted": outputStarted, "outputFinished": outputFinished, "fpsRequested": fps, "displayID": displayID]
        if let windowID { data["windowID"] = windowID; data["captureMode"] = "window" } else { data["captureMode"] = "display" }
        if let reservation { data["output"] = reservation.url.path; data["partial"] = reservation.partial.path }
        if let pointer {
            data["pointerSource"] = pointer.source; data["pointerOutput"] = pointer.reservation.url.path
            data["pointerSessionID"] = pointer.sessionID
            data["clockOriginHostSeconds"] = pointer.timeline.origin
            data["pointerEvents"] = pointer.timeline.events.count
        }
        if let startedAt { data["elapsedSeconds"] = Date().timeIntervalSince(startedAt) }
        if let lastFrameAt { data["lastCompleteFrameAt"] = ISO8601DateFormatter().string(from: lastFrameAt) }
        return data
    }
    func stop() async -> [String: Any] {
        if stopping { return response(false, "busy", "Recording is already finalizing.", status()) }
        let captureSeconds = (firstFrameHostSeconds ?? recordingStartedUptime).map { max(0, ProcessInfo.processInfo.systemUptime - $0) } ?? 0
        stopping = true; timer?.cancel(); pointer?.stop()
        let watchdog = Task { @MainActor [weak self] in
            do { try await Task.sleep(nanoseconds: 120_000_000_000) } catch { return }
            guard let self else { return }
            self.onStopped?(response(false, "finalize_timeout", "Finalization exceeded 120 seconds. Partial files were preserved; the helper will exit.", self.status().merging(["state": "failed"]) { _, new in new }))
            exit(1)
        }
        defer { watchdog.cancel() }
        let result: [String: Any]
        do {
            if let stream { try await stream.stopCapture() }
            if recording != nil {
                let deadline = Date().addingTimeInterval(25)
                while !outputFinished && failure == nil && Date() < deadline { await deadlineSleep() }
                if let failure { throw failure }
                guard outputFinished else { throw RecorderError("finalize_timeout", "Recording output did not confirm file completion.") }
            }
            if let failure { throw failure }
            guard frameCount > 0, let reservation else { throw RecorderError("no_frames", "No complete screen frames were received.") }
            let finalSource = reservation.partial.deletingLastPathComponent().appendingPathComponent(".\(UUID().uuidString).tail.mp4")
            let source = reservation.partial; let seconds = tail; let rate = fps
            try await Task.detached {
                try await appendFrozenTail(source: source, destination: finalSource, seconds: seconds,
                                           fps: rate, minimumDuration: captureSeconds)
            }.value
            let info = try await inspectMovie(finalSource)
            try pointer?.finalize(duration: info.duration, captureDuration: captureSeconds)
            try reservation.commit(finalSource)
            if let pointer { try pointer.reservation.commit(pointer.reservation.partial) }
            if finalSource != reservation.partial { try? FileManager.default.removeItem(at: reservation.partial) }
            var pointerDetails: [String: Any] = [:]
            if let pointer { pointerDetails = ["pointerOutput": pointer.reservation.url.path, "pointerSource": pointer.source, "pointerEvents": pointer.timeline.events.count] }
            result = response(true, "completed", "MP4 finalized; every video frame decoded and the terminal frame timeline verified.", info.json.merging([
                "state": "completed", "output": reservation.url.path, "completeFrames": frameCount,
                "captureSecondsMeasured": captureSeconds, "tailSecondsRequested": tail, "fpsRequested": fps, "displayID": displayID,
                "captureMode": windowID == nil ? "display" : "window", "windowID": windowID.map { $0 as Any } ?? NSNull()]) { _, new in new }.merging(pointerDetails) { _, new in new })
        } catch {
            var details = status(); details["state"] = "failed"
            result = errorResponse(error).merging(details) { _, new in new }
        }
        stream = nil; recording = nil; reservation = nil
        onStopped?(result)
        return result
    }
}
