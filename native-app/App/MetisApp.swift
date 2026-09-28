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
    @State private var modelPolicyRuntime = ModelPolicyRuntime(client: MetisApp.makeModelPolicyClient())

    init() {
        let c = MeetingController()
        MeetingActionsRegistry.shared = c // App Intents perform() bodies drive THIS controller
        AudioCapture.wire(into: c)         // inject platform audio start/stop (mic; + loopback on macOS)
        _controller = State(initialValue: c)
    }

    var body: some Scene {
        WindowGroup {
            RootView(controller: controller, modelPolicyRuntime: modelPolicyRuntime)
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

    // MARK: Fleet model policy (M2-0412)

    /// `UserDefaults` keys nothing in this app populates yet — this app has no device pairing/license
    /// flow (no Keychain or network credential storage anywhere in `native-app/` today, see
    /// `OperatorDeviceAuth`'s and `ModelPolicyRuntime`'s doc comments). The poller below is real and
    /// tested; it starts fetching and enforcing the fleet policy the moment these three values exist.
    static let operatorURLDefaultsKey = "metis.operatorURL"
    static let operatorIngestSecretDefaultsKey = "metis.operatorIngestSecret"
    private static let operatorDeviceInstallIDDefaultsKey = "metis.operatorDeviceInstallID"

    /// A stable per-installation id (not a real hardware machine id — this app has no such reader yet):
    /// generated once and persisted, then hashed before use as the HMAC device id (`OperatorDeviceAuth.
    /// hashDeviceId`) so it never leaves this device except as an opaque digest.
    private static func operatorDeviceInstallID() -> String {
        if let existing = UserDefaults.standard.string(forKey: operatorDeviceInstallIDDefaultsKey) { return existing }
        let fresh = UUID().uuidString
        UserDefaults.standard.set(fresh, forKey: operatorDeviceInstallIDDefaultsKey)
        return fresh
    }

    private static func makeModelPolicyClient() -> ModelPolicyClient {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Metis", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let cacheURL = dir.appendingPathComponent("model-policy-cache.json")
        return ModelPolicyClient(cacheURL: cacheURL) { url in
            guard let secret = UserDefaults.standard.string(forKey: operatorIngestSecretDefaultsKey), !secret.isEmpty else {
                throw URLError(.userAuthenticationRequired)
            }
            let deviceId = OperatorDeviceAuth.hashDeviceId(operatorDeviceInstallID())
            var request = URLRequest(url: url)
            for (field, value) in OperatorDeviceAuth.headers(secret: secret, deviceId: deviceId, body: "") {
                request.setValue(value, forHTTPHeaderField: field)
            }
            return try await URLSession.shared.data(for: request)
        }
    }
}

/// Gates first-run onboarding vs. the main app on a persisted flag. Onboarding writes its result straight
/// to `UserDefaults` (rather than through captured view state) so the finish closure stays side-effect
/// clean under strict concurrency, and the `@AppStorage` here observes that write to flip the view.
struct RootView: View {
    let controller: MeetingController
    let modelPolicyRuntime: ModelPolicyRuntime
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
        .task {
            // M2-0412: start the fleet model policy poller for the app's lifetime. A no-op today (see
            // MetisApp.operatorURLDefaultsKey's doc comment) until a device pairing flow populates the URL
            // and ingest secret; from then on this fetches at launch and re-polls every <=60s.
            guard let urlString = UserDefaults.standard.string(forKey: MetisApp.operatorURLDefaultsKey),
                  let url = URL(string: urlString)
            else { return }
            await modelPolicyRuntime.start(url: url) {
                UserDefaults.standard.string(forKey: MetisApp.operatorIngestSecretDefaultsKey)
            }
        }
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
