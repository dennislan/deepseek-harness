import SwiftUI
import AppKit

@main
struct DeepSeekHarnessApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    // Use @State instead of @StateObject for actor; observe via notification
    @State private var server = DshServer()
    @State private var bridge = BridgeManager()

    var body: some Scene {
        WindowGroup {
            ContentView(server: server, bridge: bridge)
                .onAppear {
                    AppDelegate.terminateDsh = { DshServer.activeTerminator?() }
                    Task { await server.start() }
                }
                .onDisappear {
                    Task { await server.stop() }
                }
                .frame(minWidth: 960, minHeight: 640)
        }
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandGroup(after: .appInfo) {
                Button("重新加载") {
                    bridge.webView?.reload()
                }
                .keyboardShortcut("r", modifiers: [.command])
            }
        }
    }
}

/// Stops the dsh child on normal quit. Window close is handled by
/// ContentView.onDisappear; without this hook Cmd+Q would leave dsh running
/// (orphaned) and the next launch would fail with EADDRINUSE.
final class AppDelegate: NSObject, NSApplicationDelegate {
    static var terminateDsh: (() -> Void)?

    func applicationWillTerminate(_ notification: Notification) {
        Self.terminateDsh?()
    }
}
