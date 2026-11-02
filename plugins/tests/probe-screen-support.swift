// Isolated reproduction of Protocol.prepareSupport; never touches an installed App.
import Foundation
import Darwin
let fm = FileManager.default
let root = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
try fm.createDirectory(at: root, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: root) }
let real = root.appendingPathComponent("real")
let alias = root.appendingPathComponent("alias")
try fm.createDirectory(at: real, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
try fm.createSymbolicLink(at: alias, withDestinationURL: real)
for url in [real, alias] {
    try fm.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let attrs = try fm.attributesOfItem(atPath: url.path)
    let accepted = attrs[.type] as? FileAttributeType == .typeDirectory && (attrs[.ownerAccountID] as? NSNumber)?.uint32Value == geteuid()
    print(url.lastPathComponent, accepted ? "accepted" : "unsafe_state_directory")
    precondition(accepted == (url == real))
}
