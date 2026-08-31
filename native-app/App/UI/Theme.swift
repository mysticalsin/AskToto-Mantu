import SwiftUI

/// Métis visual language for the native app — the same frosted-purple identity as the Electron overlay,
/// expressed in native SwiftUI tokens. Colors resolve from the asset catalog where possible so light/dark
/// and the system accent stay correct.
enum MetisTheme {
    static let accent = Color.accentColor
    static let accent2 = Color(red: 0.66, green: 0.55, blue: 1.0)
    static let accentGlow = Color(red: 0.49, green: 0.36, blue: 1.0).opacity(0.45)

    static let corner: CGFloat = 16
    static let cardCorner: CGFloat = 12
}

/// The ambient backdrop: a deep neutral base with a soft purple glow, echoing the overlay's glass.
/// Used behind onboarding and the main window so the app reads as one cohesive surface.
struct MetisBackground: View {
    var body: some View {
        ZStack {
            LinearGradient(
                colors: [Color(red: 0.07, green: 0.06, blue: 0.10), Color(red: 0.05, green: 0.05, blue: 0.07)],
                startPoint: .top, endPoint: .bottom
            )
            RadialGradient(
                colors: [MetisTheme.accentGlow, .clear],
                center: .top, startRadius: 0, endRadius: 520
            )
            .blendMode(.plusLighter)
            .opacity(0.5)
        }
        .ignoresSafeArea()
    }
}

/// A reusable frosted card, matching the overlay's `glass-strong` panels.
struct GlassCard<Content: View>: View {
    var cornerRadius: CGFloat = MetisTheme.cardCorner
    @ViewBuilder var content: Content
    var body: some View {
        content
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .strokeBorder(.white.opacity(0.10), lineWidth: 1)
            )
    }
}

extension View {
    /// Standard focusable pill button surface used across onboarding CTAs.
    func metisPrimaryButton(enabled: Bool = true) -> some View {
        self
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 22)
            .frame(height: 40)
            .background(
                Capsule().fill(enabled ? AnyShapeStyle(MetisTheme.accent) : AnyShapeStyle(Color.white.opacity(0.10)))
            )
            .shadow(color: enabled ? MetisTheme.accentGlow : .clear, radius: 16, y: 2)
            .opacity(enabled ? 1 : 0.6)
    }
}
