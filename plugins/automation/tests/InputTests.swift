import Foundation
import AppKit
import ApplicationServices

func check(_ value: @autoclosure () -> Bool, _ message: String) { if !value() { fatalError(message) } }
func action(_ value: [String:Any]) throws -> InputAction { try JSONDecoder().decode(InputAction.self,from:JSONSerialization.data(withJSONObject:value)) }
final class ClockInput {
    var now: UInt64 = 1_000_000_000
    var cursor = CGPoint(x:125,y:125)
    var events: [(String,CGPoint,Int64,UInt16,UInt64,String?,UInt64)] = []
    var scrolls: [(Int32,Int32)] = []
    var trackPointer = true
    var refresh = true
    var stopAt: UInt64?
    var control: NativeInputControl!
    init() {
        var io = InputIO()
        io.now = { [unowned self] in now }
        io.pointer = { [unowned self] in cursor }
        io.sleep = { [unowned self] seconds in
            now += UInt64(max(1,(seconds*1e9).rounded()))
            if let stopAt, now >= stopAt { control.abort("cancelled") }
            else if refresh { control.refreshLease(now) }
        }
        io.post = { [unowned self] kind,p,_,count,code,flags,text,dx,dy,time in
            events.append((kind,p,count,code,time,text,flags.rawValue))
            if kind == "scroll" { scrolls.append((dx,dy)) }
            if trackPointer && ["move","drag","down","up"].contains(kind) { cursor = p }
        }
        control = NativeInputControl(io:io); control.refreshLease(now)
    }
}
final class Target: InputActionTarget {
    var hitValid = true
    var frame = CGRect(x:100,y:100,width:800,height:600)
    func convert(_ p: CGPoint) throws -> CGPoint { try inputRequire(frame.contains(p),"outside",code:"invalid_coordinates"); return p }
    func verifyHit(_ p: CGPoint) throws { try inputRequire(hitValid,"other app",code:"target_hit_failed") }
    func verify() throws {}
}
@main enum InputTests {
    static func main() throws {
        check(inputMatchesHit(role:"AXButton",labels:["Save", "Document"],expectedRole:"AXButton",expectedText:"Save"),"fresh caller-provided hit expectation")
        check(!inputMatchesHit(role:"AXButton",labels:["Discard"],expectedRole:"AXButton",expectedText:"Save"),"wrong control text refuses")
        check(!inputMatchesHit(role:"AXTextArea",labels:["Save"],expectedRole:"AXButton",expectedText:"Save"),"wrong control role refuses")
        let target = Target()
        let fixture = ClockInput()
        try performNativeInput(action(["kind":"doubleClick","x":300,"y":300,"move_seconds":1]),control:fixture.control,target:target)
        let down = fixture.events.filter { $0.0 == "down" }, up = fixture.events.filter { $0.0 == "up" }
        check(down.count == 2 && up.count == 2,"double click lifecycle")
        check(down.map(\.2) == [1,2],"native click state is not two independent single clicks")
        check(up[0].4-down[0].4 >= 80_000_000,"real down held for 80ms")
        check(down[1].4-up[0].4 >= 120_000_000,"double-click interval")
        check(fixture.events.first!.1 != .zero && fixture.events.first!.1.x >= 125,"motion begins at the actual pointer")
        check(inputDistance(fixture.cursor,CGPoint(x:300,y:300)) < 2.5,"actual arrival")
        fixture.control.abort("completed")

        let drag = ClockInput()
        var points: [[String: Double]] = []
        for i in 0...5 { let n = Double(i); points.append(["t":n*0.8,"x":200+n*80,"y":200+n*40]) }
        try performNativeInput(action(["kind":"drag","points":points,"move_seconds":1]),control:drag.control,target:target)
        let moves = drag.events.filter { $0.0 == "drag" }
        check((238...241).contains(moves.count),"four-second drag stays near 240 actual dispatches")
        let start = drag.events.first { $0.0 == "down" }!.4, end = drag.events.first { $0.0 == "up" }!.4
        check(end-start >= 4_000_000_000 && end-start < 4_010_000_000,"four-second held duration")
        check(zip(moves,moves.dropFirst()).allSatisfy { $1.4-$0.4 >= 16_000_000 },"no catch-up burst dispatches")
        check(inputDistance(drag.cursor,CGPoint(x:600,y:400)) < 2.5,"drag endpoint")
        drag.control.abort("completed")

        let cancelled = ClockInput(); cancelled.stopAt = cancelled.now+2_000_000_000
        do { try performNativeInput(action(["kind":"drag","points":points]),control:cancelled.control,target:target); fatalError("cancel was ignored") } catch {}
        check(cancelled.events.filter { $0.0 == "down" }.count == 1 && cancelled.events.filter { $0.0 == "up" }.count == 1,"cancel releases only the owned mouse button once")
        cancelled.control.abort("finally")
        check(cancelled.events.filter { $0.0 == "up" }.count == 1,"finally cannot release an unowned button")

        let lease = ClockInput(); lease.refresh = false
        _ = try lease.control.buttonDown(lease.cursor,button:.left,count:1)
        lease.now += 181_000_000
        do { try lease.control.move(CGPoint(x:150,y:150),drag:true); fatalError("stale lease accepted") } catch {}
        check(lease.events.map(\.0) == ["down","up"],"expired lease releases before another drag post")
        check(lease.control.reason() == "validation_lease_expired","lease stop reason")

        let chord = ClockInput(); chord.stopAt = chord.now+4_000_000
        do { try performNativeInput(action(["kind":"key","key":"a","modifiers":["command","shift"]]),control:chord.control,target:target); fatalError("key cancellation ignored") } catch {}
        check(chord.events.filter { $0.0 == "keyUp" }.map(\.3) == [0,56,55],"reverse owned key cleanup")
        do { try chord.control.key(13,down:false,flags:[]); fatalError("unowned release accepted") } catch {}

        let failedArrival = ClockInput(); failedArrival.trackPointer = false
        do { try performNativeInput(action(["kind":"click","x":300,"y":300]),control:failedArrival.control,target:target); fatalError("failed actual arrival accepted") } catch {}
        check(!failedArrival.events.contains { $0.0 == "down" },"pointer arrival is actually read back before any press")
        let instant = ClockInput()
        try performNativeInput(action(["kind":"click","x":300,"y":300,"move_seconds":0,"settle_seconds":0]),control:instant.control,target:target)
        check(instant.events.filter { $0.0 == "move" }.count == 1,"explicit instant approach posts exactly one actual move")
        let wheel = ClockInput()
        try performNativeInput(action(["kind":"scroll","x":300,"y":300,"delta_x":-114,"delta_y":1007]),control:wheel.control,target:target)
        check(wheel.scrolls.reduce(0) { $0+Int($1.0) } == -114 && wheel.scrolls.reduce(0) { $0+Int($1.1) } == 1007,"bounded scroll preserves exact total pixel deltas")
        let right = try inputMakeEvent("down",CGPoint(x:10,y:20),.right,2,0,[],nil,0,0,123)
        check(right.type == .rightMouseDown && right.getIntegerValueField(.mouseEventClickState) == 2 && right.timestamp == 123,"real CGEvent right-click fields")
        let scroll = try inputMakeEvent("scroll",.zero,.left,0,0,[],nil,7,-99,124)
        check(scroll.type == .scrollWheel && scroll.getIntegerValueField(.scrollWheelEventPointDeltaAxis1) == -99,"real pixel scroll event fields")
        let key = try inputMakeEvent("keyDown",.zero,.left,0,36,[.maskCommand],nil,0,0,125)
        check(key.type == .keyDown && key.flags.contains(.maskCommand),"real key chord construction")
        do { try InputIO().post("move",.zero,.left,0,0,[],nil,0,0,126); fatalError("test guard allowed OS posting") } catch {}

        let unicode = String(repeating:"α😀e\u{301}",count:1000)
        let chunks = inputTextChunks(unicode,limit:20)
        check(chunks.joined() == unicode && chunks.allSatisfy { $0.utf16.count <= 20 },"long Unicode chunks preserve scalar boundaries")
        let text = ClockInput()
        try performNativeInput(action(["kind":"text","text":"Private-😀-value","text_chunk_units":20]),control:text.control,target:target)
        text.control.abort("completed")
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true)
        defer { try? FileManager.default.removeItem(at:folder) }
        let log = folder.appendingPathComponent("log.jsonl"); try text.control.flush(log)
        let raw = try String(contentsOf:log,encoding:.utf8)
        check(!raw.contains("Private") && !raw.contains("value") && !raw.contains("😀"),"input text is not logged")
        check(text.events.filter { $0.0 == "keyDown" }.compactMap(\.5).joined() == "Private-😀-value","actual emitted Unicode chunks")

        let longInput = ClockInput()
        try performNativeInput(action(["kind":"text","text":unicode,"text_chunk_units":20]),control:longInput.control,target:target)
        check(longInput.events.filter { $0.0 == "keyDown" }.compactMap(\.5).joined() == unicode,"long Unicode is actually dispatched through the same action path in bounded chunks")
        longInput.control.abort("completed")
        let transformed = inputConvertPoint(CGPoint(x:200,y:100),scale:CGSize(width:2,height:2),origin:CGPoint(x:-1440,y:30))
        check(transformed == CGPoint(x:-1340,y:80),"negative display origin and Retina coordinate conversion")
        let wrong = ClockInput()
        do { try performNativeInput(action(["kind":"click","x":99999,"y":99999]),control:wrong.control,target:target); fatalError("invalid coordinates accepted") } catch {}
        check(wrong.events.isEmpty,"invalid coordinates do not post")
        let blocked = ClockInput(); target.hitValid = false
        do { try performNativeInput(action(["kind":"click","x":300,"y":300]),control:blocked.control,target:target); fatalError("wrong hit accepted") } catch {}
        check(!blocked.events.contains { $0.0 == "down" },"target-hit failure cannot click")
        print("PASS: actual CGEvent construction (no post), smooth timing, 4s drag, cancellation, lease, owned release, Unicode redaction and coordinate errors; OS dispatch disabled")
    }
}
