import Foundation
import Darwin

let appDisplayNameEnglish = "Mini Archipel Plugin: Screen Recorder"
let appFileName = "Mini Archipel Plugin - Screen Recorder"
let appName = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? appDisplayNameEnglish
func localized(_ english: String, _ chinese: String) -> String {
    let language = Bundle.main.preferredLocalizations.first ?? Locale.preferredLanguages.first ?? "en"
    return language.hasPrefix("zh") ? chinese : english
}
let bundleID = "org.agent-screen-recorder.app"
let installedApp = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications/\(appFileName).app")
#if TESTING
let supportRoot = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("test-results/isolated-state")
#else
let supportRoot = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Agent Screen Recorder")
#endif

struct RecorderError: Error {
    let code: String
    let message: String
    init(_ code: String, _ message: String) { self.code = code; self.message = message }
}
struct Request: Codable {
    var id = UUID().uuidString
    var action: String
    var output: String? = nil
    var display: UInt32? = nil
    var window: UInt32? = nil
    var input: String? = nil
    var video: String? = nil
    var pointerOutput: String? = nil
    var pointerSource: String? = nil
    var pointerEvent: PointerInput? = nil
    var pointerSession: String? = nil
    var fps = 60
    var duration: Double? = nil
    var tail = 0.0
    var excludedApps: [String] = []
    var excludedWindows: [UInt32] = []
    var timeout = 15.0
    var expires = Date().addingTimeInterval(30)
}
func response(_ ok: Bool, _ code: String, _ message: String, _ details: [String: Any] = [:]) -> [String: Any] {
    var value: [String: Any] = ["schemaVersion": 1, "ok": ok, "code": code, "message": message,
        "appName": appName, "bundleID": bundleID, "appPath": installedApp.path]
    for (key, item) in details { value[key] = item }
    return value
}
func errorResponse(_ error: Error) -> [String: Any] {
    if let error = error as? RecorderError { return response(false, error.code, error.message) }
    let e = error as NSError
    return response(false, "operation_failed", e.localizedDescription, ["errorDomain": e.domain, "errorNumber": e.code])
}
func jsonData(_ value: [String: Any]) throws -> Data {
    try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
}
func emit(_ value: [String: Any]) {
    if let data = try? jsonData(value) { FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10])) }
}
func prepareSupport() throws {
    let fm = FileManager.default
    for url in [supportRoot, supportRoot.appendingPathComponent("requests"), supportRoot.appendingPathComponent("responses")] {
        try fm.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let attrs = try fm.attributesOfItem(atPath: url.path)
        guard attrs[.type] as? FileAttributeType == .typeDirectory,
              (attrs[.ownerAccountID] as? NSNumber)?.uint32Value == geteuid() else {
            throw RecorderError("unsafe_state_directory", "State directory must be a real directory owned by the current user.")
        }
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
    }
}
func writeJSON(_ value: [String: Any], to url: URL) throws {
    try jsonData(value).write(to: url, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
}
func deadlineSleep(_ seconds: Double = 0.05) async { try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }

final class OutputReservation {
    let url: URL
    let partial: URL
    private let fd: Int32
    private var original = stat()
    private var committed = false
    init(path: String, fileExtension: String = "mp4") throws {
        url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath).standardizedFileURL
        guard url.pathExtension.lowercased() == fileExtension else { throw RecorderError("invalid_output", "Output must end in .\(fileExtension).") }
        fd = open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else {
            throw RecorderError(errno == EEXIST ? "output_exists" : "write_failed", "Cannot reserve output: \(String(cString: strerror(errno))).")
        }
        guard fstat(fd, &original) == 0 else { close(fd); throw RecorderError("write_failed", "Cannot inspect output reservation.") }
        partial = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).partial.\(fileExtension)")
    }
    private func stillOwned() -> Bool {
        var current = stat()
        return lstat(url.path, &current) == 0 && current.st_ino == original.st_ino && current.st_dev == original.st_dev && current.st_size == 0
    }
    func commit(_ source: URL) throws {
        guard stillOwned() else { throw RecorderError("output_changed", "Reserved output was replaced; refusing to overwrite it.") }
        guard rename(source.path, url.path) == 0 else { throw RecorderError("write_failed", "Cannot finalize output: \(String(cString: strerror(errno))).") }
        committed = true
    }
    deinit {
        if !committed && stillOwned() { unlink(url.path) }
        close(fd)
    }
}

func claimRequest(_ file: URL) throws -> URL {
    let claimed = file.deletingPathExtension().appendingPathExtension("active")
    do { try FileManager.default.moveItem(at: file, to: claimed) }
    catch { throw RecorderError("request_claim_failed", "Cannot claim request without replay: \(error.localizedDescription)") }
    return claimed
}
func recoverClaimedRequests() throws {
    let folder = supportRoot.appendingPathComponent("requests")
    for file in try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil) where file.pathExtension == "active" {
        guard let data = try? Data(contentsOf: file), data.count <= 65536,
              let request = try? JSONDecoder().decode(Request.self, from: data),
              UUID(uuidString: request.id) != nil, request.id == file.deletingPathExtension().lastPathComponent else { continue }
        try writeJSON(response(false, "operation_interrupted", "The previous helper stopped after accepting this request. It will not be replayed; inspect status before explicitly retrying.",
            ["requestID": request.id, "action": request.action]), to: supportRoot.appendingPathComponent("responses/\(request.id).json"))
        try FileManager.default.removeItem(at: file)
    }
}
