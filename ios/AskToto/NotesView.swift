import SwiftUI

struct NotesView: View {
    @EnvironmentObject var notes: NoteStore
    @State private var query = ""

    var filtered: [Note] {
        query.isEmpty ? notes.notes
            : notes.notes.filter { $0.title.localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Mantu.background
                if notes.notes.isEmpty {
                    VStack(spacing: 10) {
                        Image(systemName: "doc.text").font(.system(size: 36)).foregroundStyle(Mantu.accentText)
                        Text("No notes yet").font(.headline).foregroundStyle(Mantu.ink)
                        Text("Save an answer or a meeting and it lands here as markdown — also visible in the Files app.")
                            .font(.callout).foregroundStyle(Mantu.ink2).multilineTextAlignment(.center).padding(.horizontal, 40)
                    }
                } else {
                    List {
                        ForEach(filtered) { note in
                            NavigationLink {
                                NoteDetail(note: note)
                            } label: {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(note.title).font(.subheadline.weight(.semibold)).foregroundStyle(Mantu.ink).lineLimit(1)
                                    HStack(spacing: 6) {
                                        Text(note.mode.capitalized)
                                        Text("·"); Text(note.date.formatted(date: .abbreviated, time: .shortened))
                                    }.font(.caption).foregroundStyle(Mantu.ink3)
                                }
                            }
                            .listRowBackground(Mantu.card.opacity(0.4))
                        }
                        .onDelete { idx in idx.map { filtered[$0] }.forEach(notes.delete) }
                    }
                    .scrollContentBackground(.hidden)
                    .searchable(text: $query, prompt: "Search notes")
                }
            }
            .navigationTitle("Notes")
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button { notes.reload() } label: { Image(systemName: "arrow.clockwise") } } }
            .toolbarBackground(Mantu.darker, for: .navigationBar)
        }
    }
}

struct NoteDetail: View {
    let note: Note
    @State private var body_ = ""
    var body: some View {
        ScrollView {
            MarkdownText(text: stripped).padding()
        }
        .background(Mantu.background)
        .navigationTitle(note.title).navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { ShareLink(item: note.url) { Image(systemName: "square.and.arrow.up") } } }
        .task { body_ = (try? String(contentsOf: note.url, encoding: .utf8)) ?? "" }
    }
    private var stripped: String {
        // Hide the YAML frontmatter in the reader.
        guard body_.hasPrefix("---") else { return body_ }
        let parts = body_.components(separatedBy: "---")
        return parts.count >= 3 ? parts[2...].joined(separator: "---").trimmingCharacters(in: .whitespacesAndNewlines) : body_
    }
}
