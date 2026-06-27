import SwiftUI

/// Mantu brand palette (Bright Purple #7F00DA / Primary #6600AE / Dark #1A0033). No yellow.
enum Mantu {
    static let bright = Color(hex: 0x7F00DA)
    static let primary = Color(hex: 0x6600AE)
    static let accent = Color(hex: 0x9A4DFF)      // legible-on-dark interactive purple
    static let accentText = Color(hex: 0xB388F0)  // accent for text/links on dark (AA)
    static let dark = Color(hex: 0x1A0033)
    static let darker = Color(hex: 0x12001F)
    static let card = Color(hex: 0x291050)
    static let ink = Color.white
    static let ink2 = Color.white.opacity(0.78)
    static let ink3 = Color.white.opacity(0.55)
    static let hair = Color.white.opacity(0.10)
    static let success = Color(hex: 0x49C06E)
    static let danger = Color(hex: 0xF0717A)

    /// Frosted purple background used app-wide (transparent-feeling, bright text).
    static var background: some View {
        LinearGradient(
            colors: [Color(hex: 0x250046), Mantu.darker],
            startPoint: .topLeading, endPoint: .bottomTrailing
        )
        .ignoresSafeArea()
    }
}

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: alpha
        )
    }
}

/// The Mantu "M" mark — two rounded, overlapping strokes (left lighter, right brighter).
struct MantuMark: View {
    var size: CGFloat = 26
    var body: some View {
        Canvas { ctx, rect in
            let w = rect.width
            func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x * w, y: y * w) }
            var left = Path()
            left.move(to: p(0.19, 0.78)); left.addLine(to: p(0.36, 0.25)); left.addLine(to: p(0.50, 0.55))
            var right = Path()
            right.move(to: p(0.50, 0.55)); right.addLine(to: p(0.64, 0.25)); right.addLine(to: p(0.81, 0.78))
            let style = StrokeStyle(lineWidth: w * 0.14, lineCap: .round, lineJoin: .round)
            ctx.stroke(left, with: .color(Color(hex: 0xB79CE6).opacity(0.85)), style: style)
            ctx.stroke(right, with: .color(Color(hex: 0xEFE7FB)), style: style)
        }
        .frame(width: size, height: size)
    }
}

/// Brand wordmark + tagline (used on onboarding / about).
struct MantuWordmark: View {
    var size: CGFloat = 30
    var tagline = true
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 0) {
                Text("M").foregroundStyle(Mantu.accent)
                Text("antu").foregroundStyle(Mantu.bright)
            }
            .font(.system(size: size, weight: .heavy, design: .rounded))
            if tagline {
                Text("AUDACIOUS IDEAS, DELIVERED BEYOND")
                    .font(.system(size: max(8, size * 0.3), weight: .semibold))
                    .tracking(2)
                    .foregroundStyle(Mantu.bright)
            }
        }
    }
}

/// Reusable rounded card with a faint hairline + purple glow.
struct CardModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(14)
            .background(Mantu.card.opacity(0.55), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Mantu.hair, lineWidth: 1))
            .shadow(color: Mantu.bright.opacity(0.18), radius: 14, y: 4)
    }
}
extension View { func mantuCard() -> some View { modifier(CardModifier()) } }
