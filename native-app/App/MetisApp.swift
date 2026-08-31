import SwiftUI
import SwiftData
import MetisKit

/// The single multiplatform SwiftUI app target (macOS · iPadOS · iOS) wrapping MetisKit. One
/// `MeetingController` is created at launch, installed into the App Intents registry so "Hey Siri,
/// summarize my meeting" drives the real meeting, and handed to the UI. Audio capture — the one
/// platform-conditional piece — is wired via the controller's injectable hooks (AudioCapture.swift).
///
/// First launch shows the five-act onboarding (OnboardingView); once finished, the app routes to the main
/// meeting experience. The SwiftData container backs on-device meeting history.
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
            RootView(controller: controller)
        }
        .modelContainer(for: StoredMeeting.self)
        #if os(macOS)
        .windowResizability(.contentSize)
        #endif

        #if os(macOS)
        MenuBarExtra("Métis", systemImage: "sparkles") {
            MenuBarControls(controller: controller)
        }
        #endif
    }
}

/// Gates first-run onboarding vs. the main app on a persisted flag. Onboarding writes its result straight
/// to `UserDefaults` (rather than through captured view state) so the finish closure stays side-effect
/// clean under strict concurrency, and the `@AppStorage` here observes that write to flip the view.
struct RootView: View {
    let controller: MeetingController
    @AppStorage("metis.onboardingDoneAt") private var onboardingDoneAt: Double = 0

    var body: some View {
        Group {
            if onboardingDoneAt == 0 {
                OnboardingView { mode, didConsent in
                    UserDefaults.standard.set(mode.rawValue, forKey: "metis.mode")
                    UserDefaults.standard.set(didConsent, forKey: "metis.consent")
                    UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: "metis.onboardingDoneAt")
                }
                .transition(.opacity)
            } else {
                ContentView(controller: controller)
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.5), value: onboardingDoneAt == 0)
    }
}

#if os(macOS)
/// Minimal menu-bar controls for a meeting copilot: toggle recording and jump to the window.
private struct MenuBarControls: View {
    @Bindable var controller: MeetingController
    var body: some View {
        Button(controller.isRecording ? "Stop Recording" : "Start Recording") {
            Task {
                if controller.isRecording { try? await controller.stopRecording() }
                else { try? await controller.startRecording() }
            }
        }
        Divider()
        Text(controller.intelligenceAvailable ? "On-device AI ready" : "Basic mode")
            .foregroundStyle(.secondary)
        Divider()
        Button("Quit Métis") { NSApplication.shared.terminate(nil) }
    }
}
#endif
