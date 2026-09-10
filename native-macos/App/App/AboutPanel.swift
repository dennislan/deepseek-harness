import AppKit

/// Builds the application's About panel.
///
/// The displayed version is the dsh runtime in effect, not the Swift shell's
/// `CFBundleShortVersionString`: an update replaces the runtime without
/// rebuilding the app, so the runtime version is the one that must stay current.
enum AboutPanel {
    /// Values the panel shows, built when the menu item is chosen.
    struct Info {
        /// Version of the Swift shell, from the bundle.
        let shellVersion: String
        /// Version of the runtime in effect, or nil when unreadable.
        let runtimeVersion: String?
        /// Directory the runtime in effect was loaded from.
        let runtimePath: String
    }

    /// Version of the Swift shell, read from the bundle's Info.plist.
    static var shellVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
    }

    /// Shows the standard About panel with the runtime version as the app version.
    /// - Parameter info: build it at click time so it reflects the runtime
    ///   installed most recently.
    static func present(_ info: Info) {
        let details = NSMutableAttributedString(
            string: "Developed by Dennis <dennis.lan@gmail.com>",
            attributes: [
                .font: NSFont.systemFont(ofSize: 11),
                .foregroundColor: NSColor.secondaryLabelColor,
            ]
        )

        NSApplication.shared.orderFrontStandardAboutPanel(options: [
            .applicationName: "DeepSeek Harness",
            .applicationVersion: info.runtimeVersion ?? info.shellVersion,
            .credits: details,
        ])
        NSApplication.shared.activate(ignoringOtherApps: true)
    }
}
