import SwiftUI
import MetisKit

/// Minimal, honest Settings — the preferences a real app needs without duplicating the Electron app's
/// full surface: personalization (mode + language), privacy/consent, live permission status with
/// deep-links, and an About panel. Everything on-device; nothing here reaches a network.
struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @AppStorage("metis.mode") private var modeRaw = MeetingMode.general.rawValue
    @AppStorage("metis.language") private var language = "system"
    @AppStorage("metis.consent") private var consent = false

    @State private var mic: PermissionStatus = .unknown
    @State private var speech: PermissionStatus = .unknown
    @State private var screen: PermissionStatus = .unknown
    private let permissions = PermissionsService()

    private var mode: Binding<MeetingMode> {
        Binding(get: { MeetingMode(rawValue: modeRaw) ?? .general }, set: { modeRaw = $0.rawValue })
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Personalize") {
                    Picker("Primary use", selection: mode) {
                        ForEach(MeetingMode.allCases) { Text($0.title).tag($0) }
                    }
                    Picker("Language", selection: $language) {
                        Text("Match the speaker").tag("system")
                        Text("English").tag("en")
                        Text("Français").tag("fr")
                        Text("Español").tag("es")
                        Text("Deutsch").tag("de")
                    }
                }

                Section("Privacy") {
                    Toggle("Confirm recording consent by default", isOn: $consent)
                    Text("Métis runs on-device. Transcripts and summaries stay on this Mac; nothing is uploaded.")
                        .font(.caption).foregroundStyle(.secondary)
                }

                Section("Permissions") {
                    permissionRow("Microphone", status: mic, kind: .microphone)
                    permissionRow("Speech recognition", status: speech, kind: .speech)
                    #if os(macOS)
                    permissionRow("Screen recording", status: screen, kind: .screenRecording)
                    #endif
                }

                Section("About") {
                    LabeledContent("Métis", value: appVersion)
                    Text("Native on-device meeting copilot — Mantu.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Settings")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await refresh() }
        }
        .frame(minWidth: 460, minHeight: 480)
    }

    private func permissionRow(_ label: String, status: PermissionStatus, kind: PermissionKind) -> some View {
        HStack {
            Text(label)
            Spacer()
            Text(statusLabel(status)).font(.caption).foregroundStyle(status == .granted ? .green : .secondary)
            if status != .granted {
                Button("Open") { permissions.openSystemSettings(kind) }.font(.caption)
            }
        }
    }

    private func statusLabel(_ status: PermissionStatus) -> String {
        switch status {
        case .granted: return "Granted"
        case .denied: return "Denied"
        case .restricted: return "Restricted"
        case .notDetermined: return "Not requested"
        case .unknown: return "—"
        }
    }

    private var appVersion: String {
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.0"
        return "v\(v)"
    }

    private func refresh() async {
        mic = await permissions.status(.microphone)
        speech = await permissions.status(.speech)
        screen = await permissions.status(.screenRecording)
    }
}
