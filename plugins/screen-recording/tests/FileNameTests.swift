import Foundation
@main struct FileNameTests {
    static func main() {
        let actual = FileManager.default.displayName(atPath: CommandLine.arguments[1])
        let expected = CommandLine.arguments[2]
        guard actual == expected else {
            print("FAIL: actual filesystem display name=\(actual), expected=\(expected), languages=\(Locale.preferredLanguages)")
            exit(1)
        }
        print("PASS: FileManager actual display name: \(actual)")
    }
}
