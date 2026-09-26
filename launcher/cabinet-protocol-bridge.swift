import AppKit
import Carbon
import Foundation

@MainActor
final class CabinetProtocolBridge: NSObject, NSApplicationDelegate {
    private var supervisor: Process?
    private var input: Pipe?
    private var pendingURLs: [String] = []

    func applicationWillFinishLaunching(_ notification: Notification) {
        NSAppleEventManager.shared().setEventHandler(
            self,
            andSelector: #selector(handleURL(_:withReplyEvent:)),
            forEventClass: AEEventClass(kInternetEventClass),
            andEventID: AEEventID(kAEGetURL)
        )
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let executable = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/CabinetSupervisor")
        let process = Process()
        let pipe = Pipe()
        process.executableURL = executable
        process.standardInput = pipe
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        var environment = ProcessInfo.processInfo.environment
        environment["CABINET_LAUNCHER_DETACHED"] = "1"
        environment["CABINET_PROTOCOL_BRIDGE"] = "1"
        process.environment = environment
        process.terminationHandler = { _ in
            DispatchQueue.main.async { NSApplication.shared.terminate(nil) }
        }
        do {
            try process.run()
            supervisor = process
            input = pipe
            flushURLs()
        } catch {
            NSAlert(error: error).runModal()
            NSApplication.shared.terminate(nil)
        }
    }

    @objc private func handleURL(_ event: NSAppleEventDescriptor, withReplyEvent reply: NSAppleEventDescriptor) {
        guard let raw = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue,
              let url = URL(string: raw), url.scheme == "cabinet", url.host == "new",
              raw.utf8.count <= 8 * 1024 * 1024 else { return }
        pendingURLs.append(raw)
        flushURLs()
    }

    private func flushURLs() {
        guard let input else { return }
        while !pendingURLs.isEmpty {
            let raw = pendingURLs[0]
            guard let data = try? JSONSerialization.data(withJSONObject: ["uri": raw]),
                  let newline = "\n".data(using: .utf8) else {
                pendingURLs.removeFirst()
                continue
            }
            do {
                try input.fileHandleForWriting.write(contentsOf: data + newline)
                pendingURLs.removeFirst()
            } catch {
                break
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        if supervisor?.isRunning == true { supervisor?.terminate() }
    }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let bridge = CabinetProtocolBridge()
    app.setActivationPolicy(.prohibited)
    app.delegate = bridge
    app.run()
}
