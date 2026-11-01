import AppKit
import ApplicationServices
import Darwin
import Carbon

func inputFlags(_ names: [String]) -> CGEventFlags {
    var flags = CGEventFlags()
    for name in names { flags.insert(name == "command" ? .maskCommand : name == "shift" ? .maskShift : name == "option" ? .maskAlternate : .maskControl) }
    return flags
}
final class NativeInputSession {
    let control = NativeInputControl()
    func stop(_ reason: String) { control.abort(reason) }
    func run(jobURL: URL) -> [String:Any] {
        let root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/share/mini-archipel/desktop-automation")
        let fm = FileManager.default
        var directory: URL?, monitor: NativeInputMonitor?, hard: DispatchSourceTimer?, dragDeadline: DispatchSourceTimer?
        var lockFD: Int32 = -1
        var result: [String:Any] = ["ok":false,"exit_code":1,"code":"input_refused","events_may_have_been_posted":false,"gui_effect_verified":false]
        defer { if lockFD >= 0 { Darwin.close(lockFD) } }
        do {
            let input = try Data(contentsOf:jobURL)
            try inputRequire(input.count <= 300000,"Input job exceeds limit")
            guard let envelope = try JSONSerialization.jsonObject(with:input) as? [String:Any], let value = envelope["request"] else { throw InputFailure("invalid_input","Expected a durable input job") }
            let request = try JSONDecoder().decode(NativeInputRequest.self,from:JSONSerialization.data(withJSONObject:value)); try request.validate()
            try inputRequire(jobURL.standardizedFileURL.deletingLastPathComponent() == root.standardizedFileURL && jobURL.lastPathComponent == request.request_id+".json","Input must use the existing durable job store")
            try fm.createDirectory(at:root.appendingPathComponent("input"),withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
            let run = root.appendingPathComponent("input/"+request.request_id)
            try inputRequire(mkdir(run.path,0o700) == 0,"This input request has already been claimed; inspect its receipt instead of replaying",code:"input_already_dispatched"); directory = run
            lockFD = Darwin.open(NSHomeDirectory()+"/.agent-chat-native.lock",O_CREAT|O_RDWR|O_NOFOLLOW,0o600)
            try inputRequire(lockFD >= 0 && flock(lockFD,LOCK_EX|LOCK_NB) == 0,"Another native desktop action is active",code:"input_busy")
            let stop = { self.control.reason() != "active" || (request.mode == "execute" && fm.fileExists(atPath:root.appendingPathComponent("INPUT_STOP").path)) || fm.fileExists(atPath:jobURL.deletingPathExtension().appendingPathExtension("cancel").path) }
            try inputRequire(!stop(),"Input STOP/cancellation is active",code:"input_stopped")
            let timeout = DispatchSource.makeTimerSource(queue:DispatchQueue.global(qos:.userInteractive)); timeout.schedule(deadline:.now()+Double(request.timeout ?? 15)); timeout.setEventHandler { self.control.abort("input_hard_timeout") }; hard = timeout; timeout.resume()
            try inputRequire(AXIsProcessTrusted() && CGPreflightPostEventAccess(),"Native input needs existing Automation Accessibility permission; request it explicitly",code:"permission_required")
            try inputRequire(!IsSecureEventInputEnabled(),"Protected system input is active",code:"protected_target")
            let target = try NativeInputTarget(request,allowInactive:request.action.kind == "activate",stop:stop), a = request.action
            if a.kind == "text" { try target.verifyTextFocus() }
            let point: CGPoint? = a.kind == "drag" ? try target.convert(CGPoint(x:a.points!.first!.x,y:a.points!.first!.y)) : a.x != nil ? try target.convert(CGPoint(x:a.x!,y:a.y!)) : nil
            if let point { try target.verifyHit(point) }
            try inputRequire(!stop(),"Input stopped during target validation",code:"input_stopped")
            control.record(["event":"preflight_passed","target":target.summary,"action":a.kind,"mode":request.mode,"actual_start_x":inputPointer().x,"actual_start_y":inputPointer().y,"permission_requested":false])
            result["target"] = target.summary; result["target_verified"] = true
            if request.mode == "preflight" {
                result.merge(["ok":true,"exit_code":0,"code":"input_preflight","events_may_have_been_posted":false]) { _, new in new }
            } else if a.kind == "activate" {
                control.record(["event":"activation_requested","target":target.summary])
                result["activation_requested"] = true; result["activation_verified"] = false; result["ui_side_effects_may_have_occurred"] = true
                let activation = try target.activate(timeout:Double(request.timeout ?? 15),stop:stop)
                result["activation"] = activation; result["ui_side_effects_may_have_occurred"] = activation["application_activation_called"]; control.record(["event":"activation_verified","activation":activation])
                result.merge(["ok":true,"exit_code":0,"code":"input_activated","activation_verified":true,"events_may_have_been_posted":false]) { _, new in new }
            } else {
                for b in [CGMouseButton.left,.right,.center] { try inputRequire(!CGEventSource.buttonState(.combinedSessionState,button:b),"Physical mouse button is already held; nothing released",code:"input_busy") }
                try inputRequire(CGEventSource.flagsState(.combinedSessionState).intersection([.maskCommand,.maskShift,.maskAlternate,.maskControl]).isEmpty,"Physical modifier is already held; nothing released",code:"input_busy")
                if a.kind == "key" { try inputRequire(!CGEventSource.keyState(.combinedSessionState,key:a.key_code ?? inputKeyCodes[a.key!]!),"Physical target key is already held",code:"input_busy") }
                if a.kind == "text" { try inputRequire(!CGEventSource.keyState(.combinedSessionState,key:0),"Physical Unicode carrier key is already held",code:"input_busy") }
                let watcher = NativeInputMonitor(target:target,control:control,stop:stop); monitor = watcher; try watcher.start()
                try inputRequire(control.active(),"No fresh input validation lease",code:"input_stopped")
                result["events_may_have_been_posted"] = true
                let started = inputMonotonicNS(); result["started_host_ns"] = started
                try performNativeInput(a,control:control,target:target,onDragStart:{ down,seconds in
                    let deadline = DispatchSource.makeTimerSource(queue:DispatchQueue.global(qos:.userInteractive))
                    deadline.schedule(deadline:DispatchTime(uptimeNanoseconds:down+UInt64(seconds*1e9)+50_000_000))
                    deadline.setEventHandler { self.control.abort("drag_release_deadline") }
                    dragDeadline = deadline; deadline.resume()
                },onDragEnd:{ dragDeadline?.cancel(); dragDeadline = nil })
                try inputRequire(control.active(),"Input stopped before completion",code:"input_stopped")
                result.merge(["ok":true,"exit_code":0,"code":"input_posted","ended_host_ns":inputMonotonicNS(),"actual_pointer_x":inputPointer().x,"actual_pointer_y":inputPointer().y]) { _, new in new }
            }
        } catch {
            let failure = error as? InputFailure
            result["code"] = failure?.code ?? "input_failed"; result["error"] = String(describing:error)
        }
        hard?.cancel(); dragDeadline?.cancel(); control.abort(result["ok"] as? Bool == true ? "completed" : "input_failed")
        monitor?.stopMonitoring()
        result["closed_reason"] = control.reason(); result["owned_input_at_exit"] = control.owned()
        if let directory {
            do {
                let log = directory.appendingPathComponent("events.jsonl"); try control.flush(log); result["event_log"] = log.path
                let saved = directory.appendingPathComponent("result.json"); try JSONSerialization.data(withJSONObject:result,options:[.sortedKeys]).write(to:saved,options:.atomic); try fm.setAttributes([.posixPermissions:0o600],ofItemAtPath:saved.path)
            } catch { result["ok"] = false; result["exit_code"] = 1; result["code"] = "input_evidence_failed"; result["error"] = String(describing:error) }
        }
        return result
    }
}
