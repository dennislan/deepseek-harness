import SwiftUI

@main
struct DeepSeekHarnessApp: App {
    // Use @State instead of @StateObject for actor; observe via notification
    @State private var server = DshServer()
    @State private var bridge = BridgeManager()

    var body: some Scene {
        WindowGroup {
            ContentView(server: server, bridge: bridge)
                .onAppear {
                    Task { await server.start() }
                }
                .onDisappear {
                    Task { await server.stop() }
                }
                .frame(minWidth: 960, minHeight: 640)
        }
        .windowStyle(.hiddenTitleBar)
        .windowToolbarStyle(.unified)
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
