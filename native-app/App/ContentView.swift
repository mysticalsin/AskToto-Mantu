import SwiftUI
import SwiftData
import MetisKit

/// The main meeting experience — the same layout on macOS, iPad, and iOS (the platform difference is
/// audio, not UI). Refined from the early prototype into a cohesive shell: branded header, live transcript
/// with an empty state, a manual composer (mic capture is roadmap step 2), the three on-device actions
/// with working/error states, and save-to-history on stop. History and Settings open as sheets.
struct ContentView: View {
    @Bindable var controller: MeetingController
    @Environment(\.modelContext) private var modelContext

    @State private var draft = ""
    @State private var draftIsMe = true
    @State private var suggestion = ""
    @State private var summary: MeetingSummaryText?
    @State private var steps: [String] = []
    @State private var working = false
    @State private var errorText: String?
    @State private var micStatus: PermissionStatus = .unknown
    @State private var showHistory = false
    @State private var showSettings = false

    private let permissions = PermissionsService()

    var body: some View {
        ZStack {
            MetisBackground()
            VStack(alignment: .leading, spacing: 12) {
                header
                if micStatus == .denied || micStatus == .restricted { micBanner }
                transcript
                composer
                actions
                results
                Spacer(minLength: 0)
            }
            .padding(18)
        }
        .frame(minWidth: 460, minHeight: 560)
        .preferredColorScheme(.dark)
        .task { micStatus = await permissions.status(.microphone) }
        .sheet(isPresented: $showHistory) { HistoryView() }
        .sheet(isPresented: $showSettings) { SettingsView() }
    }

    private var header: some View {
        HStack(spacing: 12) {
            MetisMark(size: 30, animated: false)
            VStack(alignment: .leading, spacing: 1) {
                Text(controller.meeting.title).font(.headline).foregroundStyle(.white)
                Label(controller.intelligenceAvailable ? "On-device AI" : "Basic mode",
                      systemImage: controller.intelligenceAvailable ? "sparkles" : "cpu")
                    .font(.caption).foregroundStyle(.white.opacity(0.6)).labelStyle(.titleAndIcon)
            }
            Spacer()
            Button { showHistory = true } label: { Image(systemName: "clock.arrow.circlepath") }
                .buttonStyle(.plain).help("Meeting history")
            Button { showSettings = true } label: { Image(systemName: "gearshape") }
                .buttonStyle(.plain).help("Settings")
            Button(action: toggleRecording) {
                Label(controller.isRecording ? "Stop" : "Record",
                      systemImage: controller.isRecording ? "stop.fill" : "record.circle")
            }
            .buttonStyle(.borderedProminent)
            .tint(controller.isRecording ? .red : MetisTheme.accent)
        }
        .foregroundStyle(.white.opacity(0.85))
    }

    private var micBanner: some View {
        HStack(spacing: 8) {
            Image(systemName: "mic.slash")
            Text("Microphone is off. Métis can't hear your side of the call.")
                .font(.caption)
            Spacer()
            Button("Open Settings") { permissions.openSystemSettings(.microphone) }
                .font(.caption.bold()).buttonStyle(.plain).foregroundStyle(MetisTheme.accent2)
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10).fill(.orange.opacity(0.15)))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.orange.opacity(0.4)))
        .foregroundStyle(.white)
    }

    private var transcript: some View {
        GlassCard {
            Group {
                if controller.meeting.lines.isEmpty {
                    VStack(spacing: 6) {
                        Image(systemName: "waveform").font(.title2).foregroundStyle(.white.opacity(0.35))
                        Text(controller.isRecording ? "Listening…" : "No transcript yet")
                            .font(.subheadline).foregroundStyle(.white.opacity(0.6))
                        Text(controller.isRecording ? "Speak, or add a line below." : "Press Record, or add a line below.")
                            .font(.caption).foregroundStyle(.white.opacity(0.4))
                    }
                    .frame(maxWidth: .infinity).padding(.vertical, 30)
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(controller.meeting.lines) { line in
                                HStack(alignment: .top, spacing: 8) {
                                    Text(line.name ?? (line.speaker == .me ? "You" : line.speaker == .them ? "Them" : "Speaker"))
                                        .font(.caption.bold())
                                        .foregroundStyle(line.speaker == .me ? MetisTheme.accent2 : .white.opacity(0.55))
                                        .frame(width: 56, alignment: .leading)
                                    Text(line.text).foregroundStyle(.white.opacity(0.9))
                                }
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading).padding(4)
                    }
                    .frame(maxHeight: 200)
                }
            }
            .padding(10)
        }
    }

    private var composer: some View {
        HStack {
            Picker("", selection: $draftIsMe) {
                Text("You").tag(true)
                Text("Them").tag(false)
            }
            .pickerStyle(.segmented).frame(width: 140).labelsHidden()
            TextField("Add a line…", text: $draft)
                .textFieldStyle(.roundedBorder).onSubmit(addLine)
            Button("Add", action: addLine).disabled(draft.isEmpty)
        }
    }

    private var actions: some View {
        HStack {
            Button("What to say next") { run { suggestion = try await controller.suggestion() } }
            Button("Summarize") { run { summary = try await controller.summaryText() } }
            Button("Next steps") { run { steps = try await controller.nextSteps() } }
            if working { ProgressView().controlSize(.small).padding(.leading, 4) }
        }
        .disabled(working || controller.meeting.lines.isEmpty)
    }

    @ViewBuilder private var results: some View {
        if let errorText {
            Text(errorText).font(.caption).foregroundStyle(.orange)
        }
        if !suggestion.isEmpty {
            GlassCard { labeledBlock("Say next") { Text(suggestion).foregroundStyle(.white) } }
        }
        if let s = summary {
            GlassCard {
                labeledBlock("Summary") {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(s.headline).bold().foregroundStyle(.white)
                        ForEach(s.actionItems, id: \.self) { Text("• \($0)").foregroundStyle(.white.opacity(0.85)) }
                    }
                }
            }
        }
        if !steps.isEmpty {
            GlassCard {
                labeledBlock("Next steps") {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(steps, id: \.self) { Text("→ \($0)").foregroundStyle(.white.opacity(0.85)) }
                    }
                }
            }
        }
    }

    private func labeledBlock<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased()).font(.caption2.bold()).foregroundStyle(.white.opacity(0.5)).tracking(1)
            content().frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(12)
    }

    // MARK: Actions

    private func toggleRecording() {
        Task {
            if controller.isRecording {
                try? await controller.stopRecording()
                MeetingStore.save(controller.meeting, summary: summary, into: modelContext)
                controller.reset()
                suggestion = ""; summary = nil; steps = []; errorText = nil
            } else {
                try? await controller.startRecording()
                micStatus = await permissions.status(.microphone)
            }
        }
    }

    private func addLine() {
        guard !draft.isEmpty else { return }
        controller.append(TranscriptLine(speaker: draftIsMe ? .me : .them, text: draft, at: Date()))
        draft = ""
    }

    private func run(_ op: @escaping @MainActor () async throws -> Void) {
        working = true
        errorText = nil
        Task {
            defer { working = false }
            do { try await op() }
            catch { errorText = "That didn't work: \(error.localizedDescription)" }
        }
    }
}
