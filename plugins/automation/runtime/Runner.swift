import AppKit
import ApplicationServices
import Carbon

let companionName = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "Mini Archipel Plugin: Automation"
func localized(_ english: String, _ chinese: String) -> String {
    (Bundle.main.preferredLocalizations.first ?? "en").hasPrefix("zh") ? chinese : english
}

struct Request: Decodable {
    let mode: String
    let path: String?
    let arguments: [String]
    let cwd: String
}

func jsonValue(_ value: NSAppleEventDescriptor) -> Any {
    switch value.descriptorType {
    case typeNull: return NSNull()
    case typeBoolean, typeTrue, typeFalse: return value.booleanValue
    case typeSInt16, typeSInt32: return Int(value.int32Value)
    case typeAEList:
        return (0..<value.numberOfItems).map { index -> Any in
            guard let item = value.atIndex(index + 1) else { return NSNull() }
            return jsonValue(item)
        }
    default: return value.stringValue ?? value.description
    }
}

final class Runner: NSObject, NSApplicationDelegate {
    var requestURL: URL?
    var child: Process?
    var inputSession: NativeInputSession?
    var terminationSources: [DispatchSourceSignal] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        let args = CommandLine.arguments
        guard args.count == 3, args[1] == "--request" else {
            NSApp.activate(ignoringOtherApps: true)
            let alert = NSAlert()
            alert.messageText = companionName
            alert.informativeText = localized("Use ~/agent-script-runner run SCRIPT or exec PROGRAM ARGS. Request only the needed permission with authorize --permission accessibility or automation.", "请用 ~/agent-script-runner run 脚本 或 exec 程序 参数 执行任务。授权时指定 authorize --permission accessibility 或 automation，仅请求所需权限。")
            alert.runModal()
            NSApp.terminate(nil)
            return
        }
        requestURL = URL(fileURLWithPath: args[2])
        // A separate app instance owns each request, so cancellation cannot stop
        // another caller's AppleScript execution.
        for number in [SIGTERM, SIGINT, SIGHUP] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
            source.setEventHandler { [weak self] in
                if let input = self?.inputSession { input.stop("termination_signal:\(number)"); return }
                if let child = self?.child, child.isRunning { child.terminate() }
                Darwin.exit(130)
            }
            source.resume()
            terminationSources.append(source)
        }
        DispatchQueue.main.async { self.execute() }
    }

    func finish(_ response: [String: Any]) {
        guard let requestURL else { NSApp.terminate(nil); return }
        do {
            var payload = response
            payload["app_name"] = companionName; payload["app_path"] = Bundle.main.bundleURL.path
            payload["bundle_id"] = Bundle.main.bundleIdentifier
            let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
            try data.write(to: requestURL.deletingLastPathComponent().appendingPathComponent("result.json"), options: .atomic)
        } catch {
            fputs("Could not write runner result: \(error)\n", stderr)
        }
        NSApp.terminate(nil)
    }

    func execute() {
        guard let requestURL else { return }
        let directory = requestURL.deletingLastPathComponent()
        do {
            try String(getpid()).write(to: directory.appendingPathComponent("pid"), atomically: true, encoding: .utf8)
            let request = try JSONDecoder().decode(Request.self, from: Data(contentsOf: requestURL))
            guard FileManager.default.changeCurrentDirectoryPath(request.cwd) else {
                finish(["ok": false, "exit_code": 1, "error": "Working directory does not exist: \(request.cwd)"])
                return
            }
            switch request.mode {
            case "applescript":
                guard let path = request.path else { throw CocoaError(.fileNoSuchFile) }
                var error: NSDictionary?
                guard let script = NSAppleScript(contentsOf: URL(fileURLWithPath: path), error: &error) else {
                    appleScriptFailure(error)
                    return
                }
                let arguments = NSAppleEventDescriptor.list()
                for (index, argument) in request.arguments.enumerated() {
                    arguments.insert(NSAppleEventDescriptor(string: argument), at: index + 1)
                }
                let event = NSAppleEventDescriptor(
                    eventClass: AEEventClass(kCoreEventClass), eventID: AEEventID(kAEOpenApplication),
                    targetDescriptor: nil, returnID: AEReturnID(kAutoGenerateReturnID),
                    transactionID: AETransactionID(kAnyTransactionID))
                event.setParam(arguments, forKeyword: AEKeyword(keyDirectObject))
                let result = script.executeAppleEvent(event, error: &error)
                guard error == nil else {
                    appleScriptFailure(error)
                    return
                }
                finish(["ok": true, "exit_code": 0, "result": jsonValue(result)])
            case "command":
                guard let path = request.path else { throw CocoaError(.fileNoSuchFile) }
                let stdoutURL = directory.appendingPathComponent("stdout")
                let stderrURL = directory.appendingPathComponent("stderr")
                FileManager.default.createFile(atPath: stdoutURL.path, contents: nil)
                FileManager.default.createFile(atPath: stderrURL.path, contents: nil)
                let output = try FileHandle(forWritingTo: stdoutURL)
                let errors = try FileHandle(forWritingTo: stderrURL)
                defer { try? output.close(); try? errors.close() }
                let process = Process()
                process.executableURL = URL(fileURLWithPath: path)
                process.arguments = request.arguments
                process.currentDirectoryURL = URL(fileURLWithPath: request.cwd)
                process.standardInput = FileHandle.nullDevice
                // Files avoid pipe deadlocks when a script produces large output.
                process.standardOutput = output
                process.standardError = errors
                child = process
                try process.run()
                process.waitUntilExit()
                finish([
                    "ok": process.terminationStatus == 0,
                    "exit_code": Int(process.terminationStatus),
                    "stdout": String(decoding: try Data(contentsOf: stdoutURL), as: UTF8.self),
                    "stderr": String(decoding: try Data(contentsOf: stderrURL), as: UTF8.self)
                ])
            case "input-info":
                DispatchQueue.global(qos: .userInitiated).async {
                    let value = nativeInputInfo()
                    DispatchQueue.main.async { self.finish(value) }
                }
            case "input":
                guard let path = request.path else { throw CocoaError(.fileNoSuchFile) }
                let session = NativeInputSession(); inputSession = session
                DispatchQueue.global(qos: .userInitiated).async {
                    let result = session.run(jobURL: URL(fileURLWithPath: path))
                    DispatchQueue.main.async { self.finish(result) }
                }
            case "authorize":
                let permission = request.arguments.first ?? "all"
                guard ["all", "accessibility", "automation"].contains(permission) else { throw CocoaError(.validationMissingMandatoryProperty) }
                var accessibility = AXIsProcessTrusted()
                var automation: Any = NSNull()
                var error: NSDictionary?
                if permission != "automation" {
                    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
                    accessibility = AXIsProcessTrustedWithOptions(options)
                    if !accessibility { NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!) }
                }
                if permission != "accessibility" {
                    // Version queries are exempt from consent; process enumeration requests real access.
                    let script = NSAppleScript(source: "tell application \"System Events\" to count application processes")!
                    _ = script.executeAndReturnError(&error)
                    automation = error == nil
                    if error != nil { NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation")!) }
                }
                let allowed = permission == "accessibility" ? accessibility : (permission == "automation" ? error == nil : accessibility && error == nil)
                finish(["ok": allowed, "exit_code": allowed ? 0 : 1,
                    "accessibility": accessibility, "system_events_automation": automation,
                    "requested_permission": permission, "error": error?[NSAppleScript.errorMessage] as? String ?? ""])
            default:
                finish(["ok": false, "exit_code": 1, "error": "Unknown request mode"])
            }
        } catch {
            finish(["ok": false, "exit_code": 1, "error": error.localizedDescription])
        }
    }

    func appleScriptFailure(_ error: NSDictionary?) {
        finish([
            "ok": false, "exit_code": 1,
            "error": error?[NSAppleScript.errorMessage] as? String ?? "AppleScript execution failed",
            "apple_script_error": error?[NSAppleScript.errorNumber] as? Int ?? 0
        ])
    }
}

@main enum RunnerMain {
    static func main() throws {
        if CommandLine.arguments.dropFirst().first == "--identity" {
            let value: [String: Any] = ["ok": true, "app_name": companionName,
                "app_path": Bundle.main.bundlePath,
                "bundle_id": Bundle.main.bundleIdentifier ?? "",
                "file_display_name": FileManager.default.displayName(atPath: Bundle.main.bundlePath)]
            let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([10]))
            exit(0)
        }

        let app = NSApplication.shared
        let delegate = Runner()
        app.setActivationPolicy(.accessory)
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
