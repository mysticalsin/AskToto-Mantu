// swift-tools-version: 6.0
import PackageDescription

// MetisKit — the shared, platform-neutral core of the native Métis app (macOS + iPadOS + iOS).
// Holds the Apple Intelligence layer, meeting data models, and App Intents. The thin SwiftUI app
// targets (per platform) depend on this package; audio capture stays in the app targets because it is
// the one deeply platform-conditional piece (macOS ScreenCaptureKit loopback vs iOS mic-only — see
// native-app/README.md). Everything Apple-Intelligence is @available-gated to OS 26 so the package
// still builds against older deployment targets and degrades cleanly where the model is absent.
let package = Package(
    name: "MetisKit",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "MetisKit", targets: ["MetisKit"])
    ],
    targets: [
        .target(name: "MetisKit"),
        .testTarget(name: "MetisKitTests", dependencies: ["MetisKit"])
    ]
)
