// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "BrowserGuideNative",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "BrowserGuideNativeCore", targets: ["BrowserGuideNativeCore"]),
        .executable(name: "BrowserGuideNativeHost", targets: ["BrowserGuideNativeHost"]),
        .executable(name: "BrowserGuideHelper", targets: ["BrowserGuideHelper"]),
    ],
    targets: [
        .target(
            name: "BrowserGuideNativeCore",
            linkerSettings: [
                .linkedFramework("LocalAuthentication"),
                .linkedFramework("Security"),
                .linkedFramework("Speech"),
                .linkedFramework("AVFoundation"),
            ]
        ),
        .executableTarget(
            name: "BrowserGuideNativeHost",
            dependencies: ["BrowserGuideNativeCore"]
        ),
        .executableTarget(
            name: "BrowserGuideHelper",
            dependencies: ["BrowserGuideNativeCore"],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("SwiftUI"),
            ]
        ),
        .testTarget(
            name: "BrowserGuideNativeCoreTests",
            dependencies: ["BrowserGuideNativeCore"]
        ),
    ],
    swiftLanguageModes: [.v6]
)
