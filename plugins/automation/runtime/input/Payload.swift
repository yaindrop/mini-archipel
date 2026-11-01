import Foundation
import CoreGraphics

struct InputFailure: Error, CustomStringConvertible {
    let code: String
    let description: String
    init(_ code: String, _ message: String) { self.code = code; description = message }
}
func inputRequire(_ value: Bool, _ message: String, code: String = "invalid_input") throws {
    if !value { throw InputFailure(code, message) }
}
struct InputFrame: Codable {
    let x: Double; let y: Double; let width: Double; let height: Double
    var rect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
}
struct InputPoint: Codable { let t: Double; let x: Double; let y: Double }
struct InputTargetSpec: Codable {
    let bundle_id: String
    let pid: Int32
    let window_id: UInt32
    let frame: InputFrame
    let observed_at_ms: Double
    let title: String?
    let hit_text: String?
    let hit_role: String?
}
struct InputCoordinates: Codable {
    let space: String
    let unit: String
    let display_id: UInt32?
}
struct InputAction: Codable {
    let kind: String
    let x: Double?; let y: Double?
    let move_seconds: Double?; let settle_seconds: Double?; let hold_seconds: Double?
    let points: [InputPoint]?
    let duration: Double?
    let easing: String?
    let button: String?
    let delta_x: Int32?; let delta_y: Int32?
    let text: String?
    let text_chunk_units: Int?
    let key: String?; let key_code: UInt16?
    let modifiers: [String]?
}
struct NativeInputRequest: Codable {
    let request_id: String
    let operation: String
    let mode: String
    let target: InputTargetSpec
    let coordinates: InputCoordinates
    let action: InputAction
    let timeout: Int?
    static let kinds = ["activate", "move", "click", "doubleClick", "middleClick", "rightClick", "mouseHold", "drag", "scroll", "key", "text"]
    func validate(nowMS: Double = Date().timeIntervalSince1970 * 1000) throws {
        try inputRequire(operation == "input" && ["preflight", "execute"].contains(mode), "Explicit input preflight/execute mode required")
        try inputRequire(request_id.range(of: "^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$", options: .regularExpression) != nil, "Invalid request ID")
        try inputRequire(target.pid > 0 && target.window_id > 0 && target.bundle_id.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$", options: .regularExpression) != nil, "Explicit app bundle, PID and window ID required")
        let f = target.frame
        try inputRequire([f.x, f.y, f.width, f.height, target.observed_at_ms].allSatisfy { $0.isFinite } && [f.x,f.y,f.width,f.height].allSatisfy { abs($0) <= 100000 } && f.width > 0 && f.height > 0, "Invalid observed window frame")
        try inputRequire((target.title?.utf16.count ?? 0) <= 1000,"Invalid observed window title")
        try inputRequire(target.observed_at_ms > 0 && target.observed_at_ms <= nowMS + 2000 && nowMS - target.observed_at_ms <= 120000, "Target observation is stale; inspect the current window", code: "stale_target")
        try inputRequire(["screen", "window"].contains(coordinates.space) && ["points", "pixels"].contains(coordinates.unit), "Coordinates require screen/window space and points/pixels unit")
        try inputRequire(coordinates.unit != "pixels" || (coordinates.display_id ?? 0) > 0, "Pixel coordinates require an actual display ID")
        try inputRequire((1...120).contains(timeout ?? 15), "Input timeout must be 1–120 seconds")
        let a = action
        if let text = target.hit_text { try inputRequire(!text.isEmpty && text.utf16.count <= 1000,"Invalid observed hit text") }
        if let role = target.hit_role { try inputRequire(!role.isEmpty && role.utf16.count <= 100,"Invalid observed hit role") }
        try inputRequire((target.hit_text == nil && target.hit_role == nil) || ["move","click","doubleClick","middleClick","rightClick","mouseHold","drag","scroll"].contains(a.kind),"Hit expectations require an explicit pointer action")
        try inputRequire(Self.kinds.contains(a.kind), "Unsupported input action")
        for (v, lo, hi) in [(a.move_seconds ?? 1, 0, 30.0), (a.settle_seconds ?? 0.2, 0, 5.0), (a.hold_seconds ?? 0.08, 0.01, 60.0)] {
            try inputRequire(v.isFinite && v >= lo && v <= hi, "Invalid motion, settle or hold duration")
        }
        try inputRequire(["linear", "smoothstep", "smootherstep"].contains(a.easing ?? "smoothstep"), "Unsupported easing")
        try inputRequire(["left", "right", "middle"].contains(a.button ?? "left"), "Unsupported mouse button")
        let mods = a.modifiers ?? []
        try inputRequire(mods.count <= 4 && Set(mods).count == mods.count && mods.allSatisfy { inputModifierCodes[$0] != nil }, "Invalid modifier chord")
        if a.kind == "move" || a.kind == "text" { try inputRequire(mods.isEmpty, "Move-only and Unicode text cannot hold modifiers") }
        if ["move", "click", "doubleClick", "middleClick", "rightClick", "mouseHold", "scroll"].contains(a.kind) {
            try inputRequire(a.x?.isFinite == true && a.y?.isFinite == true && abs(a.x!) <= 100000 && abs(a.y!) <= 100000, "Finite target coordinates required")
        }
        if a.kind == "drag" {
            guard let points = a.points else { throw InputFailure("invalid_input", "A timed drag path is required") }
            try inputRequire((2...1000).contains(points.count) && points.first?.t == 0 && (0.1...60).contains(points.last?.t ?? 0), "Drag path requires 2–1000 points spanning 0.1–60 seconds")
            for (i, p) in points.enumerated() {
                try inputRequire([p.t, p.x, p.y].allSatisfy { $0.isFinite } && abs(p.x) <= 100000 && abs(p.y) <= 100000 && (i == 0 || p.t > points[i-1].t), "Drag path times must strictly increase")
            }
        }
        if a.kind == "scroll" {
            try inputRequire(abs(Int64(a.delta_x ?? 0)) <= 10000 && abs(Int64(a.delta_y ?? 0)) <= 10000 && ((a.delta_x ?? 0) != 0 || (a.delta_y ?? 0) != 0), "Nonzero bounded pixel scroll delta required")
            try inputRequire((a.duration ?? 0.5).isFinite && (0.05...60).contains(a.duration ?? 0.5), "Scroll duration must be 0.05–60 seconds")
        }
        if a.kind == "key" {
            try inputRequire((a.key != nil) != (a.key_code != nil), "Specify one key name or virtual key code")
            try inputRequire(a.key.map { inputKeyCodes[$0] != nil } ?? ((a.key_code ?? 128) <= 127), "Unsupported virtual key")
            try inputRequire(!mods.contains(where: { inputModifierCodes[$0] == a.key_code }), "Main key must differ from modifiers")
        }
        if let chunk = a.text_chunk_units { try inputRequire((1...20).contains(chunk), "Unicode chunk size must be 1–20 units") }
        if a.kind == "text" { try inputRequire(!(a.text ?? "").isEmpty && (a.text?.utf16.count ?? 0) <= 16000, "Unicode text must contain 1–16000 UTF-16 units") }
        var estimated = ["move","click","doubleClick","middleClick","rightClick","mouseHold","drag","scroll"].contains(a.kind) ? (a.move_seconds ?? 1)+(a.settle_seconds ?? 0.2) : 0
        if a.kind == "drag" { estimated += a.points!.last!.t }
        if a.kind == "scroll" { estimated += a.duration ?? 0.5 }
        if a.kind == "key" { estimated += a.hold_seconds ?? 0.06 }
        if ["click","middleClick","rightClick","mouseHold"].contains(a.kind) { estimated += a.hold_seconds ?? (a.kind == "mouseHold" ? 1 : 0.08) }
        if a.kind == "doubleClick" { estimated += 2*(a.hold_seconds ?? 0.08)+0.12 }
        if a.kind == "text" { estimated += Double(inputTextChunks(a.text!,limit:a.text_chunk_units ?? 1).count)*0.06 }
        try inputRequire(estimated+0.25 < Double(timeout ?? 15), "Action exceeds its timeout; use a bounded longer timeout or explicit text chunks")
    }
}
func inputTextChunks(_ text: String, limit: Int) -> [String] {
    var result: [String] = [], part = ""
    for scalar in text.unicodeScalars {
        let next = String(scalar)
        if !part.isEmpty && part.utf16.count+next.utf16.count > limit { result.append(part); part = "" }
        part += next
    }
    if !part.isEmpty { result.append(part) }
    return result
}
let inputModifierCodes: [String: UInt16] = ["command": 55, "shift": 56, "option": 58, "control": 59]
let inputKeyCodes: [String: UInt16] = ["a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"equal":24,"9":25,"7":26,"minus":27,"8":28,"0":29,"rightBracket":30,"o":31,"u":32,"leftBracket":33,"i":34,"p":35,"Return":36,"l":37,"j":38,"quote":39,"k":40,"semicolon":41,"backslash":42,"comma":43,"slash":44,"n":45,"m":46,"period":47,"Tab":48,"space":49,"grave":50,"delete":51,"Escape":53,"F1":122,"F2":120,"F3":99,"F4":118,"F5":96,"F6":97,"F7":98,"F8":100,"F9":101,"F10":109,"F11":103,"F12":111,"Home":115,"End":119,"PageUp":116,"PageDown":121,"ForwardDelete":117,"Left":123,"Right":124,"Down":125,"Up":126]
func inputEase(_ progress: Double, _ name: String) -> Double {
    let x = max(0, min(1, progress))
    if name == "linear" { return x }
    if name == "smootherstep" { return x*x*x*(10+x*(-15+6*x)) }
    return x*x*(3-2*x)
}
func inputConvertPoint(_ p: CGPoint, scale: CGSize, origin: CGPoint) -> CGPoint {
    CGPoint(x: origin.x + p.x / scale.width, y: origin.y + p.y / scale.height)
}
