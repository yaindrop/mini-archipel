import Foundation
@main struct MediaTests {
    static func main() async throws {
        let args = CommandLine.arguments
        guard args.count == 4 else { fatalError("usage: media-tests source destination expected-seconds") }
        let source = URL(fileURLWithPath: args[1])
        let destination = URL(fileURLWithPath: args[2])
        let expected = Double(args[3])!
        do {
            _ = try await inspectMovie(source)
            fatalError("Regression input unexpectedly passed timeline validation")
        } catch let error as RecorderError {
            guard error.code == "invalid_media" else { throw error }
            print("PASS: incomplete source rejected: \(error.message)")
        }
        try await appendFrozenTail(source: source, destination: destination, seconds: 0, fps: 60, minimumDuration: expected)
        let info = try await inspectMovie(destination)
        guard abs(info.duration - expected) < 0.05, info.lastFrameSeconds >= expected - 0.05 else {
            fatalError("Normalized movie did not reach the expected end")
        }
        print("PASS: complete normalized timeline: \(info.json)")
    }
}
