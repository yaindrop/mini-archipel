import AppKit
import ApplicationServices
import CoreGraphics
import Carbon

func inputAttr(_ e: AXUIElement, _ key: String) -> CFTypeRef? { var value: CFTypeRef?; return AXUIElementCopyAttributeValue(e,key as CFString,&value) == .success ? value : nil }
func inputAXFrame(_ e: AXUIElement) throws -> CGRect {
    guard let p = inputAttr(e,kAXPositionAttribute), let s = inputAttr(e,kAXSizeAttribute), CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { throw InputFailure("target_unavailable","AX window geometry unavailable") }
    var point = CGPoint.zero, size = CGSize.zero
    try inputRequire(AXValueGetValue(p as! AXValue,.cgPoint,&point) && AXValueGetValue(s as! AXValue,.cgSize,&size),"Invalid AX geometry")
    return CGRect(origin:point,size:size)
}
func inputSameFrame(_ a: CGRect,_ b: CGRect) -> Bool { abs(a.minX-b.minX)<1 && abs(a.minY-b.minY)<1 && abs(a.width-b.width)<1 && abs(a.height-b.height)<1 }
func inputWindowInfo(_ id: UInt32) -> [String:Any]? {
    (CGWindowListCopyWindowInfo([.optionIncludingWindow],id) as? [[String:Any]])?.first
}
func inputIncludeFocusedWindow(_ listed: [AXUIElement], _ focused: CFTypeRef?) -> [AXUIElement] {
    var result: [AXUIElement] = []
    var candidates = listed
    if let focused, CFGetTypeID(focused) == AXUIElementGetTypeID() { candidates.append(focused as! AXUIElement) }
    for element in candidates where !result.contains(where:{ CFEqual($0,element) }) { result.append(element) }
    return result
}
func inputMatchesHit(role: String, labels: [String], expectedRole: String?, expectedText: String?) -> Bool {
    (expectedRole == nil || role == expectedRole) && (expectedText == nil || labels.joined(separator:" ").contains(expectedText!))
}
func inputActivateTarget(timeout: Double, stop: () -> Bool, verify: () -> Bool, activate: () -> Bool, raise: () -> AXError, io: InputIO = InputIO()) throws -> [String:Any] {
    try inputRequire(!stop(),"Activation cancelled",code:"input_stopped")
    if verify() { try inputRequire(!stop(),"Activation cancelled",code:"input_stopped"); return ["already_focused":true,"application_activation_called":false,"focus_verified":true] }
    let began = io.now()
    try inputRequire(activate(),"Application activation was rejected",code:"activation_rejected")
    var report: [String:Any] = ["already_focused":false,"application_activation_called":true]
    if !verify() { report["ax_raise_status"] = raise().rawValue }
    let until = began+UInt64(min(2,timeout)*1e9)
    while io.now() < until {
        try inputRequire(!stop(),"Activation cancelled; already requested focus is not undone",code:"input_stopped")
        if verify() { try inputRequire(!stop(),"Activation cancelled",code:"input_stopped"); report["focus_verified"] = true; return report }
        io.sleep(0.02)
    }
    throw InputFailure("activation_unconfirmed","Activation did not yield the observed focused window (AXRaise \(report["ax_raise_status"] ?? "not needed")); inspect before retrying")
}
final class NativeInputTarget: InputActionTarget {
    let application: NSRunningApplication
    let axApplication: AXUIElement
    let window: AXUIElement
    let focus: AXUIElement
    let frame: CGRect
    let request: NativeInputRequest
    let scale: CGSize
    let origin: CGPoint
    private let launched: Date?
    private var typingFocus: AXUIElement?
    init(_ request: NativeInputRequest, allowInactive: Bool = false, stop: () -> Bool = { false }) throws {
        let observedFrame = request.target.frame.rect
        self.request = request; frame = observedFrame
        guard let app = NSRunningApplication(processIdentifier:request.target.pid), app.bundleIdentifier == request.target.bundle_id else { throw InputFailure("target_changed","Application PID/bundle identity differs") }
        application = app; launched = app.launchDate
        axApplication = AXUIElementCreateApplication(app.processIdentifier); AXUIElementSetMessagingTimeout(axApplication,0.025)
        let windows = inputIncludeFocusedWindow(inputAttr(axApplication,kAXWindowsAttribute) as? [AXUIElement] ?? [],inputAttr(axApplication,kAXFocusedWindowAttribute))
        var matches: [AXUIElement] = []
        for element in windows {
            try inputRequire(!stop(),"Input stopped while resolving the observed window",code:"input_stopped")
            AXUIElementSetMessagingTimeout(element,0.025)
            guard let observed = try? inputAXFrame(element), inputSameFrame(observed,observedFrame) else { continue }
            if request.target.title == nil || inputAttr(element,kAXTitleAttribute) as? String == request.target.title { matches.append(element) }
        }
        try inputRequire(matches.count == 1,"Observed AX window missing or ambiguous",code:"target_changed"); window = matches[0]
        if allowInactive { focus = window }
        else {
            guard let current = inputAttr(axApplication,kAXFocusedWindowAttribute), CFGetTypeID(current) == AXUIElementGetTypeID() else { throw InputFailure("target_unavailable","Focused native window is unavailable") }
            focus = current as! AXUIElement
            try inputRequire(CFEqual(focus,window),"The requested window is not focused",code:"target_changed")
        }
        AXUIElementSetMessagingTimeout(window,0.025); AXUIElementSetMessagingTimeout(focus,0.025)
        var backingScale = CGSize(width:1,height:1), coordinateOrigin = request.coordinates.space == "window" ? frame.origin : .zero
        if request.coordinates.unit == "pixels" {
            let display = request.coordinates.display_id!
            try inputRequire(CGDisplayIsActive(display) != 0,"Pixel display is not active",code:"invalid_coordinates")
            let bounds = CGDisplayBounds(display)
            if request.coordinates.space == "window" { try inputRequire(bounds.contains(frame),"Pixel coordinates require the complete window on the selected display; use points for a spanning window",code:"invalid_coordinates") }
            backingScale = CGSize(width:Double(CGDisplayPixelsWide(display))/bounds.width,height:Double(CGDisplayPixelsHigh(display))/bounds.height)
            if request.coordinates.space == "screen" { coordinateOrigin = bounds.origin }
        }
        try inputRequire(backingScale.width > 0 && backingScale.height > 0,"Invalid display backing scale")
        scale = backingScale; origin = coordinateOrigin
        try check(allowInactive:allowInactive)
        if let points = request.action.points { for p in points { _ = try convert(CGPoint(x:p.x,y:p.y)) } }
        if let x = request.action.x, let y = request.action.y { _ = try convert(CGPoint(x:x,y:y)) }
    }
    func convert(_ point: CGPoint) throws -> CGPoint {
        let result = inputConvertPoint(point,scale:scale,origin:origin)
        try inputRequire(point.x.isFinite && point.y.isFinite && frame.contains(result),"Action coordinates are outside the observed window",code:"invalid_coordinates")
        return result
    }
    func verify() throws { try check(allowInactive:false) }
    private func check(allowInactive: Bool) throws {
        try inputRequire(!application.isTerminated && application.launchDate == launched && (allowInactive || NSWorkspace.shared.frontmostApplication?.processIdentifier == application.processIdentifier),"Foreground application changed",code:"target_changed")
        guard let info = inputWindowInfo(request.target.window_id), let owner = info[kCGWindowOwnerPID as String] as? Int32, let bounds = info[kCGWindowBounds as String] as? NSDictionary, let actualFrame = CGRect(dictionaryRepresentation:bounds) else { throw InputFailure("target_changed","Window ID is no longer available") }
        try inputRequire(owner == application.processIdentifier && (allowInactive || (info[kCGWindowIsOnscreen as String] as? Bool) == true) && inputSameFrame(actualFrame,frame),"Window owner/visibility/frame changed",code:"target_changed")
        if !allowInactive {
            guard let focused = inputAttr(axApplication,kAXFocusedWindowAttribute) else { throw InputFailure("target_unavailable","Focused window query failed") }
            try inputRequire(CFEqual(focused,focus),"Focused window changed",code:"target_changed")
        }
        try inputRequire(inputSameFrame(try inputAXFrame(window),frame),"Window geometry changed",code:"target_changed")
        if let expected = typingFocus {
            guard let current = inputAttr(axApplication,kAXFocusedUIElementAttribute) else { throw InputFailure("target_not_editable","Typing focus is unavailable") }
            try inputRequire(CFEqual(current,expected),"Focused editable element changed",code:"target_changed")
        }
        if let title = request.target.title { try inputRequire(inputAttr(window,kAXTitleAttribute) as? String == title,"Observed window title changed",code:"target_changed") }
    }
    func activate(timeout: Double, stop: () -> Bool) throws -> [String:Any] {
        try inputActivateTarget(timeout:timeout,stop:stop,verify:{ (try? self.verify()) != nil },activate:{ DispatchQueue.main.sync { self.application.activate(options:[]) } },raise:{ AXUIElementPerformAction(self.window,kAXRaiseAction as CFString) })
    }
    func verifyHit(_ point: CGPoint) throws {
        var hit: AXUIElement?
        let code = AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(),Float(point.x),Float(point.y),&hit)
        guard code == .success, let element = hit else { throw InputFailure("target_hit_failed","Cannot verify the actual target under the pointer (AX \(code.rawValue))") }
        var pid: pid_t = 0; AXUIElementGetPid(element,&pid)
        try inputRequire(pid == application.processIdentifier,"Actual hit belongs to another application",code:"target_hit_failed")
        if request.target.hit_role != nil || request.target.hit_text != nil {
            let role = inputAttr(element,kAXRoleAttribute) as? String ?? ""
            var labels: [String] = [], node: AXUIElement? = element
            if request.target.hit_text != nil {
                for _ in 0..<4 {
                    guard let current = node else { break }
                    labels += [kAXTitleAttribute,kAXDescriptionAttribute,kAXValueAttribute].compactMap { inputAttr(current,$0) as? String }
                    if let parent = inputAttr(current,kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID() { node = (parent as! AXUIElement) } else { node = nil }
                }
            }
            try inputRequire(inputMatchesHit(role:role,labels:labels,expectedRole:request.target.hit_role,expectedText:request.target.hit_text),"Observed target control no longer matches",code:"target_hit_failed")
        }
    }
    func verifyTextFocus() throws {
        guard let value = inputAttr(axApplication,kAXFocusedUIElementAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { throw InputFailure("target_not_editable","No focused editable element") }
        let element = value as! AXUIElement
        typingFocus = element
        let role = inputAttr(element,kAXRoleAttribute) as? String ?? ""
        try inputRequire((inputAttr(element,kAXEnabledAttribute) as? Bool) != false && (inputAttr(element,"AXEditable") as? Bool) != false,"Focused target is disabled or read-only",code:"target_not_editable")
        var settable = DarwinBoolean(false)
        let code = AXUIElementIsAttributeSettable(element,kAXValueAttribute as CFString,&settable)
        try inputRequire(role != "AXSecureTextField" && (inputAttr(element,kAXSubroleAttribute) as? String) != "AXSecureTextField", "Secure text fields are not supported",code:"protected_target")
        try inputRequire(["AXTextField","AXTextArea","AXComboBox","AXSearchField"].contains(role) || (code == .success && settable.boolValue),"The actual focused element does not expose an editable value",code:"target_not_editable")
    }
    var summary: [String:Any] { ["pid":application.processIdentifier,"bundle_id":request.target.bundle_id,"window_id":request.target.window_id,"frame":[frame.minX,frame.minY,frame.width,frame.height],"coordinate_space":request.coordinates.space,"coordinate_unit":request.coordinates.unit,"scale_x":scale.width,"scale_y":scale.height] }
}

func nativeInputInfo() -> [String:Any] {
    let trusted = AXIsProcessTrusted(), post = CGPreflightPostEventAccess()
    var result: [String:Any] = ["ok":true,"exit_code":0,"protocol_version":1,"actions":NativeInputRequest.kinds,"modes":["preflight","execute"],"easing":["linear","smoothstep","smootherstep"],"permissions":["accessibility":trusted,"post_events":post],"target":NSNull(),"key_names":inputKeyCodes.keys.sorted(),"modifiers":inputModifierCodes.keys.sorted(),"coordinate_spaces":["screen","window"],"coordinate_units":["points","pixels"],"default_timeout":15,"max_timeout":120,"permission_requested":false,"secure_input_active":IsSecureEventInputEnabled(),"input_state":inputStateSnapshot()]
    var ids = [CGDirectDisplayID](repeating:0,count:32), count: UInt32 = 0
    if CGGetActiveDisplayList(32,&ids,&count) == .success {
        result["displays"] = ids.prefix(Int(count)).map { id -> [String:Any] in
            let f = CGDisplayBounds(id)
            return ["id":id,"frame":["x":f.minX,"y":f.minY,"width":f.width,"height":f.height],"pixel_width":CGDisplayPixelsWide(id),"pixel_height":CGDisplayPixelsHigh(id)]
        }
    }
    let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && $0.bundleIdentifier != nil && !$0.isTerminated }
    result["applications"] = apps.map { ["pid":$0.processIdentifier,"bundle_id":$0.bundleIdentifier!,"name":$0.localizedName ?? ""] as [String:Any] }
    let appIDs = Set(apps.map(\.processIdentifier))
    let all = CGWindowListCopyWindowInfo([.optionAll,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? []
    result["windows"] = all.prefix(1000).compactMap { info -> [String:Any]? in
        guard let pid = info[kCGWindowOwnerPID as String] as? Int32, appIDs.contains(pid), let app = apps.first(where: { $0.processIdentifier == pid }), let id = info[kCGWindowNumber as String] as? UInt32, let raw = info[kCGWindowBounds as String] as? NSDictionary, let f = CGRect(dictionaryRepresentation:raw), f.width > 0 && f.height > 0 else { return nil }
        return ["pid":pid,"bundle_id":app.bundleIdentifier!,"window_id":id,"frame":["x":f.minX,"y":f.minY,"width":f.width,"height":f.height],"observed_at_ms":Date().timeIntervalSince1970*1000]
    }
    if let url = Bundle.main.url(forResource:"input-protocol",withExtension:"json"), let data = try? Data(contentsOf:url), let schema = try? JSONSerialization.jsonObject(with:data) { result["request_schema"] = schema }
    guard trusted && post else { result["reason"] = "permission_required"; return result }
    guard let app = NSWorkspace.shared.frontmostApplication, let bundle = app.bundleIdentifier else { result["reason"] = "no_foreground_application"; return result }
    let ax = AXUIElementCreateApplication(app.processIdentifier); AXUIElementSetMessagingTimeout(ax,0.025)
    guard let value = inputAttr(ax,kAXFocusedWindowAttribute), CFGetTypeID(value) == AXUIElementGetTypeID(), let frame = try? inputAXFrame(value as! AXUIElement) else { result["reason"] = "focused_window_unavailable"; return result }
    let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? []
    let matches = infos.filter { item in
        guard (item[kCGWindowOwnerPID as String] as? Int32) == app.processIdentifier, let bounds = item[kCGWindowBounds as String] as? NSDictionary, let rect = CGRect(dictionaryRepresentation:bounds) else { return false }
        return inputSameFrame(rect,frame)
    }
    guard matches.count == 1, let id = matches[0][kCGWindowNumber as String] as? UInt32 else { result["reason"] = "focused_window_id_ambiguous"; return result }
    result["target"] = ["pid":app.processIdentifier,"bundle_id":bundle,"window_id":id,"frame":["x":frame.minX,"y":frame.minY,"width":frame.width,"height":frame.height],"observed_at_ms":Date().timeIntervalSince1970*1000]
    return result
}
