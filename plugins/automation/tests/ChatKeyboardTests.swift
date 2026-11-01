import Foundation
import CoreGraphics
func demand(_ value:Bool,_ message:String) { precondition(value,message) }
@main enum ChatKeyboardTests {
 static func main() throws {
  if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--signal-child" {
   let folder=URL(fileURLWithPath:CommandLine.arguments[2]); var held=false
   var keyboard:ChatKeyboard!; var io=InputIO()
   io.post={ kind,_,_,_,code,_,_,_,_,_ in
    if code==55 { held = kind=="keyDown" }
    if kind=="keyDown" && code==55 {
     FileManager.default.createFile(atPath:folder.appendingPathComponent("held").path,contents:Data())
     let end=Date().addingTimeInterval(2)
     while !keyboard.isCancelled() && Date()<end { Thread.sleep(forTimeInterval:0.002) }
    }
   }
   keyboard=ChatKeyboard(io:io,state:{ ["unsafe_modifiers":held ? ["leftCommand"] : []] },keyHeld:{ _ in false },directory:folder)
   keyboard.configure("signal-owned");keyboard.installSignals()
   try? keyboard.key(9,command:true)
   Thread.sleep(forTimeInterval:2)
   preconditionFailure("signal handler did not terminate")
  }
  let root=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  defer { try? FileManager.default.removeItem(at:root) }
  var held=false, posted:[(String,UInt16,UInt64)]=[], fail=false
  var io=InputIO()
  io.post={ kind,_,_,_,code,flags,_,_,_,_ in
   posted.append((kind,code,flags.rawValue))
   if code==55 { held = kind=="keyDown" }
   if fail && code==9 && kind=="keyDown" { fail=false;throw InputFailure("injected_failure","test") }
  }
  let state={ ["unsafe_modifiers":held ? ["leftCommand"] : [],"hid_flags":held ? CGEventFlags.maskCommand.rawValue : 0,"combined_flags":held ? CGEventFlags.maskCommand.rawValue : 0] as [String:Any] }
  let keyboard=ChatKeyboard(io:io,state:state,keyHeld:{ _ in false },directory:root)
  keyboard.configure("owned-chat-123")
  try keyboard.key(9,command:true)
  demand(posted.map{ $0.1 } == [55,9,9,55],"real modifier lifecycle is explicit and owned")
  demand(posted.last!.2 == 0 && !held,"command cannot remain set after own key-up")
  let report=keyboard.summary().last!
  demand(report["request_id"] as? String == "owned-chat-123","correlated request ID")
  let owned=report["owned"] as! [String:Any]
  demand((owned["keys"] as! [UInt16]).isEmpty,"owned keys released before receipt")
  let log=try String(contentsOf:URL(fileURLWithPath:report["event_log"] as! String),encoding:.utf8)
  demand(log.contains("sender_pid") && log.contains("owned-chat-123"),"sender provenance retained without text")
  posted=[];held=true
  do { try keyboard.key(9,command:true);preconditionFailure("external held modifier accepted") } catch {}
  demand(posted.isEmpty && held,"external key is never released or overwritten")
  held=false;posted=[];fail=true
  do { try keyboard.key(9,command:true);preconditionFailure("post error ignored") } catch {}
  demand(posted.filter{ $0.0=="keyUp" }.map{ $0.1 } == [9,55] && !held,"failure releases only the owned pair in reverse order")
  posted=[];keyboard.cancel("test_cancel")
  do { try keyboard.key(9,command:true);preconditionFailure("cancel ignored") } catch {}
  demand(posted.isEmpty,"cancel cannot press or release an unowned key")
  let event=try inputMakeEvent("keyUp",.zero,.left,0,55,[],nil,0,0,1)
  demand(event.flags.intersection([.maskCommand,.maskShift,.maskAlternate,.maskControl]).isEmpty,"constructed terminal modifier event is neutral")
  let signalFolder=root.appendingPathComponent("signal");try FileManager.default.createDirectory(at:signalFolder,withIntermediateDirectories:true)
  let child=Process();child.executableURL=URL(fileURLWithPath:CommandLine.arguments[0]);child.arguments=["--signal-child",signalFolder.path]
  try child.run()
  let deadline=Date().addingTimeInterval(3)
  while !FileManager.default.fileExists(atPath:signalFolder.appendingPathComponent("held").path) && Date()<deadline { Thread.sleep(forTimeInterval:0.005) }
  demand(FileManager.default.fileExists(atPath:signalFolder.appendingPathComponent("held").path),"signal child never owned key")
  child.terminate();child.waitUntilExit()
  demand(child.terminationStatus==130,"signal child did not use cooperative cancellation")
  let signalLog=try String(contentsOf:signalFolder.appendingPathComponent("signal-owned-0.jsonl"),encoding:.utf8)
  demand(signalLog.contains("signal:15") && signalLog.contains("\"owned_key_count\":0"),"signal cleanup receipt missing")
  print("PASS chat keyboard: explicit owned chord, neutral finish, post-failure reverse cleanup, external-held refusal, cancel, correlated PID/ID receipt; no OS dispatch")
 }
}
