import SwiftUI
import SwiftData
import MetisKit

/// On-device meeting history, backed by SwiftData. Lists saved meetings newest-first; tapping one opens a
/// read-only detail with its summary headline and full transcript. Deleting removes it from the store.
struct HistoryView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \StoredMeeting.startedAt, order: .reverse) private var meetings: [StoredMeeting]
    @State private var selected: StoredMeeting?

    var body: some View {
        NavigationStack {
            Group {
                if meetings.isEmpty {
                    ContentUnavailableView(
                        "No meetings yet",
                        systemImage: "clock",
                        description: Text("Meetings you record are saved here, on this device.")
                    )
                } else {
                    List {
                        ForEach(meetings) { meeting in
                            Button { selected = meeting } label: { row(meeting) }
                                .buttonStyle(.plain)
                        }
                        .onDelete(perform: delete)
                    }
                }
            }
            .navigationTitle("History")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .sheet(item: $selected) { MeetingDetailView(meeting: $0) }
        }
        .frame(minWidth: 460, minHeight: 480)
    }

    private func row(_ meeting: StoredMeeting) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(meeting.title).font(.headline)
            if let headline = meeting.summaryHeadline {
                Text(headline).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            }
            Text("\(meeting.startedAt.formatted(date: .abbreviated, time: .shortened)) · \(meeting.lineCount) lines")
                .font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    private func delete(_ offsets: IndexSet) {
        for index in offsets { modelContext.delete(meetings[index]) }
        try? modelContext.save()
    }
}

private struct MeetingDetailView: View {
    let meeting: StoredMeeting
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let headline = meeting.summaryHeadline {
                        Text(headline).font(.title3.bold())
                    }
                    ForEach(meeting.lines) { line in
                        HStack(alignment: .top, spacing: 8) {
                            Text(line.name ?? (line.speaker == .me ? "You" : line.speaker == .them ? "Them" : "Speaker"))
                                .font(.caption.bold()).frame(width: 56, alignment: .leading).foregroundStyle(.secondary)
                            Text(line.text)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading).padding()
            }
            .navigationTitle(meeting.title)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .frame(minWidth: 420, minHeight: 420)
    }
}
