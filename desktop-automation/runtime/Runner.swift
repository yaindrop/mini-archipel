import AppKit
import ApplicationServices
import Carbon

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
    var terminationSource: DispatchSourceSignal?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let args = CommandLine.arguments
        guard args.count == 3, args[1] == "--request" else {
            NSApp.activate(ignoringOtherApps: true)
            let alert = NSAlert()
            alert.messageText = "Agent Script Runner"
            alert.informativeText = "通过 ~/agent-script-runner run 脚本路径 执行 AppleScript，或用 exec 程序路径 参数 执行其他脚本。首次授权请运行 ~/agent-script-runner authorize。"
            alert.runModal()
            NSApp.terminate(nil)
            return
        }
        requestURL = URL(fileURLWithPath: args[2])
        // A separate app instance owns each request, so cancellation cannot stop
        // another caller's AppleScript execution.
        signal(SIGTERM, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
        source.setEventHandler { [weak self] in
            if let child = self?.child, child.isRunning { child.terminate() }
            Darwin.exit(130)
        }
        source.resume()
        terminationSource = source
        DispatchQueue.main.async { self.execute() }
    }

    func finish(_ response: [String: Any]) {
        guard let requestURL else { NSApp.terminate(nil); return }
        do {
            let data = try JSONSerialization.data(withJSONObject: response, options: [.sortedKeys])
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
            case "authorize":
                let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
                let accessibility = AXIsProcessTrustedWithOptions(options)
                var error: NSDictionary?
                let script = NSAppleScript(source: "tell application \"System Events\" to get version")!
                _ = script.executeAndReturnError(&error)
                let automation = error == nil
                finish([
                    "ok": accessibility && automation,
                    "exit_code": accessibility && automation ? 0 : 1,
                    "accessibility": accessibility, "system_events_automation": automation,
                    "error": error?[NSAppleScript.errorMessage] as? String ?? ""
                ])
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

let app = NSApplication.shared
let delegate = Runner()
app.setActivationPolicy(.accessory)
app.delegate = delegate
app.run()
