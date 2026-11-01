import AppKit
import ApplicationServices

protocol InputActionTarget {
    func convert(_ point: CGPoint) throws -> CGPoint
    func verifyHit(_ point: CGPoint) throws
    func verify() throws
}
func performNativeInput(_ a: InputAction, control: NativeInputControl, target: InputActionTarget, onDragStart: (UInt64, Double) -> Void = { _, _ in }, onDragEnd: () -> Void = {}) throws {
    let point: CGPoint? = a.kind == "drag" ? try target.convert(CGPoint(x:a.points!.first!.x,y:a.points!.first!.y)) : a.x != nil ? try target.convert(CGPoint(x:a.x!,y:a.y!)) : nil
    let easing = a.easing ?? "smoothstep"
    if let point { try inputMove(control,from:control.io.pointer(),to:point,seconds:a.move_seconds ?? 1,easing:easing); try target.verifyHit(point); try inputPause(a.settle_seconds ?? 0.2,control); try target.verify(); try target.verifyHit(point) }
    let modifiers = a.modifiers ?? [], flags = inputFlags(modifiers)
    var pressingFlags = CGEventFlags()
    for name in modifiers { pressingFlags.insert(inputFlags([name])); try control.key(inputModifierCodes[name]!,down:true,flags:pressingFlags) }
    if ["click","doubleClick","middleClick","rightClick","mouseHold"].contains(a.kind) {
        let b: CGMouseButton = a.kind == "middleClick" ? .center : a.kind == "rightClick" ? .right : a.button == "middle" ? .center : a.button == "right" ? .right : .left
        for click in 1...(a.kind == "doubleClick" ? 2 : 1) {
            _ = try control.buttonDown(point!,button:b,count:Int64(click),flags:flags)
            try inputPause(a.hold_seconds ?? (a.kind == "mouseHold" ? 1 : 0.08),control)
            try control.buttonUp(count:Int64(click),flags:flags)
            if a.kind == "doubleClick" && click == 1 { try inputPause(0.12,control) }
        }
    } else if a.kind == "drag" {
        let points = a.points!, seconds = points.last!.t, b: CGMouseButton = a.button == "right" ? .right : a.button == "middle" ? .center : .left
        let down = try control.buttonDown(point!,button:b,count:1,flags:flags)
        onDragStart(down,seconds)
        try inputMove(control,from:point!,to:target.convert(CGPoint(x:points.last!.x,y:points.last!.y)),seconds:seconds,easing:easing,path:points,convert:target.convert,drag:true,flags:flags)
        try control.buttonUp(flags:flags); onDragEnd()
    } else if a.kind == "scroll" {
        let seconds = a.duration ?? 0.5, count = max(1,Int((seconds*60).rounded())), begin = control.io.now(); var x: Int32 = 0, y: Int32 = 0
        for i in 1...count {
            let u = inputEase(Double(i)/Double(count),easing), nx = Int32((Double(a.delta_x ?? 0)*u).rounded()), ny = Int32((Double(a.delta_y ?? 0)*u).rounded())
            if nx != x || ny != y { try control.scroll(x:nx-x,y:ny-y,flags:flags) }; x = nx; y = ny
            let next = begin+UInt64(Double(i)/Double(count)*seconds*1e9), now = control.io.now(); if next > now { try inputPause(Double(next-now)/1e9,control) }
        }
    } else if a.kind == "key" {
        let code = a.key_code ?? inputKeyCodes[a.key!]!
        try control.key(code,down:true,flags:flags); try inputPause(a.hold_seconds ?? 0.06,control); try control.key(code,down:false,flags:flags)
    } else if a.kind == "text" {
        for character in inputTextChunks(a.text!,limit:a.text_chunk_units ?? 1) {
            try target.verify(); try control.key(0,down:true,flags:[],text:character); try inputPause(0.025,control); try control.key(0,down:false,flags:[],text:character); try inputPause(0.035,control)
        }
    }
    var releasingFlags = flags
    for name in modifiers.reversed() { releasingFlags.remove(inputFlags([name])); try control.key(inputModifierCodes[name]!,down:false,flags:releasingFlags) }
}
