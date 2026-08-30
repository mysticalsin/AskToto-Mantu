import SwiftUI
import MetisKit
#if canImport(Speech)
import Speech
#endif

/// The native five-act onboarding — the Métis translation of the Vibe Island anatomy (Hero -> Problem
/// story -> Reveal -> "Your setup" live checks -> Personalize + consent), spec in
/// docs/ONBOARDING-EXPERIENCE.md. All flow logic lives in MetisKit's `OnboardingModel` (unit-tested); this
/// file is the animated SwiftUI skin. Motion is native only (PhaseAnimator-style staged fades, `Path.trim`
/// self-draw in MetisMark, blur-to-sharp reveal) — no third-party animation deps.
struct OnboardingView: View {
    @State private var model: OnboardingModel

    init(onFinish: @escaping @MainActor @Sendable (MeetingMode, Bool) -> Void) {
        #if os(macOS)
        let includeScreen = true
        #else
        let includeScreen = false
        #endif
        _model = State(initialValue: OnboardingModel(
            permissions: PermissionsService(),
            includeScreenRow: includeScreen,
            probeIntelligenceAvailable: { OnboardingProbes.intelligenceAvailable() },
            probeTranscriptionReady: { await OnboardingProbes.transcriptionReady() },
            onFinish: onFinish
        ))
    }

    var body: some View {
        ZStack {
            MetisBackground()
            VStack(spacing: 0) {
                ActProgress(scene: model.scene)
                    .frame(height: 36)
                    .padding(.top, 10)
                Spacer(minLength: 0)
                sceneContent
                    .frame(maxWidth: 560)
                    .padding(.horizontal, 40)
                    .transition(.asymmetric(
                        insertion: .opacity.combined(with: .offset(y: 10)),
                        removal: .opacity.combined(with: .offset(y: -10))
                    ))
                    .id(model.scene)
                Spacer(minLength: 0)
            }
            .animation(.easeInOut(duration: 0.4), value: model.scene)
        }
        .frame(minWidth: 640, minHeight: 620)
        .preferredColorScheme(.dark)
    }

    @ViewBuilder private var sceneContent: some View {
        switch model.scene {
        case .hero: HeroScene(model: model)
        case .story: StoryScene(model: model)
        case .reveal: RevealScene(model: model)
        case .setup: SetupScene(model: model)
        case .personalize: PersonalizeScene(model: model)
        }
    }
}

// MARK: - Progress dots

private struct ActProgress: View {
    let scene: OnboardingScene
    var body: some View {
        if let idx = OnboardingScene.guided.firstIndex(of: scene) {
            HStack(spacing: 6) {
                ForEach(Array(OnboardingScene.guided.enumerated()), id: \.offset) { i, _ in
                    Capsule()
                        .fill(i == idx ? MetisTheme.accent : Color.white.opacity(i < idx ? 0.5 : 0.15))
                        .frame(width: i == idx ? 20 : 6, height: 6)
                        .animation(.easeInOut(duration: 0.3), value: idx)
                }
            }
        }
    }
}

// MARK: - Scene 1: Hero

private struct HeroScene: View {
    @Bindable var model: OnboardingModel
    @State private var appeared = false
    private let bullets = [
        "Answers grounded in your own meeting",
        "Runs on your device. Nothing is uploaded.",
        "Recording always asks first, so you stay in control."
    ]
    var body: some View {
        VStack(spacing: 24) {
            MetisMark(size: 100, animated: true)
                .background(Circle().fill(MetisTheme.accentGlow).blur(radius: 40).scaleEffect(1.4))
            VStack(spacing: 16) {
                (Text("Métis. ").foregroundStyle(.white)
                    + Text("The wisdom before the moment.").foregroundStyle(.white.opacity(0.7)))
                    .font(.system(size: 27, weight: .semibold))
                    .multilineTextAlignment(.center)
                VStack(spacing: 6) {
                    ForEach(Array(bullets.enumerated()), id: \.offset) { i, t in
                        Text(t)
                            .font(.system(size: 13))
                            .foregroundStyle(.white.opacity(0.72))
                            .opacity(appeared ? 1 : 0)
                            .offset(y: appeared ? 0 : 6)
                            .animation(.easeOut(duration: 0.5).delay(0.3 + Double(i) * 0.22), value: appeared)
                    }
                }
            }
            VStack(spacing: 10) {
                Button { model.advance() } label: { Text("Begin").metisPrimaryButton() }
                    .buttonStyle(.plain)
                    .keyboardShortcut(.defaultAction)
                Button { model.skip() } label: {
                    Text("Skip the tour").font(.system(size: 11)).foregroundStyle(.white.opacity(0.45))
                }
                .buttonStyle(.plain)
            }
            Text("Mantu · Métis").font(.system(size: 10)).tracking(1).foregroundStyle(.white.opacity(0.4))
        }
        .onAppear { appeared = true }
    }
}

// MARK: - Scene 2: Problem story (staged)

private struct StoryScene: View {
    @Bindable var model: OnboardingModel
    var body: some View {
        VStack(spacing: 18) {
            VStack(spacing: 14) {
                ForEach(Array(model.storyLines.prefix(model.revealedStoryLines).enumerated()), id: \.offset) { i, line in
                    Text(line)
                        .font(.system(size: 26, weight: .medium))
                        .foregroundStyle(.white.opacity(i == model.revealedStoryLines - 1 ? 1 : 0.4))
                        .multilineTextAlignment(.center)
                        .transition(.opacity.combined(with: .offset(y: 8)))
                }
            }
            .frame(minHeight: 200, alignment: .top)

            if model.storyComplete {
                Button { model.advance() } label: { Text("Continue").metisPrimaryButton() }
                    .buttonStyle(.plain)
                    .keyboardShortcut(.defaultAction)
                    .transition(.opacity)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { withAnimation(.easeOut(duration: 0.4)) { model.revealNextStoryLine() } }
        .task(id: model.scene) {
            guard model.scene == .story else { return }
            while !model.storyComplete && !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1.2))
                if Task.isCancelled { break }
                withAnimation(.easeOut(duration: 0.5)) { model.revealNextStoryLine() }
            }
        }
    }
}

// MARK: - Scene 3: Reveal

private struct RevealScene: View {
    @Bindable var model: OnboardingModel
    @State private var answered = false
    var body: some View {
        VStack(spacing: 24) {
            Text("Here's what that looks like.")
                .font(.system(size: 24, weight: .semibold)).foregroundStyle(.white)
            GlassCard {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Example · THEM · just now")
                        .font(.system(size: 12)).foregroundStyle(.white.opacity(0.45))
                    Text("\u{201C}Can you recap where we left things last time?\u{201D}")
                        .font(.system(size: 13)).foregroundStyle(.white)
                    HStack(alignment: .top, spacing: 6) {
                        Image(systemName: "sparkles").font(.system(size: 12)).foregroundStyle(MetisTheme.accent2)
                        Text("Three things were agreed last call: the revised timeline, the security review, and the intro to their CTO. All three are done, so lead with that.")
                            .font(.system(size: 12)).foregroundStyle(.white.opacity(0.8))
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 10).fill(.white.opacity(0.04)))
                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.white.opacity(0.08)))
                    .blur(radius: answered ? 0 : 8)
                    .opacity(answered ? 1 : 0)
                    .animation(.easeOut(duration: 0.7), value: answered)
                }
                .padding(14)
            }
            VStack(spacing: 4) {
                Text("Grounded in your meeting, in your words.")
                Text("On your device. Nothing uploaded.")
            }
            .font(.system(size: 13)).foregroundStyle(.white.opacity(0.72))
            Button { model.advance() } label: { Text("Set me up").metisPrimaryButton() }
                .buttonStyle(.plain)
                .keyboardShortcut(.defaultAction)
        }
        .task(id: model.scene) {
            guard model.scene == .reveal else { return }
            try? await Task.sleep(for: .seconds(0.65))
            answered = true
        }
    }
}

// MARK: - Scene 4: Your setup (live)

private struct SetupScene: View {
    @Bindable var model: OnboardingModel
    var body: some View {
        VStack(spacing: 20) {
            Text("Your setup").font(.system(size: 22, weight: .semibold)).foregroundStyle(.white)
            VStack(spacing: 8) {
                ForEach(model.rows) { row in
                    SetupRowView(model: model, row: row)
                }
            }
            .frame(maxWidth: 460)

            if model.allReady {
                Text("Everything's ready. Nothing to configure.")
                    .font(.system(size: 14, weight: .medium)).foregroundStyle(.white)
                    .transition(.opacity)
            }

            Button { model.advance() } label: {
                Text("Continue").metisPrimaryButton(enabled: !model.needsPermissions)
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.defaultAction)
        }
        .animation(.easeInOut(duration: 0.3), value: model.allReady)
        .task(id: model.scene) {
            guard model.scene == .setup else { return }
            await model.runSetupChecks()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1.2))
                if Task.isCancelled { break }
                await model.refreshPermissions()
            }
        }
    }
}

private struct SetupRowView: View {
    @Bindable var model: OnboardingModel
    let row: SetupRow
    var body: some View {
        GlassCard {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: row.systemImage)
                    .font(.system(size: 15)).foregroundStyle(.white.opacity(0.75)).frame(width: 18)
                VStack(alignment: .leading, spacing: 3) {
                    Text(row.label).font(.system(size: 13)).foregroundStyle(.white)
                    if !row.detail.isEmpty {
                        Text(row.detail).font(.system(size: 11)).foregroundStyle(.white.opacity(0.5))
                    }
                    actionControls
                }
                Spacer(minLength: 0)
                trailing
            }
            .padding(12)
        }
    }

    @ViewBuilder private var actionControls: some View {
        if row.key == "mic" && row.state == .action {
            InlineActionRow(hint: "Lets Métis hear your side of the call.", label: "Allow Microphone") {
                Task { await model.requestMicrophone() }
            }
        } else if row.key == "mic" && row.state == .blocked {
            InlineActionRow(hint: "Turn the microphone back on in Privacy settings.", label: "Open Microphone Settings") {
                model.openSettings(.microphone)
            }
        } else if row.key == "screen" && row.state == .action {
            InlineActionRow(hint: "Lets Métis hear the other side of the call.", label: "Open Screen Recording Settings") {
                model.openSettings(.screenRecording)
            }
        } else if row.key == "screen" && row.state == .restart {
            InlineActionRow(hint: "Granted. Restart Métis to finish enabling it.", label: "Restart Métis", emphasized: true) {
                AppRelaunch.relaunch()
            }
        }
    }

    @ViewBuilder private var trailing: some View {
        switch row.state {
        case .checking: ProgressView().controlSize(.small)
        case .ready: Image(systemName: "checkmark").foregroundStyle(MetisTheme.accent2).font(.system(size: 14, weight: .semibold))
        case .skipped: Image(systemName: "checkmark").foregroundStyle(.white.opacity(0.35)).font(.system(size: 13))
        case .action: Text("needed").font(.system(size: 11, weight: .medium)).foregroundStyle(.white.opacity(0.7))
        case .blocked: Text("blocked").font(.system(size: 11, weight: .medium)).foregroundStyle(.orange)
        case .restart: Text("restart").font(.system(size: 11, weight: .medium)).foregroundStyle(MetisTheme.accent2)
        }
    }
}

private struct InlineActionRow: View {
    let hint: String
    let label: String
    var emphasized: Bool = false
    let action: () -> Void
    var body: some View {
        HStack(spacing: 8) {
            Text(hint).font(.system(size: 11)).foregroundStyle(.white.opacity(0.5))
            Button(action: action) {
                Text(label)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(emphasized ? .white : MetisTheme.accent2)
                    .padding(.horizontal, 10).padding(.vertical, 5)
                    .background(Capsule().fill(emphasized ? AnyShapeStyle(MetisTheme.accent) : AnyShapeStyle(MetisTheme.accent.opacity(0.18))))
            }
            .buttonStyle(.plain)
        }
        .padding(.top, 5)
    }
}

// MARK: - Scene 5: Personalize + consent

private struct PersonalizeScene: View {
    @Bindable var model: OnboardingModel
    @AppStorage("metis.language") private var language = "system"
    var body: some View {
        VStack(spacing: 22) {
            Text("How will you use Métis?").font(.system(size: 22, weight: .semibold)).foregroundStyle(.white)
            HStack(spacing: 12) {
                ForEach(MeetingMode.allCases) { m in
                    ModeCard(mode: m, selected: model.mode == m) { model.mode = m }
                }
            }
            HStack(spacing: 8) {
                Text("Language").font(.system(size: 12)).foregroundStyle(.white.opacity(0.6))
                Picker("Language", selection: $language) {
                    Text("Match the speaker").tag("system")
                    Text("English").tag("en")
                    Text("Français").tag("fr")
                    Text("Español").tag("es")
                    Text("Deutsch").tag("de")
                }
                .labelsHidden()
                .frame(width: 200)
            }
            Toggle(isOn: $model.consent) {
                Text("I'll tell everyone on the call before I record, and follow my company's policy and the law.")
                    .font(.system(size: 12)).foregroundStyle(.white.opacity(0.72))
            }
            .frame(maxWidth: 420)

            VStack(spacing: 10) {
                Text("Ready when you are.").font(.system(size: 15, weight: .medium)).foregroundStyle(.white)
                Button { model.finish() } label: {
                    Text("Start").metisPrimaryButton(enabled: model.canFinish)
                }
                .buttonStyle(.plain)
                .disabled(!model.canFinish)
                .keyboardShortcut(.defaultAction)
            }
        }
    }
}

private struct ModeCard: View {
    let mode: MeetingMode
    let selected: Bool
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 4) {
                Text(mode.title).font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
                Text(mode.blurb).font(.system(size: 11)).foregroundStyle(.white.opacity(0.6))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(width: 150, alignment: .leading)
            .padding(14)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(selected ? MetisTheme.accent.opacity(0.18) : Color.white.opacity(0.03))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(selected ? MetisTheme.accent : .white.opacity(0.10), lineWidth: selected ? 1.5 : 1)
            )
            .scaleEffect(selected ? 1.03 : 1)
            .shadow(color: selected ? MetisTheme.accentGlow : .clear, radius: 14)
        }
        .buttonStyle(.plain)
        .animation(.spring(duration: 0.25), value: selected)
    }
}

// MARK: - Runtime probes (real signals for Scene 4)

/// Honest capability probes for the setup scene. Kept out of `OnboardingModel` so the model stays
/// framework-free and testable; these touch the real on-device model + Speech authorization.
enum OnboardingProbes {
    static func intelligenceAvailable() -> Bool {
        if case .available = makeMeetingIntelligence().availability { return true }
        return false
    }
    static func transcriptionReady() async -> Bool {
        #if canImport(Speech)
        if #available(macOS 26.0, iOS 26.0, *) {
            return SFSpeechRecognizer.authorizationStatus() == .authorized
        }
        #endif
        return false
    }
}
