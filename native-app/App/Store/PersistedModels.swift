import Foundation
import SwiftData
import MetisKit

/// SwiftData persistence for saved meetings — roadmap step 4 (the on-device history the app keeps between
/// launches). The queryable columns (title, dates, line count, summary headline) drive the History list;
/// the full transcript is stored as an encoded blob of MetisKit's `TranscriptLine` values so the domain
/// model stays the single source of truth and ports 1:1 with the shared core. CloudKit sync is a later
/// roadmap step; this is the local store it will build on.
@Model
final class StoredMeeting {
    // Named `meetingID`, not `id`: SwiftData's `PersistentModel` already supplies `Identifiable`'s `id`
    // (the persistent model id), so a second stored `id` would shadow it and confuse `ForEach`/`.sheet(item:)`.
    @Attribute(.unique) var meetingID: UUID
    var title: String
    var startedAt: Date
    var endedAt: Date?
    var lineCount: Int
    var summaryHeadline: String?
    /// JSON-encoded `[TranscriptLine]` — kept as a blob so the shared MetisKit model isn't duplicated as
    /// a second SwiftData schema that could drift from it.
    var linesData: Data

    init(meetingID: UUID, title: String, startedAt: Date, endedAt: Date?, lineCount: Int, summaryHeadline: String?, linesData: Data) {
        self.meetingID = meetingID
        self.title = title
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.lineCount = lineCount
        self.summaryHeadline = summaryHeadline
        self.linesData = linesData
    }

    /// Decoded transcript lines (empty if the blob is somehow unreadable — never throws into the UI).
    var lines: [TranscriptLine] {
        (try? JSONDecoder().decode([TranscriptLine].self, from: linesData)) ?? []
    }
}

@MainActor
enum MeetingStore {
    /// Persist a finished meeting. Returns nil (no-op) for an empty meeting so a Record tapped by mistake
    /// never litters the history with blank rows.
    @discardableResult
    static func save(_ meeting: Meeting, summary: MeetingSummaryText?, into context: ModelContext) -> StoredMeeting? {
        guard !meeting.lines.isEmpty else { return nil }
        let data = (try? JSONEncoder().encode(meeting.lines)) ?? Data()
        let headline = summary?.headline.isEmpty == false ? summary?.headline : nil
        let stored = StoredMeeting(
            meetingID: meeting.id,
            title: meeting.title,
            startedAt: meeting.startedAt,
            endedAt: meeting.endedAt ?? Date(),
            lineCount: meeting.lines.count,
            summaryHeadline: headline,
            linesData: data
        )
        context.insert(stored)
        try? context.save()
        return stored
    }
}
