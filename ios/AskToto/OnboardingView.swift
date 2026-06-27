import SwiftUI

struct OnboardingView: View {
    @EnvironmentObject var app: AppState
    @State private var key = ""
    @State private var detected: String?

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
                Button {
                    let k = key.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !k.isEmpty { app.setKey(k, for: app.providerId) }
                    app.onboardingDone = true
                } label: {
                    Text("Get started").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 14)
                        .background(Mantu.bright, in: RoundedRectangle(cornerRadius: 14)).foregroundStyle(.white)
                }
                .padding(.horizontal)
                Button("Skip — add a key later") { app.onboardingDone = true }
                    .font(.caption).foregroundStyle(Mantu.ink3)
                Spacer()
                Label("Built by Tony Walteur · Mantu", systemImage: "heart.fill")
                    .font(.caption2).foregroundStyle(Mantu.ink3)
            }
            .padding()
        }
    }
}
