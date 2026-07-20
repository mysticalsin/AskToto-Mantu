import SwiftUI
import MetisKit

/// The meeting screen — the same layout on macOS, iPad, and iOS (the platform difference is audio, not UI:
/// macOS captures both sides, iOS is in-person / one-room mic — see README). Live transcript, a manual
/// "add line" field (mic capture is roadmap step 2), and the three on-device actions: what to say next,
/// summarize, and the next steps.
struct ContentView: View {
    @Bindable var controller: MeetingController
    @State private var draft = ""
    @State private var draftIsMe = true
    @State private var suggestion = ""
    @State private var summary: MeetingSummaryText?
    @State private var steps: [String] = []
    @State private var working = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            transcript
            composer
            actions
            results
            Spacer(minLength: 0)
        }
        .padding()
        .frame(minWidth: 420, minHeight: 520)
    }

    private var header: some View {
        HStack {
            Text(controller.meeting.title).font(.headline)
            Spacer()
            Label(controller.intelligenceAvailable ? "On-device AI" : "Basic mode",
                  systemImage: controller.intelligenceAvailable ? "sparkles" : "cpu")
                .font(.caption).foregroundStyle(.secondary)
            Button(controller.isRecording ? "Stop" : "Record") {
                Task {
                    if controller.isRecording { try? await controller.stopRecording() }
                    else { try? await controller.startRecording() }
                }
            }
            .buttonStyle(.borderedProminent)
        }
    }

    private var transcript: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(controller.meeting.lines) { line in
                    HStack(alignment: .top, spacing: 6) {
                        Text(line.name ?? (line.speaker == .me ? "You" : line.speaker == .them ? "Them" : "Speaker"))
                            .font(.caption.bold())
                            .foregroundStyle(line.speaker == .me ? Color.blue : Color.secondary)
                            .frame(width: 56, alignment: .leading)
                        Text(line.text)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: 220)
    }

    private var composer: some View {
        HStack {
            Picker("", selection: $draftIsMe) {
                Text("You").tag(true)
                Text("Them").tag(false)
            }
            .pickerStyle(.segmented)
            .frame(width: 140)
            TextField("Add a line…", text: $draft)
                .textFieldStyle(.roundedBorder)
                .onSubmit(addLine)
            Button("Add", action: addLine).disabled(draft.isEmpty)
        }
    }

    private var actions: some View {
        HStack {
            Button("What to say next") { run { suggestion = try await controller.suggestion() } }
            Button("Summarize") { run { summary = try await controller.summaryText() } }
            Button("Next steps") { run { steps = try await controller.nextSteps() } }
        }
        .disabled(working)
    }

    @ViewBuilder private var results: some View {
        if !suggestion.isEmpty {
            GroupBox("Say next") {
                Text(suggestion).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        if let s = summary {
            GroupBox("Summary") {
                VStack(alignment: .leading, spacing: 4) {
                    Text(s.headline).bold()
                    ForEach(s.actionItems, id: \.self) { Text("• \($0)") }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        if !steps.isEmpty {
            GroupBox("Next steps") {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(steps, id: \.self) { Text("→ \($0)") }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
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
        Task {
            defer { working = false }
            try? await op()
        }
    }
}
