import Foundation

struct Note: Identifiable, Hashable {
    let id: String          // file name
    let url: URL
    let title: String
    let date: Date
    let mode: String
}

/// The markdown "backend" — every answer/meeting is saved as a .md file in Documents (visible in Files).
@MainActor
final class NoteStore: ObservableObject {
    @Published var notes: [Note] = []
    let folder: URL

    init() {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        folder = docs.appendingPathComponent("AskToto Notes", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        ensureReadme()
        reload()
    }

    private func ensureReadme() {
        let r = folder.appendingPathComponent("README.md")
        if !FileManager.default.fileExists(atPath: r.path) {
            try? "# AskToto Notes\n\nEvery answer and meeting AskToto saves lands here as one markdown file with frontmatter (`type`, `mode`, `date`). Open in Files, Obsidian, or hand to your Dust agents.\n".write(to: r, atomically: true, encoding: .utf8)
        }
    }

    func reload() {
        let folder = self.folder
        Task {
            let loaded = await Self.loadNotes(from: folder)
            await MainActor.run { self.notes = loaded }
        }
    }

    private nonisolated static func loadNotes(from folder: URL) async -> [Note] {
        let urls = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.contentModificationDateKey]))?
            .filter { $0.pathExtension == "md" && $0.lastPathComponent != "README.md" } ?? []
        return urls.map { url in
            let body = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
            let title = frontmatter(body, "title") ?? url.deletingPathExtension().lastPathComponent
            let mode = frontmatter(body, "mode") ?? "general"
            let date = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? Date()
            return Note(id: url.lastPathComponent, url: url, title: title, date: date, mode: mode)
        }.sorted { $0.date > $1.date }
    }

    private nonisolated static func frontmatter(_ body: String, _ key: String) -> String? {
        for line in body.components(separatedBy: .newlines).prefix(12) {
            if line.hasPrefix("\(key):") {
                return String(line.dropFirst(key.count + 1))
                    .trimmingCharacters(in: CharacterSet(charactersIn: " \r\"'"))
            }
        }
        return nil
    }

    @discardableResult
    func save(title: String, mode: String, question: String, answer: String, transcript: String? = nil) -> URL {
        let clean = title.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        let display = clean.isEmpty ? "Note" : String(clean.prefix(80))
        let stamp = Self.stamp(Date())
        let slug = Self.slug(display)
        var url = folder.appendingPathComponent("\(stamp)-\(slug).md")
        var n = 2
        while FileManager.default.fileExists(atPath: url.path) {
            url = folder.appendingPathComponent("\(stamp)-\(slug)-\(n).md"); n += 1
        }
        let fm = """
        ---
        type: note
        source: AskToto iOS
        mode: \(mode)
        date: \(ISO8601DateFormatter().string(from: Date()))
        title: "\(display.replacingOccurrences(of: "\"", with: "\\\""))"
        status: ready-for-followup
        ---

        """
        var md = "# \(display)\n\n"
        if !question.isEmpty { md += "## Question\n\n\(question)\n\n" }
        md += "## Answer\n\n\(answer)\n"
        if let t = transcript, !t.isEmpty { md += "\n## Transcript\n\n\(t)\n" }
        try? (fm + md).write(to: url, atomically: true, encoding: .utf8)
        reload()
        return url
    }

    func delete(_ note: Note) { try? FileManager.default.removeItem(at: note.url); reload() }

    static func slug(_ s: String) -> String {
        let lower = s.lowercased()
        let mapped = lower.map { $0.isLetter || $0.isNumber ? $0 : "-" }
        let joined = String(mapped).replacingOccurrences(of: "-+", with: "-", options: .regularExpression)
        return joined.trimmingCharacters(in: CharacterSet(charactersIn: "-")).isEmpty ? "note"
            : String(joined.trimmingCharacters(in: CharacterSet(charactersIn: "-")).prefix(50))
    }
    static func stamp(_ d: Date) -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd_HHmmss"; return f.string(from: d)
    }
}
