import SwiftUI

@main
struct AskTotoApp: App {
    @StateObject private var app = AppState()
    @StateObject private var notes = NoteStore()

    init() {
        // Mantu-tint the nav/tab bars.
        let appearance = UITabBarAppearance()
        appearance.configureWithTransparentBackground()
        appearance.backgroundColor = UIColor(Mantu.darker.opacity(0.85))
        UITabBar.appearance().standardAppearance = appearance
        UITabBar.appearance().scrollEdgeAppearance = appearance
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if app.onboardingDone {
                    RootView()
                } else {
                    OnboardingView()
                }
            }
            .environmentObject(app)
            .environmentObject(notes)
            .tint(Mantu.accent)
            .preferredColorScheme(.dark)
        }
    }
}

struct RootView: View {
    var body: some View {
        TabView {
            AskView()
                .tabItem { Label("Ask", systemImage: "sparkles") }
            ListenView()
                .tabItem { Label("Listen", systemImage: "waveform") }
            NotesView()
                .tabItem { Label("Notes", systemImage: "doc.text") }
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
    }
}

/// Owns one streaming answer. Reused by Ask and Listen.
@MainActor
final class AskViewModel: ObservableObject {
    @Published var answer = ""
    @Published var streaming = false
    @Published var error: String?
    private var task: Task<Void, Never>?

    func run(app: AppState, user: String, imageBase64: String? = nil,
             history: [ChatTurn] = [], systemOverride: String? = nil) {
        cancel()
        answer = ""; error = nil; streaming = true
        let provider = app.provider
        let key = app.key(for: provider.id)
        let model = app.model(for: provider.id)
        let system = systemOverride ?? app.systemPrompt
        let temp = app.temperature
        task = Task {
            do {
                let stream = LLMClient.stream(provider: provider, apiKey: key, model: model,
                                              system: system, history: history, user: user,
                                              imageBase64: imageBase64, temperature: temp)
                for try await delta in stream {
                    answer += delta
                }
                streaming = false
            } catch is CancellationError {
                streaming = false
            } catch {
                self.error = error.localizedDescription
                streaming = false
            }
        }
    }
    func cancel() { task?.cancel(); task = nil; streaming = false }
}
