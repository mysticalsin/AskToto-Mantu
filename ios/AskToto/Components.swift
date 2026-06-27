import SwiftUI

/// Lightweight markdown rendering (headings/lists/code aware enough for AI answers).
struct MarkdownText: View {
    let text: String
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks().enumerated()), id: \.offset) { _, block in
                block.view
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private struct Block { let view: AnyView }

    private func blocks() -> [Block] {
        var out: [Block] = []
        let lines = text.components(separatedBy: "\n")
        var i = 0
        while i < lines.count {
            let line = lines[i]
            if line.hasPrefix("```") {
                var code = ""; i += 1
                while i < lines.count && !lines[i].hasPrefix("```") { code += lines[i] + "\n"; i += 1 }
                out.append(Block(view: AnyView(codeView(code))))
            } else if line.hasPrefix("# ") || line.hasPrefix("## ") || line.hasPrefix("### ") {
                let level = line.prefix(while: { $0 == "#" }).count
                let t = line.drop(while: { $0 == "#" || $0 == " " })
                out.append(Block(view: AnyView(
                    Text(String(t)).font(.system(size: level == 1 ? 22 : 17, weight: .bold))
                        .foregroundStyle(Mantu.ink))))
            } else if line.hasPrefix("- ") || line.hasPrefix("* ") {
                out.append(Block(view: AnyView(HStack(alignment: .top, spacing: 8) {
                    Circle().fill(Mantu.accentText).frame(width: 5, height: 5).padding(.top, 7)
                    inline(String(line.dropFirst(2)))
                })))
            } else if !line.trimmingCharacters(in: .whitespaces).isEmpty {
                out.append(Block(view: AnyView(inline(line))))
            }
            i += 1
        }
        return out
    }

    private func inline(_ s: String) -> Text {
        if let attr = try? AttributedString(markdown: s,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
            return Text(attr).foregroundStyle(Mantu.ink)
        }
        return Text(s).foregroundStyle(Mantu.ink)
    }
    private func codeView(_ code: String) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(code.trimmingCharacters(in: .newlines))
                .font(.system(.footnote, design: .monospaced))
                .foregroundStyle(Mantu.ink)
                .padding(12)
        }
        .background(Color.black.opacity(0.28), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Mantu.hair, lineWidth: 1))
    }
}

struct AnswerCard: View {
    @ObservedObject var vm: AskViewModel
    var onSave: () -> Void
    @State private var saved = false
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let e = vm.error {
                Label(e, systemImage: "exclamationmark.triangle")
                    .font(.callout).foregroundStyle(Mantu.danger)
            } else if vm.answer.isEmpty && vm.streaming {
                HStack(spacing: 6) { ProgressView().tint(Mantu.accent); Text("Thinking…").foregroundStyle(Mantu.ink2) }
            } else if !vm.answer.isEmpty {
                MarkdownText(text: vm.answer)
                HStack(spacing: 14) {
                    Button { UIPasteboard.general.string = vm.answer } label: {
                        Label("Copy", systemImage: "doc.on.doc").font(.caption)
                    }
                    Button { onSave(); saved = true
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { saved = false } } label: {
                        Label(saved ? "Saved" : "Save note", systemImage: saved ? "checkmark" : "square.and.arrow.down")
                            .font(.caption)
                    }
                    if vm.streaming { Button(role: .destructive) { vm.cancel() } label: { Label("Stop", systemImage: "stop.fill").font(.caption) } }
                }
                .foregroundStyle(Mantu.accentText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .mantuCard()
    }
}

struct ModeChips: View {
    @Binding var mode: ConvMode
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(ConvMode.allCases) { m in
                    let on = m == mode
                    Button { mode = m } label: {
                        Label(m.label, systemImage: m.icon).font(.caption.weight(.medium))
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .background(on ? Mantu.bright : Mantu.card.opacity(0.5),
                                        in: Capsule())
                            .foregroundStyle(on ? .white : Mantu.ink2)
                    }
                }
            }
        }
    }
}
