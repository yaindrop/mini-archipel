import AppKit
import ApplicationServices
import Carbon

private func nativeInputNotification(_ observer: AXObserver,_ element: AXUIElement,_ notification: CFString,_ context: UnsafeMutableRawPointer?) {
    guard let context else { return }
    Unmanaged<NativeInputMonitor>.fromOpaque(context).takeUnretainedValue().invalidate("AX_notification:\(notification)")
}
final class NativeInputMonitor {
    let target: NativeInputTarget
    let control: NativeInputControl
    let stop: () -> Bool
    private let queue = DispatchQueue(label:"mini-archipel.automation.input.guard",qos:.userInitiated)
    private var timer: DispatchSourceTimer?
    private var observer: AXObserver?
    private var tokens: [NSObjectProtocol] = []
    init(target: NativeInputTarget, control: NativeInputControl, stop: @escaping () -> Bool) { self.target = target; self.control = control; self.stop = stop }
    func invalidate(_ reason: String) { control.abort(reason) }
    private func poll() {
        if control.reason() != "active" { return }
        let began = control.io.now()
        do {
            try inputRequire(!stop(),"Input cancelled or STOP active",code:"input_stopped")
            try inputRequire(AXIsProcessTrusted() && CGPreflightPostEventAccess(),"Input permission is unavailable; request it explicitly",code:"permission_required")
            try inputRequire(!IsSecureEventInputEnabled(),"Protected system input became active",code:"protected_target")
            try target.verify(); control.refreshLease(began)
            control.record(["event":"guard_checked","guard_duration_ns":control.io.now()-began])
        } catch { control.abort("guard_failed:\(error)") }
    }
    func start() throws {
        var created: AXObserver?
        let code = AXObserverCreate(target.application.processIdentifier,nativeInputNotification,&created)
        try inputRequire(code == .success && created != nil,"Cannot install target AX observer",code:"target_unavailable"); observer = created
        let context = Unmanaged.passUnretained(self).toOpaque()
        if target.request.target.title != nil { _ = AXObserverAddNotification(created!,target.window,kAXTitleChangedNotification as CFString,context) }
        for (element,name) in [(target.axApplication,kAXFocusedWindowChangedNotification),(target.axApplication,kAXApplicationDeactivatedNotification),(target.window,kAXMovedNotification),(target.window,kAXResizedNotification),(target.window,kAXUIElementDestroyedNotification)] {
            let status = AXObserverAddNotification(created!,element,name as CFString,context)
            control.record(["event":"observer_registration","notification":name,"status":status.rawValue])
        }
        DispatchQueue.main.sync {
            CFRunLoopAddSource(CFRunLoopGetMain(),AXObserverGetRunLoopSource(created!),.commonModes)
            let center = NSWorkspace.shared.notificationCenter
            tokens.append(center.addObserver(forName:NSWorkspace.didActivateApplicationNotification,object:nil,queue:.main) { [weak self] note in
                guard let self else { return }; let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
                if app?.processIdentifier != self.target.application.processIdentifier { self.invalidate("foreground_changed") }
            })
            for name in [NSWorkspace.willSleepNotification, NSWorkspace.sessionDidResignActiveNotification] { tokens.append(center.addObserver(forName:name,object:nil,queue:.main) { [weak self] _ in self?.invalidate("session_inactive_or_sleep") }) }
        }
        queue.sync { poll() }
        let timer = DispatchSource.makeTimerSource(queue:queue); timer.schedule(deadline:.now()+0.1,repeating:.milliseconds(100),leeway:.milliseconds(2)); timer.setEventHandler { [weak self] in self?.poll() }; self.timer = timer; timer.resume()
    }
    func stopMonitoring() {
        timer?.cancel(); timer = nil
        queue.sync {}
        DispatchQueue.main.sync {
            if let observer { CFRunLoopRemoveSource(CFRunLoopGetMain(),AXObserverGetRunLoopSource(observer),.commonModes) }
            let center = NSWorkspace.shared.notificationCenter; tokens.forEach { center.removeObserver($0) }; tokens.removeAll(); observer = nil
        }
    }
}
