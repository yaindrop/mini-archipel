import Foundation
import AppKit
import ApplicationServices

func requireTest(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw InputFailure("test_failed", message) }
}
func expectFailure(_ code: String? = nil, _ body: () throws -> Void) throws {
    do { try body() } catch let e as InputFailure {
        if let code { try requireTest(e.code == code, "expected \(code), got \(e.code)") }
        return
    }
    throw InputFailure("test_failed", "expected rejection")
}
func decodeRequest(_ change: (inout [String:Any]) -> Void = { _ in }) throws -> NativeInputRequest {
    var r: [String:Any] = ["request_id":"negative-1","operation":"input","mode":"execute","timeout":15,
        "target":["pid":123,"bundle_id":"test.app","window_id":456,"frame":["x":-1400,"y":30,"width":1000,"height":800],"observed_at_ms":1000000],
        "coordinates":["space":"screen","unit":"points"],"action":["kind":"key","key":"a"]]
    change(&r)
    return try JSONDecoder().decode(NativeInputRequest.self,from:JSONSerialization.data(withJSONObject:r))
}
struct Event { let kind: String; let key: UInt16; let at: UInt64; let text: String? }
final class FakeIO {
    var now: UInt64 = 1_000_000_000
    var point = CGPoint(x:-1000,y:200)
    var events: [Event] = []
    var failKind: String?
    var failureBudget = 0
    var stall = false
    var refresh = true
    var stopAt: UInt64?
    var stopReason = "cancelled"
    var control: NativeInputControl!
    init() {
        var io = InputIO()
        io.now = { [unowned self] in now }
        io.pointer = { [unowned self] in point }
        io.sleep = { [unowned self] seconds in
            now += UInt64(max(1, seconds*1e9))
            if let stopAt, now >= stopAt { control.abort(stopReason) }
            else if refresh { control.refreshLease(now) }
        }
        io.post = { [unowned self] kind,p,_,_,code,_,text,_,_,time in
            if kind == failKind && failureBudget > 0 {
                failureBudget -= 1
                throw InputFailure("injected_post_failure", "injected failure without payload")
            }
            events.append(Event(kind:kind,key:code,at:time,text:text))
            if ["move","drag","down","up"].contains(kind) { point = p }
            if stall && kind == "move" { now += 30_000_000 }
        }
        control = NativeInputControl(io:io); control.refreshLease(now)
    }
    var released: Bool { (control.owned()["buttons"] as! [UInt32]).isEmpty && (control.owned()["keys"] as! [UInt16]).isEmpty }
}
final class FakeTarget: InputActionTarget {
    var hitAllowed: () -> Bool = { true }
    var checks = 0
    var failAfter = Int.max
    func convert(_ p: CGPoint) throws -> CGPoint { p }
    func verifyHit(_ p: CGPoint) throws { if !hitAllowed() { throw InputFailure("target_hit_failed", "control at pointer changed") } }
    func verify() throws { checks += 1; if checks >= failAfter { throw InputFailure("target_changed","target changed") } }
}
func act(_ v: [String:Any]) throws -> InputAction { try JSONDecoder().decode(InputAction.self,from:JSONSerialization.data(withJSONObject:v)) }
@main enum InputNegativeTests {
    static func main() throws {
        var passed = 0
        func test(_ name: String,_ body: () throws -> Void) throws { try body(); passed += 1; print("PASS \(name)") }
        try test("native rejects stale/future target and invalid budget") {
            for age in [120001.0,-2001.0] {
                let r = try decodeRequest { r in var t = r["target"] as! [String:Any]; t["observed_at_ms"] = 1000000-age; r["target"] = t }
                try expectFailure("stale_target") { try r.validate(nowMS:1000000) }
            }
            for timeout in [0,121] { try expectFailure { try decodeRequest { $0["timeout"] = timeout }.validate(nowMS:1000000) } }
            try expectFailure { try decodeRequest { $0["action"] = ["kind":"mouseHold","x":-1000,"y":200,"hold_seconds":14] }.validate(nowMS:1000000) }
        }
        try test("native rejects missing display, duplicate modifiers and main-modifier collision") {
            try expectFailure { try decodeRequest { $0["coordinates"] = ["space":"screen","unit":"pixels"] }.validate(nowMS:1000000) }
            for a: [String:Any] in [["kind":"key","key":"a","modifiers":["command","command"]],["kind":"key","key_code":55,"modifiers":["command"]],["kind":"move","x":-1000,"y":200,"modifiers":["shift"]]] {
                try expectFailure { try decodeRequest { $0["action"] = a }.validate(nowMS:1000000) }
            }
        }
        try test("timed paths reject duplicates and backwards time") {
            for t in [0.0,-1.0] {
                try expectFailure { try decodeRequest { $0["action"] = ["kind":"drag","points":[["t":0,"x":-1000,"y":200],["t":t,"x":-900,"y":250],["t":4,"x":-800,"y":300]]] }.validate(nowMS:1000000) }
            }
        }
        try test("late guard response cannot renew an expired validation") {
            let f = FakeIO(); _ = try f.control.buttonDown(f.point,button:.right,count:1)
            let began = f.now; f.now += 250_000_000; f.control.refreshLease(began)
            try expectFailure("input_stopped") { try f.control.move(f.point,drag:true) }
            try requireTest(f.events.map(\.kind) == ["down","up"] && f.released,"stale AX result permitted a new post")
            f.control.refreshLease(f.now)
            try requireTest(!f.control.active(),"closed request revived by fresh lease")
        }
        try test("failed key post cleans only owned chord") {
            let f = FakeIO(); try f.control.key(55,down:true,flags:.maskCommand)
            f.failKind = "keyDown"; f.failureBudget = 1
            try expectFailure("injected_post_failure") { try f.control.key(0,down:true,flags:.maskCommand) }
            try requireTest(f.events.filter { $0.kind == "keyUp" }.map(\.key) == [0,55] && f.released,"owned chord not released in reverse order")
            f.control.abort("finally"); try requireTest(f.events.filter { $0.kind == "keyUp" }.count == 2,"unowned key released")
        }
        try test("failed release retains ledger and prevents evidence success") {
            let f = FakeIO(); _ = try f.control.buttonDown(f.point,button:.center,count:1)
            f.failKind = "up"; f.failureBudget = 2; f.control.abort("cancelled")
            try requireTest(!f.released,"failed release erased owned ledger")
            let p = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try expectFailure("release_failed") { try f.control.flush(p) }
            try requireTest(!FileManager.default.fileExists(atPath:p.path),"unreleased state wrote successful log")
            f.control.abort("finally"); try requireTest(!f.released,"second failed release erased ledger")
            f.control.abort("finally"); try requireTest(f.released,"retry failed to release owned input")
        }
        try test("target-change stops Unicode stream and caller finally releases") {
            let f = FakeIO(), t = FakeTarget(); t.failAfter = 2
            try expectFailure("target_changed") { try performNativeInput(act(["kind":"text","text":"SECRET-😀-suffix","text_chunk_units":4]),control:f.control,target:t) }
            f.control.abort("input_failed")
            try requireTest(f.events.filter { $0.kind == "keyDown" }.count == 1 && f.released,"continued Unicode after target failure")
            let p = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at:p) }
            try f.control.flush(p); let log = try String(contentsOf:p,encoding:.utf8)
            try requireTest(!log.contains("SECR") && !log.contains("😀"),"log leaks text")
        }
        try test("STOP/hard timeout/foreground change release held button exactly once") {
            for why in ["input_hard_timeout","foreground_changed","input_stopped"] {
                let f = FakeIO(); f.stopReason = why; f.stopAt = f.now + 120_000_000
                try expectFailure("input_stopped") { try performNativeInput(act(["kind":"mouseHold","x":-1000,"y":200,"move_seconds":0,"settle_seconds":0,"hold_seconds":1]),control:f.control,target:FakeTarget()) }
                f.control.abort("finally")
                try requireTest(f.events.filter { $0.kind == "up" }.count == 1 && f.released && f.control.reason() == why,"stop release not balanced")
            }
        }
        try test("stalled post skips ticks rather than catching up") {
            let f = FakeIO(); f.stall = true
            try inputMove(f.control,from:f.point,to:CGPoint(x:-700,y:300),seconds:0.1,easing:"linear")
            let e = f.events.filter { $0.kind == "move" }
            try requireTest(e.count < 7 && zip(e,e.dropFirst()).allSatisfy { $1.at-$0.at >= 30_000_000 },"catch-up burst after delay")
            try requireTest(f.point == CGPoint(x:-700,y:300),"missed final endpoint")
        }
        try test("control changes during settle must not click") {
            let f = FakeIO(), t = FakeTarget(); let began = f.now
            t.hitAllowed = { f.now < began + 100_000_000 }
            try expectFailure("target_hit_failed") {
                try performNativeInput(act(["kind":"click","x":-1000,"y":200,"move_seconds":0,"settle_seconds":0.2]),control:f.control,target:t)
            }
            f.control.abort("finally")
            try requireTest(!f.events.contains { $0.kind == "down" },"wrong control was pressed")
        }
        print("PASS \(passed) independent negative groups; fake IO only, OS post disabled")
    }
}
