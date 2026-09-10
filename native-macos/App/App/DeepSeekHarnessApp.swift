import SwiftUI
import AppKit

@main
struct DeepSeekHarnessApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    // Use @State instead of @StateObject for actor; observe via notification
    @State private var server = DshServer()
    @State private var bridge = BridgeManager()
    @State private var updater = RuntimeUpdater()

    var body: some Scene {
        WindowGroup {
            ContentView(server: server, bridge: bridge, updater: updater)
                .onAppear {
                    AppDelegate.terminateDsh = { DshServer.activeTerminator?() }
                    Task { await server.start() }
                    // Runs alongside startup rather than after it: a slow or
                    // unreachable network must not delay dsh booting.
                    Task { await updater.checkOnLaunch(server: server) }
                }
                .onDisappear {
                    Task { await server.stop() }
                }
                .frame(minWidth: 960, minHeight: 640)
        }
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandGroup(replacing: .appInfo) {
                // The default item reports the shell's build-time version; this
                // one reports the dsh runtime actually in effect, which runtime
                // updates change without rebuilding the app.
                Button("关于 DeepSeek Harness") {
                    Task { @MainActor in
                        await updater.refreshRuntimeIdentity(server: server)
                        AboutPanel.present(AboutPanel.Info(
                            shellVersion: AboutPanel.shellVersion,
                            runtimeVersion: updater.runtimeVersion,
                            runtimePath: updater.runtimePath
                        ))
                    }
                }
            }
            CommandGroup(after: .appInfo) {
                Button("检查更新…") {
                    Task { await updater.checkForUpdates(server: server) }
                }
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
