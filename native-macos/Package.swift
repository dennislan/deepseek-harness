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
                "Server/DshServer.swift",
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
