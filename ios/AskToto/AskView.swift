import SwiftUI
import PhotosUI

struct AskView: View {
    @EnvironmentObject var app: AppState
    @EnvironmentObject var notes: NoteStore
    @StateObject private var vm = AskViewModel()
    @State private var input = ""
    @State private var lastQuestion = ""
    @State private var photoItem: PhotosPickerItem?
    @State private var pendingImage: String?   // base64 jpeg
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            ZStack {
                Mantu.background
                VStack(spacing: 12) {
                    ModeChips(mode: Binding(get: { app.mode }, set: { app.mode = $0 }))
                        .padding(.horizontal)
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            if !lastQuestion.isEmpty {
                                Text(lastQuestion).font(.subheadline.weight(.medium))
                                    .foregroundStyle(Mantu.ink).mantuCard()
                            }
                            if vm.streaming || !vm.answer.isEmpty || vm.error != nil {
                                AnswerCard(vm: vm) {
                                    notes.save(title: lastQuestion, mode: app.mode.rawValue,
                                               question: lastQuestion, answer: vm.answer)
                                }
                            } else {
                                emptyState
                            }
                        }
                        .padding(.horizontal)
                    }
                    inputBar
                }
                .padding(.top, 6)
            }
            .navigationTitle("Ask")
            .toolbar { ToolbarItem(placement: .topBarLeading) { HStack(spacing: 8) { MantuMark(size: 22); Text("AskToto").font(.headline) } } }
            .toolbarBackground(Mantu.darker, for: .navigationBar)
        }
        .onChange(of: photoItem) { _, item in Task { await loadImage(item) } }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            MantuMark(size: 40)
            Text("Ask anything").font(.headline).foregroundStyle(Mantu.ink)
            Text("Get an expert answer, attach a photo of a slide or whiteboard, or switch modes for interviews, sales and meetings.")
                .font(.callout).foregroundStyle(Mantu.ink2).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity).padding(.top, 40)
    }

    private var inputBar: some View {
        VStack(spacing: 6) {
            if pendingImage != nil {
                HStack { Label("Image attached", systemImage: "photo").font(.caption).foregroundStyle(Mantu.accentText)
                    Spacer(); Button { pendingImage = nil } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Mantu.ink3) } }
                .padding(.horizontal)
            }
            HStack(spacing: 10) {
                PhotosPicker(selection: $photoItem, matching: .images) {
                    Image(systemName: "camera").font(.title3).foregroundStyle(Mantu.accentText)
                }
                TextField("Ask anything…", text: $input, axis: .vertical)
                    .focused($focused).lineLimit(1...4)
                    .padding(10)
                    .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
                    .foregroundStyle(Mantu.ink)
                Button { send() } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.title)
                        .foregroundStyle(input.isEmpty && pendingImage == nil ? Mantu.ink3 : Mantu.accent)
                }
                .disabled(input.isEmpty && pendingImage == nil)
            }
            .padding(.horizontal).padding(.bottom, 6)
        }
        .background(Mantu.darker.opacity(0.6))
    }

    private func send() {
        let q = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty || pendingImage != nil else { return }
        lastQuestion = q.isEmpty ? "What's in this image?" : q
        let img = pendingImage
        if img != nil && !app.provider.vision {
            vm.error = "\(app.provider.label) can't read images. Switch to Claude, GPT or OpenRouter in Settings."
            return
        }
        vm.run(app: app, user: lastQuestion, imageBase64: img)
        input = ""; pendingImage = nil; focused = false
    }

    private func loadImage(_ item: PhotosPickerItem?) async {
        guard let item, let data = try? await item.loadTransferable(type: Data.self),
              let ui = UIImage(data: data) else { return }
        let resized = ui.resized(maxEdge: 1280)
        if let jpeg = resized.jpegData(compressionQuality: 0.7) {
            pendingImage = jpeg.base64EncodedString()
        }
    }
}

extension UIImage {
    func resized(maxEdge: CGFloat) -> UIImage {
        let m = max(size.width, size.height)
        guard m > maxEdge else { return self }
        let s = maxEdge / m
        let newSize = CGSize(width: size.width * s, height: size.height * s)
        return UIGraphicsImageRenderer(size: newSize).image { _ in
            draw(in: CGRect(origin: .zero, size: newSize))
        }
    }
}
