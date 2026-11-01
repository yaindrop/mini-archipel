import AppKit
import Foundation

@main struct Main {
    static func main() {
        let args = Array(CommandLine.arguments.dropFirst())
        if args.first == "--cli" {
            Task { @MainActor in exit(await runCLI(Array(args.dropFirst()))) }
            RunLoop.main.run()
        } else {
            let application = NSApplication.shared
            let service = Service()
            application.setActivationPolicy(.accessory)
            application.delegate = service
            application.run()
            withExtendedLifetime(service) {}
        }
    }
}
