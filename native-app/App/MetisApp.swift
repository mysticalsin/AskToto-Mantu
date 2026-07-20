import SwiftUI
import MetisKit

/// The single multiplatform SwiftUI app target (macOS · iPadOS · iOS) wrapping MetisKit — roadmap step 1
/// in native-app/README.md. One `MeetingController` is created at launch, installed into the App Intents
/// registry so "Hey Siri, summarize my meeting" drives the real meeting, and handed to the UI. Audio
/// capture — the one platform-conditional piece — is wired via the controller's injectable hooks
/// (AudioCapture.swift). `App` is @MainActor, so constructing the @MainActor controller here is safe.
///
/// NOTE: this app target is built with Xcode (or `xcodegen generate` + xcodebuild), not `swift build` —
/// the shared logic it drives (MeetingController, Intelligence, intents) is what the package tests cover.
@main
struct MetisApp: App {
    @State private var controller: MeetingController

    init() {
        let c = MeetingController()
        MeetingActionsRegistry.shared = c // App Intents perform() bodies drive THIS controller
        AudioCapture.wire(into: c)         // inject platform audio start/stop (mic; + loopback on macOS)
        _controller = State(initialValue: c)
    }

    var body: some Scene {
        WindowGroup {
            ContentView(controller: controller)
        }
        #if os(macOS)
        .windowResizability(.contentSize)
        #endif
    }
}
