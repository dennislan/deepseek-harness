import AppKit
import SwiftUI

/// Builds and presents the application's About window.
///
/// A compact custom panel in place of the standard AppKit one: the app icon,
/// the name, a single version line, and one contact line. The displayed
/// version is the dsh runtime in effect, not the Swift shell's
/// `CFBundleShortVersionString`: an update replaces the runtime without
/// rebuilding the app, so the runtime version is the one that must stay current.
enum AboutPanel {
    /// Values the panel shows, built when the menu item is chosen.
    struct Info {
        /// Version of the dsh runtime in effect; nil when unreadable.
        let runtimeVersion: String?
        /// Version of the Swift shell, from the bundle; shown when the runtime version is unreadable.
        let shellVersion: String
    }

    /// Version of the Swift shell, read from the bundle's Info.plist.
    static var shellVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
    }

    /// Presents the About window. Pass an `Info` built at click time so it
    /// reflects the runtime installed most recently.
    @MainActor
    static func present(_ info: Info) {
        let view = AboutView(info: info)
            .frame(width: 280)

        let hosting = NSHostingController(rootView: view)
        hosting.sizingOptions = [.preferredContentSize]

        let window = NSWindow(contentViewController: hosting)
        window.styleMask = [.titled, .closable, .miniaturizable]
        window.title = "关于"
        window.isReleasedWhenClosed = false
        window.isMovableByWindowBackground = true
        window.center()

        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }
}

/// The compact body of the About window: icon, name, version, contact.
private struct AboutView: View {
    let info: AboutPanel.Info

    /// "版本 1.2.3", falling back to the shell version when the runtime is unreadable.
    private var versionLine: String {
        "版本 \(info.runtimeVersion ?? info.shellVersion)"
    }

    var body: some View {
        VStack(spacing: 12) {
            if let icon = NSApp.applicationIconImage {
                Image(nsImage: icon)
                    .resizable()
                    .interpolation(.high)
                    .frame(width: 72, height: 72)
            }

            Text("DeepSeek Harness")
                .font(.title3)
                .fontWeight(.semibold)

            Text(versionLine)
                .font(.callout)
                .foregroundStyle(.secondary)

            Text("dennis.lan@gmail.com")
                .font(.callout)
                .foregroundStyle(.secondary)
                .padding(.top, -6)
        }
        .padding(24)
    }
}
