import Foundation
import CoreGraphics
import Darwin

final class ChatKeyboard {
    let io: InputIO
    let state: () -> [String:Any]
    let keyHeld: (CGKeyCode) -> Bool
    let directory: URL
    var requestID = UUID().uuidString
    private let lock = NSLock()
    private var current: (NativeInputControl,URL)?
    private var cancelled = false
    private var records: [[String:Any]] = []
    private var sequence = 0
    private var sources: [DispatchSourceSignal] = []
    init(io: InputIO = InputIO(), state: @escaping () -> [String:Any] = inputStateSnapshot, keyHeld: @escaping (CGKeyCode) -> Bool = { CGEventSource.keyState(.combinedSessionState,key:$0) }, directory: URL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/share/mini-archipel/desktop-automation/chat-input")) {
        self.io = io; self.state = state; self.keyHeld = keyHeld; self.directory = directory
    }
    func configure(_ id: String?) { if let id, id.range(of:"^[A-Za-z0-9_-]{1,100}$",options:.regularExpression) != nil { requestID = id } }
    func isCancelled() -> Bool { lock.lock(); defer { lock.unlock() }; return cancelled }
    func summary() -> [[String:Any]] { lock.lock(); defer { lock.unlock() }; return records }
    func checkIdle() throws {
        let snapshot = state()
        try inputRequire(inputModifiersClear(snapshot),"Existing modifier state; no keys released; inspect input_cleanup",code:"input_busy")
    }
    func finish(_ control: NativeInputControl, reason: String) {
        lock.lock()
        guard let active = current, active.0 === control else { lock.unlock(); return }
        current = nil; lock.unlock()
        control.abort(reason)
        let after = state()
        var record: [String:Any] = ["state_verified_neutral":inputModifiersClear(after),"request_id":requestID,"sender_pid":getpid(),"closed_reason":control.reason(),"owned":control.owned(),"after":after,"event_log":active.1.path]
        control.record(["event":"chat_key_cleanup","request_id":requestID,"sender_pid":getpid(),"owned":control.owned(),"after":after,"reason":control.reason()])
        do { try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700]); try control.flush(active.1)
            let recent: [String:Any] = ["request_id":requestID,"sender_pid":getpid(),"event_log":active.1.path,"closed_reason":control.reason(),"state_verified_neutral":inputModifiersClear(after),"end_hid_flags":after["hid_flags"] ?? 0,"end_combined_flags":after["combined_flags"] ?? 0]
            try JSONSerialization.data(withJSONObject:recent,options:[.sortedKeys]).write(to:directory.appendingPathComponent("last.json"),options:.atomic)
        }
        catch { record["evidence_error"] = String(describing:error) }
        lock.lock(); records.append(record); lock.unlock()
    }
    func cancel(_ reason: String) { lock.lock(); cancelled = true; let active = current?.0; lock.unlock(); if let active { finish(active,reason:reason) } }
    func installSignals() {
        for number in [SIGTERM,SIGINT,SIGHUP] {
            signal(number,SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal:number,queue:.global())
            source.setEventHandler { self.cancel("signal:\(number)"); Darwin.exit(130) }
            source.resume(); sources.append(source)
        }
    }
    func key(_ code: CGKeyCode, command: Bool = false) throws {
        let before = state(), control = NativeInputControl(io:io)
        lock.lock(); let stopped = cancelled
        let path = directory.appendingPathComponent("\(requestID)-\(sequence).jsonl"); sequence += 1
        current = (control,path); lock.unlock()
        var complete = false
        defer { finish(control,reason:complete ? "chat_key_complete" : "chat_key_failed") }
        control.record(["event":"chat_key_begin","request_id":requestID,"sender_pid":getpid(),"before":before,"shortcut_code":code,"command":command])
        try inputRequire(!stopped && inputModifiersClear(before) && !keyHeld(code),"Existing key/modifier state; nothing released; inspect input_cleanup",code:"input_busy")
        control.refreshLease(io.now())
        if command { try control.key(55,down:true,flags:.maskCommand) }
        try control.key(code,down:true,flags:command ? .maskCommand : [])
        try control.key(code,down:false,flags:command ? .maskCommand : [])
        if command { try control.key(55,down:false,flags:[]) }
        let until = io.now()+100_000_000
        while !inputModifiersClear(state()) && io.now() < until { io.sleep(0.005) }
        try inputRequire(inputModifiersClear(state()),"Chat shortcut ended with non-neutral state; no external key released",code:"input_cleanup_unconfirmed")
        complete = true
    }
}
