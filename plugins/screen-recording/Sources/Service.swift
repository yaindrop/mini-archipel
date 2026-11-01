import AppKit
import CoreGraphics
import ScreenCaptureKit
import Darwin

@MainActor final class Service: NSObject, NSApplicationDelegate {
    var capture: Capture?
    var last: [String: Any] = response(true, "idle", "No active recording.", ["state": "idle"])
    var processing = false
    var activeAction: String?
    var activeRequestID: String?
    var lockFD: Int32 = -1
    var timer: Timer?
    var lastRequest = Date()
    var signals: [DispatchSourceSignal] = []
    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            guard Bundle.main.bundleIdentifier == bundleID, Bundle.main.bundleURL.standardizedFileURL == installedApp else {
                throw RecorderError("wrong_installation", "Install and launch the helper at \(installedApp.path).")
            }
            try prepareSupport()
            lockFD = open(supportRoot.appendingPathComponent("helper.lock").path, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
            guard lockFD >= 0, flock(lockFD, LOCK_EX | LOCK_NB) == 0 else { NSApp.terminate(nil); return }
            try recoverClaimedRequests()
            let previous = supportRoot.appendingPathComponent("state.json")
            if let data = try? Data(contentsOf: previous), let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                last = state
                last["appName"] = appName; last["bundleID"] = bundleID; last["appPath"] = installedApp.path
                if ["recording", "stopping", "processing"].contains(state["state"] as? String ?? "") {
                    last = response(false, "interrupted", "The previous helper exited before finalization. Partial files were preserved.", ["state": "failed", "previousOutput": state["output"] ?? NSNull()])
                }
            }
            publish()
            timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
                Task { @MainActor in await self?.scan() }
            }
            for sig in [SIGTERM, SIGINT] {
                signal(sig, SIG_IGN)
                let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
                source.setEventHandler { [weak self] in Task { @MainActor in
                    if let active = self?.capture { _ = await active.stop() }
                    NSApp.terminate(nil)
                } }
                source.resume(); signals.append(source)
            }
        } catch { emit(errorResponse(error)); NSApp.terminate(nil) }
    }
    func publish() {
        var state = capture?.status() ?? last
        if let activeRequestID, let activeAction, activeAction != "status" {
            state["activeRequestID"] = activeRequestID; state["activeAction"] = activeAction
            if capture == nil { state["state"] = "processing" }
        }
        state["helperPID"] = getpid()
        state["updatedAt"] = ISO8601DateFormatter().string(from: Date())
        try? writeJSON(state, to: supportRoot.appendingPathComponent("state.json"))
    }
    func statusResponse() -> [String: Any] {
        if let capture { return response(true, "recording", "Current capture state.", capture.status()) }
        if let activeRequestID, let activeAction, activeAction != "status" {
            return response(true, "processing", "A helper operation is still in progress.",
                ["state": "processing", "activeRequestID": activeRequestID, "activeAction": activeAction])
        }
        return last
    }
    func scan() async {
        if processing {
            // Status stays responsive while file finalization or authorization waits.
            let folder = supportRoot.appendingPathComponent("requests")
            for file in (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? [] {
                guard file.pathExtension == "request", let data = try? Data(contentsOf: file),
                      let req = try? JSONDecoder().decode(Request.self, from: data), req.action == "status",
                      UUID(uuidString: req.id) != nil, req.id == file.deletingPathExtension().lastPathComponent else { continue }
                let value = statusResponse()
                try? writeJSON(value, to: supportRoot.appendingPathComponent("responses/\(req.id).json"))
                try? FileManager.default.removeItem(at: file)
            }
            return
        }
        if capture == nil && Date().timeIntervalSince(lastRequest) > 45 { NSApp.terminate(nil); return }
        let folder = supportRoot.appendingPathComponent("requests")
        guard let files = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        for file in files.filter({ $0.pathExtension == "request" }).sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            processing = true; lastRequest = Date()
            let value: [String: Any]
            var request: Request?
            var claimed: URL?
            do {
                let data = try Data(contentsOf: file)
                guard data.count <= 65536 else { throw RecorderError("invalid_request", "Request is too large.") }
                request = try JSONDecoder().decode(Request.self, from: data)
                guard request!.id == file.deletingPathExtension().lastPathComponent,
                      UUID(uuidString: request!.id) != nil else { throw RecorderError("invalid_request", "Invalid request ID.") }
                guard request!.expires > Date() else { throw RecorderError("request_expired", "Request expired before execution.") }
                claimed = try claimRequest(file)
                activeRequestID = request!.id; activeAction = request!.action
                publish()
                let id = request!.id
                let remaining = max(0, request!.expires.timeIntervalSinceNow)
                // Interactive authorization may wait for a person; its post-restart
                // real-stream check must not inherit minutes of UI waiting time.
                let wait = min(remaining, ["doctor", "authorize-check"].contains(request!.action) ? 15 : remaining) + 1
                DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in
                    guard let self, self.processing, self.activeRequestID == id else { return }
                    self.last = response(false, "operation_timeout", "Native operation exceeded its deadline. Partial files were preserved; helper will exit.", ["state": "failed"])
                    try? writeJSON(self.last, to: supportRoot.appendingPathComponent("responses/\(id).json"))
                    try? writeJSON(self.last, to: supportRoot.appendingPathComponent("state.json"))
                    exit(1)
                }
                value = try await handle(request!)
            } catch { value = errorResponse(error) }
            if let request { try? writeJSON(value, to: supportRoot.appendingPathComponent("responses/\(request.id).json")) }
            if let claimed { try? FileManager.default.removeItem(at: claimed) }
            try? FileManager.default.removeItem(at: file)
            processing = false; activeRequestID = nil; activeAction = nil; publish()
            return
        }
    }
    func handle(_ request: Request) async throws -> [String: Any] {
        switch request.action {
        case "status":
            return statusResponse()
        case "start":
            guard capture == nil else { throw RecorderError("busy", "Another recording is active.") }
            let active = Capture(); capture = active
            active.onStopped = { [weak self] value in self?.last = value; self?.capture = nil; self?.publish() }
            return try await active.start(request)
        case "stop":
            guard let active = capture else {
                if ["completed", "failed"].contains(last["state"] as? String ?? "") { return last }
                throw RecorderError("no_active_recording", "No recording has started. No MP4 completion is claimed.")
            }
            return await active.stop()
        case "snapshot":
            guard let active = capture, let path = request.output else {
                throw RecorderError("snapshot_unavailable", "An active recording and a new PNG output are required.")
            }
            if let expected = request.video, active.reservation?.url.path != expected {
                throw RecorderError("snapshot_recording_changed", "The requested recording is no longer active; no frame was saved.")
            }
            return try active.snapshot(path: path)
        case "pointer-event":
            guard let active = capture, !active.stopping, let pointer = active.pointer,
                  pointer.source == "external-authorized", request.pointerSession == pointer.sessionID,
                  let event = request.pointerEvent else {
                throw RecorderError("pointer_session_required", "An active matching external-authorized pointer session is required.")
            }
            guard event.hostTimeSeconds <= ProcessInfo.processInfo.systemUptime + 0.05 else {
                throw RecorderError("pointer_clock_future", "Pointer timestamps must describe completed real input events, not future actions.")
            }
            let accepted = try pointer.append(event)
            return response(true, "pointer_event", "External authorized mouse event processed.", ["accepted": accepted])
        case "pointer-doctor", "pointer-authorize":
            guard capture == nil else { throw RecorderError("busy", "Stop recording before mouse-listener diagnostics.") }
            guard Capture.desktopPresent() else { throw RecorderError("desktop_unavailable", "No active local GUI desktop.") }
            // Test only a mouse tap; do not infer keyboard or posting permissions.
            func checkTap() throws {
                let folder = supportRoot.appendingPathComponent(".pointer-probe-\(UUID().uuidString).json")
                let probe = try PointerCapture(path: folder.path, source: "native", windowID: nil,
                    screenRect: .zero, width: 1, height: 1)
                defer { probe.stop() }
                try probe.startNative()
            }
            do { try checkTap() }
            catch {
                guard request.action == "pointer-authorize" else { throw error }
                NSApp.activate(ignoringOtherApps: true)
                _ = CGRequestListenEventAccess()
                NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")!)
                throw RecorderError("pointer_permission_required", localized("Enable Input Monitoring for \(appName) at \(installedApp.path), then retry pointer-doctor. Ordinary recording and external-authorized events do not require this permission.", "请在系统输入监控中启用“\(appName)”（\(installedApp.path)），然后重试 pointer-doctor。普通录屏和外部已授权事件不需要此权限。"))
            }
            return response(true, "pointer_listener_usable", "A mouse-only listen-only tap can be created. No keyboard events were subscribed.")
        case "doctor":
            if let active = capture, active.frameCount > 0, !active.stopping {
                return response(true, "usable", "An active real stream proves screen access.", active.status())
            }
            return response(true, "usable", "A real capture stream delivered complete frames. No file was recorded.", try await Capture().probe())
        case "displays", "windows":
            guard Capture.desktopPresent() else { throw RecorderError("desktop_unavailable", "No active local GUI desktop.") }
            guard CGPreflightScreenCaptureAccess() else { throw RecorderError("permission_required", "Authorize this helper before enumerating capture targets.") }
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            return response(true, "targets", "Current capture targets.", ["displays": content.displays.map {
                ["id": $0.displayID, "width": $0.width, "height": $0.height, "main": $0.displayID == CGMainDisplayID()] as [String: Any]
            }, "windows": content.windows.map { ["id": $0.windowID, "bundleID": $0.owningApplication?.bundleIdentifier ?? "", "title": $0.title ?? "", "pid": $0.owningApplication?.processID ?? 0, "onScreen": $0.isOnScreen, "frame": ["x": $0.frame.minX, "y": $0.frame.minY, "width": $0.frame.width, "height": $0.frame.height]] as [String: Any] }])
        case "authorize", "authorize-check":
            guard capture == nil else { throw RecorderError("busy", "Stop the recording before changing authorization.") }
            guard Capture.desktopPresent() else { throw RecorderError("desktop_unavailable", "No active local GUI desktop.") }
            if request.action == "authorize" && !CGPreflightScreenCaptureAccess() {
                NSApp.activate(ignoringOtherApps: true)
                _ = CGRequestScreenCaptureAccess()
                if !CGPreflightScreenCaptureAccess() {
                    NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)
                }
            }
            let deadline = min(request.expires, Date().addingTimeInterval(request.action == "authorize" ? min(25, request.timeout / 2) : request.timeout))
            var lastProbeError: Error?
            while Date() < deadline {
                if CGPreflightScreenCaptureAccess() {
                    do { return response(true, "usable", "Authorization was verified with a real stream.", try await Capture().probe()) }
                    catch { lastProbeError = error; break }
                }
                await deadlineSleep(0.25)
            }
            if request.action == "authorize" {
                return response(false, "restart_required", "Permission is not usable in this process yet; the CLI may restart this idle helper once.", ["permission": CGPreflightScreenCaptureAccess() ? "granted_but_unusable" : "not_granted", "probeError": lastProbeError.map { $0.localizedDescription } ?? NSNull()])
            }
            if let lastProbeError { throw lastProbeError }
            throw RecorderError("permission_not_granted", localized("Screen Recording permission is still not granted. Enable \(appName) at \(installedApp.path) in the opened Settings page, then retry authorize --interactive.", "屏幕录制权限仍未生效。请在已打开的系统设置中启用“\(appName)”（\(installedApp.path)），再运行 authorize --interactive。"))
        case "restart":
            guard capture == nil else { throw RecorderError("busy", "Cannot restart a recording helper.") }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { NSApp.terminate(nil) }
            return response(true, "restarting", "Idle helper will exit for a bounded permission refresh.")
        default: throw RecorderError("invalid_request", "Unknown command.")
        }
    }
}
