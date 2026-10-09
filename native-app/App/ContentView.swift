import SwiftUI
import SwiftData
import MetisKit

/// The main meeting experience — the same layout on macOS, iPad, and iOS (the platform difference is
/// audio, not UI). Refined from the early prototype into a cohesive shell: branded header, live transcript
/// with an empty state, a manual composer (mic capture is roadmap step 2), the three on-device actions
/// with working/error states, and save-to-history on stop. History and Settings open as sheets.
struct ContentView: View {
    @Bindable var controller: MeetingController

    @State private var draft = ""
    @State private var draftIsMe = true
    @State private var suggestion = ""
    @State private var summary: MeetingSummaryText?
    @State private var steps: [String] = []
    @State private var working = false
    @State private var activeAction: UUID?
    @State private var activeActionRevision: UUID?
    @State private var viewedMeetingID: UUID?
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
        .onChange(of: controller.actionRevision) { _, _ in
            if activeActionRevision != controller.actionRevision {
                activeAction = nil
                activeActionRevision = nil
                working = false
            }
        }
        .onChange(of: controller.meeting.id) { _, _ in
            synchronizeMeeting()
        }
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
                Label(controller.needsSaveRetry ? "Retry save" : controller.isRecording ? "Stop" : "Record",
                      systemImage: controller.needsSaveRetry ? "arrow.clockwise" : controller.isRecording ? "stop.fill" : "record.circle")
            }
            .buttonStyle(.borderedProminent)
            .tint(controller.isRecording ? .red : MetisTheme.accent)
            .disabled(controller.isTransitioning || !controller.isPersistenceReady)
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
        .disabled(controller.isTransitioning || controller.needsSaveRetry)
    }

    private var actions: some View {
        HStack {
            Button("What to say next") {
                run({ try await controller.suggestion() }, apply: { suggestion = $0 })
            }
            Button("Summarize") {
                run({ try await controller.summaryText() }, apply: { summary = $0 })
            }
            Button("Next steps") {
                run({ try await controller.nextSteps() }, apply: { steps = $0 })
            }
            if working { ProgressView().controlSize(.small).padding(.leading, 4) }
        }
        .disabled(working || controller.meeting.lines.isEmpty || controller.isTransitioning || controller.needsSaveRetry)
    }

    @ViewBuilder private var results: some View {
        if let message = controller.operationError?.errorDescription {
            Text(message).font(.caption).foregroundStyle(.orange)
        }
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
            do {
                if controller.isRecording || controller.needsSaveRetry {
                    try await controller.stopRecording()
                } else {
                    try await controller.startRecording()
                    let revision = controller.actionRevision
                    let status = await permissions.status(.microphone)
                    if controller.acceptsAction(revision) { micStatus = status }
                }
            } catch {
                // The shared controller exposes the fixed stop/save error and retains the transcript.
                // Do not clear results or replace its error with an unfiltered platform exception.
            }
        }
    }

    private func addLine() {
        guard !draft.isEmpty else { return }
        if controller.append(TranscriptLine(speaker: draftIsMe ? .me : .them, text: draft, at: Date())) {
            draft = ""
        }
    }

    private func run<Result: Sendable>(
        _ op: @escaping @MainActor () async throws -> Result,
        apply: @escaping @MainActor (Result) -> Void
    ) {
        synchronizeMeeting()
        let revision = controller.actionRevision
        guard !working, controller.acceptsAction(revision) else { return }
        let meetingID = controller.meeting.id
        let action = UUID()
        activeAction = action
        activeActionRevision = revision
        working = true
        errorText = nil
        let isCurrent = {
            activeAction == action && controller.meeting.id == meetingID && controller.acceptsAction(revision)
        }
        Task {
            defer {
                if isCurrent() {
                    working = false
                    activeAction = nil
                    activeActionRevision = nil
                }
            }
            do {
                let result = try await op()
                if isCurrent() { apply(result) }
            } catch {
                if isCurrent() { errorText = "That action could not finish. Please try again." }
            }
        }
    }

    /// Also called before starting an action, so a delayed onChange cannot clear that newer action.
    private func synchronizeMeeting() {
        guard viewedMeetingID != controller.meeting.id else { return }
        viewedMeetingID = controller.meeting.id
        activeAction = nil
        activeActionRevision = nil
        working = false
        suggestion = ""
        summary = nil
        steps = []
        errorText = nil
    }
}
