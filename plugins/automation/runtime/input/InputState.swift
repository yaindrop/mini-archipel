import Foundation
import CoreGraphics

let inputModifierKeys: [(String,CGKeyCode,CGEventFlags)] = [("leftCommand",55,.maskCommand),("rightCommand",54,.maskCommand),("leftShift",56,.maskShift),("rightShift",60,.maskShift),("leftOption",58,.maskAlternate),("rightOption",61,.maskAlternate),("leftControl",59,.maskControl),("rightControl",62,.maskControl)]
func inputStateSnapshot() -> [String:Any] {
    let hid = CGEventSource.flagsState(.hidSystemState), combined = CGEventSource.flagsState(.combinedSessionState)
    var keys: [[String:Any]] = [], names: [String] = []
    for (name,code,_) in inputModifierKeys {
        let h = CGEventSource.keyState(.hidSystemState,key:code), c = CGEventSource.keyState(.combinedSessionState,key:code)
        keys.append(["name":name,"key_code":code,"hid_down":h,"combined_down":c])
        if h || c { names.append(name) }
    }
    let flags = [("command",CGEventFlags.maskCommand),("shift",.maskShift),("option",.maskAlternate),("control",.maskControl)].compactMap { name,flag in hid.contains(flag) || combined.contains(flag) ? name : nil }
    var snapshot: [String:Any] = ["modifier_flags":flags,"hid_flags":hid.rawValue,"combined_flags":combined.rawValue,"modifiers":keys,"unsafe_modifiers":names,"observer_pid":getpid(),"source":"aggregate HID/session state; includes posted events, not physical-owner attribution"]
    let url=FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/share/mini-archipel/desktop-automation/chat-input/last.json")
    if let size=(try? url.resourceValues(forKeys:[.fileSizeKey]))?.fileSize, size<8192, let data=try? Data(contentsOf:url), let recent=try? JSONSerialization.jsonObject(with:data) as? [String:Any] {
        snapshot["last_recorded_chat_action_not_state_owner"] = recent.filter { ["request_id","sender_pid","event_log","closed_reason","state_verified_neutral","end_hid_flags","end_combined_flags"].contains($0.key) }
    }
    return snapshot
}
func inputModifiersClear(_ state: [String:Any]) -> Bool { (state["unsafe_modifiers"] as? [String])?.isEmpty == true && (state["modifier_flags"] as? [String] ?? []).isEmpty }
