// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "DeepSeekHarness",
    platforms: [
        .macOS(.v14)
    ],
    targets: [
        .executableTarget(
            name: "DeepSeekHarness",
            path: "App",
            sources: [
                "App/DeepSeekHarnessApp.swift",
                "App/ContentView.swift",
                "App/AboutPanel.swift",
                "Server/DshServer.swift",
                "Server/NodeRuntime.swift",
                "Update/RuntimeVersion.swift",
                "Update/RuntimeLayout.swift",
                "Update/ReleaseResolver.swift",
                "Update/RuntimeInstaller.swift",
                "Update/RuntimeUpdater.swift",
                "NativeBridge/BridgeManager.swift",
            ],
            resources: [
                // Will be populated at build time
            ],
            linkerSettings: [
                .unsafeFlags(["-framework", "WebKit"]),
            ]
        )
    ]
)
