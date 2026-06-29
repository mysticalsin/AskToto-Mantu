import SwiftUI

struct OnboardingView: View {
    @EnvironmentObject var app: AppState
    @State private var key = ""
    @State private var detected: String?
    @State private var recordingConsent = false

    var body: some View {
        ZStack {
            Mantu.background
            VStack(spacing: 22) {
                Spacer()
                MantuWordmark(size: 38)
                VStack(spacing: 8) {
                    Text("Your AI copilot.").font(.title.weight(.bold)).foregroundStyle(Mantu.ink)
                    Text("Ask anything, capture meetings, and keep every answer as a markdown note. Paste one API key to start.")
                        .font(.callout).foregroundStyle(Mantu.ink2).multilineTextAlignment(.center)
                }
                VStack(spacing: 10) {
                    SecureField("Paste any API key (auto-detected)", text: $key)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .padding(12).background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
                        .foregroundStyle(Mantu.ink)
                        .onChange(of: key) { _, v in
                            if let p = Providers.detect(v) { app.providerId = p.id; detected = p.label }
                        }
                    if let d = detected { Label("Detected \(d)", systemImage: "sparkles").font(.caption).foregroundStyle(Mantu.accentText) }
                }
                .padding(.horizontal)
                Toggle(isOn: $recordingConsent) {
                    Text("I will inform other participants before recording. AskToto follows my company's policy and the law.")
                        .font(.caption).foregroundStyle(Mantu.ink2)
                }
                .tint(Mantu.bright)
                .padding(.horizontal)
                Button {
                    let k = key.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !k.isEmpty { app.setKey(k, for: app.providerId) }
                    app.onboardingDone = true
                } label: {
                    Text("Get started").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 14)
                        .background(Mantu.bright.opacity(recordingConsent ? 1 : 0.35), in: RoundedRectangle(cornerRadius: 14))
                        .foregroundStyle(.white)
                }
                .disabled(!recordingConsent)
                .padding(.horizontal)
                // Consent gates BOTH paths out of onboarding — "Skip" reaches the recording UI just
                // like "Get started", so it must require the same recording-consent acknowledgement.
                Button("Skip — add a key later") { app.onboardingDone = true }
                    .font(.caption).foregroundStyle(Mantu.ink3)
                    .opacity(recordingConsent ? 1 : 0.35)
                    .disabled(!recordingConsent)
                Spacer()
                Label("Built by Tony Walteur · Mantu", systemImage: "heart.fill")
                    .font(.caption2).foregroundStyle(Mantu.ink3)
            }
            .padding()
        }
    }
}
