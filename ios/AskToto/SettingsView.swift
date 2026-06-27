import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var app: AppState
    @State private var keyInput = ""
    @State private var saved = false
    @State private var detected: String?

    var provider: Provider { app.provider }

    var body: some View {
        NavigationStack {
            ZStack {
                Mantu.background
                Form {
                    providerSection
                    keySection
                    modelSection
                    personalizeSection
                    aboutSection
                }
                .scrollContentBackground(.hidden)
            }
            .navigationTitle("Settings")
            .toolbarBackground(Mantu.darker, for: .navigationBar)
        }
        .tint(Mantu.accent)
    }

    private var providerSection: some View {
        Section {
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                ForEach(Providers.all) { p in
                    let on = p.id == app.providerId
                    Button { app.providerId = p.id; keyInput = ""; detected = nil } label: {
                        HStack {
                            Text(p.label).font(.caption.weight(.medium)).lineLimit(1)
                            Spacer()
                            if app.hasKey[p.id] == true { Image(systemName: "checkmark.circle.fill").foregroundStyle(Mantu.success) }
                        }
                        .padding(10)
                        .background(on ? Mantu.bright.opacity(0.25) : Color.white.opacity(0.03), in: RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(on ? Mantu.accent : Mantu.hair, lineWidth: 1))
                        .foregroundStyle(Mantu.ink)
                    }
                    .buttonStyle(.plain)
                }
            }
        } header: { Text("Provider").foregroundStyle(Mantu.accentText) }
        .listRowBackground(Color.clear)
    }

    private var keySection: some View {
        Section {
            SecureField(app.hasKey[provider.id] == true ? "•••••• saved — paste to replace" : "Paste your \(provider.label) key",
                        text: $keyInput)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .onChange(of: keyInput) { _, v in
                    if let p = Providers.detect(v), p.id != app.providerId {
                        app.providerId = p.id; detected = p.label
                    }
                }
            if let d = detected { Label("Detected \(d)", systemImage: "sparkles").font(.caption).foregroundStyle(Mantu.accentText) }
            HStack {
                Button(saved ? "Saved" : "Save key") {
                    app.setKey(keyInput.trimmingCharacters(in: .whitespacesAndNewlines), for: provider.id)
                    keyInput = ""; saved = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { saved = false }
                }
                .buttonStyle(.borderedProminent).tint(Mantu.bright)
                if app.hasKey[provider.id] == true {
                    Button(role: .destructive) { app.setKey("", for: provider.id) } label: { Image(systemName: "trash") }
                }
                Spacer()
                Link("Get a key", destination: URL(string: provider.keyURL)!).font(.caption)
            }
            Text("Stored in the iOS Keychain on this device.").font(.caption2).foregroundStyle(Mantu.ink3)
        } header: { Text("\(provider.label) key").foregroundStyle(Mantu.accentText) }
        .listRowBackground(Mantu.card.opacity(0.35))
    }

    private var modelSection: some View {
        Section {
            Picker("Model", selection: Binding(
                get: { app.model(for: provider.id) },
                set: { app.setModel($0, for: provider.id) })) {
                ForEach(provider.models, id: \.self) { Text($0).tag($0) }
            }
            HStack { Text("Creativity"); Slider(value: $app.temperature, in: 0...1, step: 0.1); Text(String(format: "%.1f", app.temperature)).foregroundStyle(Mantu.ink2) }
        } header: { Text("Model").foregroundStyle(Mantu.accentText) }
        .listRowBackground(Mantu.card.opacity(0.35))
    }

    private var personalizeSection: some View {
        Section {
            Picker("Default mode", selection: Binding(get: { app.mode }, set: { app.mode = $0 })) {
                ForEach(ConvMode.allCases) { Text($0.label).tag($0) }
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("Prompt — \(app.mode.label)").font(.caption).foregroundStyle(Mantu.ink3)
                TextEditor(text: Binding(
                    get: { app.prompt(for: app.mode) ?? Prompts.base(app.mode) },
                    set: { app.setPrompt($0, for: app.mode) }))
                    .frame(minHeight: 110).scrollContentBackground(.hidden)
                    .padding(8).background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 10))
                    .foregroundStyle(Mantu.ink)
                Button("Reset to default") { app.setPrompt(nil, for: app.mode) }.font(.caption)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("About you (used for interview & sales)").font(.caption).foregroundStyle(Mantu.ink3)
                TextEditor(text: $app.profile).frame(minHeight: 90).scrollContentBackground(.hidden)
                    .padding(8).background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 10))
                    .foregroundStyle(Mantu.ink)
            }
        } header: { Text("Personalize").foregroundStyle(Mantu.accentText) }
        .listRowBackground(Mantu.card.opacity(0.35))
    }

    private var aboutSection: some View {
        Section {
            VStack(spacing: 8) {
                MantuWordmark(size: 26)
                Label("Built with care by Tony Walteur", systemImage: "heart.fill")
                    .font(.caption).foregroundStyle(Mantu.ink3)
            }.frame(maxWidth: .infinity).padding(.vertical, 8)
        }
        .listRowBackground(Color.clear)
    }
}
