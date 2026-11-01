import Foundation
import AppKit
import Darwin

let usage = """
Mini Archipel Plugin: Screen Recorder — macOS 15+; local, screen-only; optional independent mouse-event sidecar.

  agent-screen-recorder doctor [--timeout 15] [--json]
  agent-screen-recorder authorize --interactive [--timeout 120] [--json]
  agent-screen-recorder displays [--json]
  agent-screen-recorder windows [--json]
  agent-screen-recorder start --output /path/new.mp4 [--display ID | --window ID] [--fps 60]
      [--duration SECONDS] [--tail SECONDS] [--exclude-app BUNDLE_ID]...
      [--exclude-window ID]... [--timeout 15] [--json]
      [--pointer-output /path/new.pointer.json --pointer-source native]
  agent-screen-recorder snapshot --output /path/new.snapshot.png [--json]
  agent-screen-recorder status [--json]
  agent-screen-recorder stop [--timeout 120] [--json]
  agent-screen-recorder pointer-doctor
  agent-screen-recorder pointer-authorize --interactive
  agent-screen-recorder pointer-event --session UUID --event JSON
  agent-screen-recorder pointer-import --video /path/movie.mp4 --input /path/log.json --output /path/new.pointer.json
  agent-screen-recorder identity
  agent-screen-recorder self-test-media --output /path/new.mp4

start returns ready only after writer-start AND a complete screen frame.
stop/status completed means finalized, positive-duration, decodable MP4.
--duration automatically stops; --tail freezes the final real frame after capture.
Outputs are never overwritten. JSON is always written to stdout; failures exit 1.
An idle helper exits automatically. Timed recordings survive the calling CLI.
Permission belongs to: ~/Applications/Mini Archipel Plugin - Screen Recorder.app
"""
func parseArguments(_ args: [String]) throws -> Request {
    guard let action = args.first else { throw RecorderError("invalid_argument", usage) }
    let valid = ["snapshot", "doctor", "authorize", "displays", "windows", "start", "status", "stop", "identity", "self-test-media", "pointer-doctor", "pointer-authorize", "pointer-event", "pointer-import"]
    guard valid.contains(action) else { throw RecorderError("invalid_argument", "Unknown command. Use --help.") }
    var request = Request(action: action)
    request.timeout = action == "authorize" || action == "stop" ? 120 : 15
    var index = 1; var interactive = false
    while index < args.count {
        let key = args[index]
        if key == "--json" { index += 1; continue }
        if key == "--interactive" { interactive = true; index += 1; continue }
        guard index + 1 < args.count else { throw RecorderError("invalid_argument", "Missing value for \(key).") }
        let value = args[index + 1]
        switch key {
        case "--input": request.input = (value as NSString).expandingTildeInPath
        case "--video": request.video = (value as NSString).expandingTildeInPath
        case "--pointer-output": request.pointerOutput = (value as NSString).expandingTildeInPath
        case "--pointer-source":
            guard ["native", "external-authorized"].contains(value) else { throw RecorderError("invalid_argument", "pointer-source must be native or external-authorized.") }
            request.pointerSource = value
        case "--session": request.pointerSession = value
        case "--event":
            do { request.pointerEvent = try JSONDecoder().decode(PointerInput.self, from: Data(value.utf8)); try request.pointerEvent!.validate() }
            catch { throw RecorderError("invalid_pointer_event", "--event requires {hostTimeSeconds,kind,x,y,button} JSON with valid mouse fields.") }
        case "--output": request.output = (value as NSString).expandingTildeInPath
        case "--display": guard let id = UInt32(value), id > 0 else { throw RecorderError("invalid_argument", "Invalid display ID.") }; request.display = id
        case "--window": guard let id = UInt32(value), id > 0 else { throw RecorderError("invalid_argument", "Invalid window ID.") }; request.window = id
        case "--fps": guard let fps = Int(value), (1...120).contains(fps) else { throw RecorderError("invalid_argument", "fps must be 1...120.") }; request.fps = fps
        case "--duration": guard let n = Double(value), n.isFinite, n > 0, n <= 86400 else { throw RecorderError("invalid_argument", "duration must be >0 and <=86400 seconds.") }; request.duration = n
        case "--tail": guard let n = Double(value), n.isFinite, n >= 0, n <= 30 else { throw RecorderError("invalid_argument", "tail must be 0...30 seconds.") }; request.tail = n
        case "--timeout": guard let n = Double(value), n.isFinite, n >= 1, n <= 600 else { throw RecorderError("invalid_argument", "timeout must be 1...600 seconds.") }; request.timeout = n
        case "--exclude-app": request.excludedApps.append(value)
        case "--exclude-window": guard let id = UInt32(value), id > 0 else { throw RecorderError("invalid_argument", "Invalid window ID.") }; request.excludedWindows.append(id)
        default: throw RecorderError("invalid_argument", "Unknown option \(key).")
        }
        index += 2
    }
    guard !["authorize", "pointer-authorize"].contains(action) || interactive else { throw RecorderError("interactive_required", "Authorization requires --interactive. doctor never opens a system prompt or Settings.") }
    guard action != "start" && action != "self-test-media" && action != "snapshot" || request.output != nil else { throw RecorderError("invalid_argument", "--output is required.") }
    guard request.window == nil || (request.display == nil && request.excludedApps.isEmpty && request.excludedWindows.isEmpty) else { throw RecorderError("invalid_argument", "--window cannot be combined with --display or exclusion options.") }
    guard (request.pointerOutput == nil) == (request.pointerSource == nil),
          request.pointerOutput == nil || action == "start" else {
        throw RecorderError("invalid_argument", "start requires both --pointer-output and --pointer-source to opt into mouse events.")
    }
    guard action != "start" || request.pointerSource != "external-authorized" else {
        throw RecorderError("external_pointer_unavailable", "Online external pointer capture is disabled because actual button events were not reliably preserved. Use native capture, or pointer-import with an independently verified real event log.")
    }
    guard action != "pointer-event" || (request.pointerEvent != nil && request.pointerSession != nil) else {
        throw RecorderError("invalid_argument", "pointer-event requires --session and --event.")
    }
    guard action != "pointer-import" || (request.input != nil && request.video != nil && request.output != nil) else {
        throw RecorderError("invalid_argument", "pointer-import requires --input, --video and --output.")
    }
    if let path = request.output { request.output = URL(fileURLWithPath: path).standardizedFileURL.path }
    request.expires = Date().addingTimeInterval(request.timeout)
    return request
}
@MainActor func launchHelper() async throws {
    guard geteuid() != 0 else { throw RecorderError("gui_user_required", "Run as the logged-in desktop user, not root.") }
    guard let bundle = Bundle(url: installedApp), bundle.bundleIdentifier == bundleID else {
        throw RecorderError("not_installed", "Run scripts/install.sh first. Expected \(installedApp.path).")
    }
    let config = NSWorkspace.OpenConfiguration(); config.activates = false
    do { _ = try await NSWorkspace.shared.openApplication(at: installedApp, configuration: config) }
    catch { throw RecorderError("helper_unavailable", "LaunchServices could not start the GUI helper: \(error.localizedDescription)") }
}
@MainActor func exchange(_ request: Request) async throws -> [String: Any] {
    try prepareSupport()
    let requestURL = supportRoot.appendingPathComponent("requests/\(request.id).request")
    let responseURL = supportRoot.appendingPathComponent("responses/\(request.id).json")
    let data = try JSONEncoder().encode(request)
    try data.write(to: requestURL, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: requestURL.path)
    do { try await launchHelper() } catch { try? FileManager.default.removeItem(at: requestURL); throw error }
    while Date() < request.expires {
        if let data = try? Data(contentsOf: responseURL), let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
            try? FileManager.default.removeItem(at: responseURL)
            return result
        }
        await deadlineSleep()
    }
    try? FileManager.default.removeItem(at: requestURL)
    throw RecorderError("command_timeout", "The helper did not answer before the deadline. Check status; a timed-out start must not be assumed successful.")
}
@MainActor func runCLI(_ arguments: [String]) async -> Int32 {
    do {
        if arguments.isEmpty || arguments == ["--help"] || arguments == ["help"] { print(usage); return 0 }
        var request = try parseArguments(arguments)
        if request.action == "identity" {
            emit(response(true, "identity", "Stable GUI helper identity.", ["installed": FileManager.default.fileExists(atPath: installedApp.path), "stateDirectory": supportRoot.path])); return 0
        }
        if request.action == "pointer-import" { emit(try await importPointerLog(input: request.input!, video: request.video!, output: request.output!)); return 0 }
        if request.action == "self-test-media" { emit(try await syntheticMovie(request.output!)); return 0 }
        if request.action == "authorize" {
            FileHandle.standardError.write(Data((localized("Authorize \(appName) (\(bundleID)) at \(installedApp.path). Only the system can grant access.", "请在系统设置中授权“\(appName)”（\(bundleID)），应用路径：\(installedApp.path)。权限只能由系统与您确认。") + "\n").utf8))
        }
        let finalDeadline = request.expires
        var result = try await exchange(request)
        if request.action == "authorize", result["code"] as? String == "restart_required", finalDeadline.timeIntervalSinceNow > 3 {
            var restart = Request(action: "restart"); restart.expires = Date().addingTimeInterval(5)
            let restartResult = try await exchange(restart)
            guard restartResult["ok"] as? Bool == true else { emit(restartResult); return 1 }
            await deadlineSleep(0.8)
            request = Request(action: "authorize-check"); request.expires = finalDeadline; request.timeout = max(1, finalDeadline.timeIntervalSinceNow)
            result = try await exchange(request)
            result["helperRestarts"] = 1
        }
        emit(result)
        return result["ok"] as? Bool == true ? 0 : 1
    } catch { emit(errorResponse(error)); return 1 }
}
