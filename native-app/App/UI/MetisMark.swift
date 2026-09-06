import SwiftUI

/// The Métis mark — a goddess/owl constellation on a frosted tile, echoing the Electron app's product
/// glyph. Per the onboarding spec (Scene 1), the mark "draws itself from star-points": the connecting
/// lines stroke on with a `trim` sweep and each star fades in as the sweep reaches it. Pure SwiftUI — no
/// assets, no dependencies — so it scales crisply at any size and animates natively.
struct MetisMark: View {
    var size: CGFloat = 96
    var animated: Bool = true

    @State private var progress: CGFloat = 0

    // Symmetric constellation in unit space (0...1). Order matters: the shape draws edges in sequence so
    // the trim sweep reveals a coherent figure rather than random segments.
    private static let points: [CGPoint] = [
        CGPoint(x: 0.50, y: 0.12), // crown
        CGPoint(x: 0.28, y: 0.34), // left eye
        CGPoint(x: 0.72, y: 0.34), // right eye
        CGPoint(x: 0.50, y: 0.50), // heart
        CGPoint(x: 0.34, y: 0.72), // left wing
        CGPoint(x: 0.66, y: 0.72), // right wing
        CGPoint(x: 0.50, y: 0.86)  // base
    ]
    private static let edges: [(Int, Int)] = [
        (0, 1), (0, 2), (1, 2), (1, 3), (2, 3), (3, 4), (3, 5), (4, 6), (5, 6)
    ]

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.22, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [Color(red: 0.30, green: 0.20, blue: 0.55), Color(red: 0.16, green: 0.12, blue: 0.30)],
                        startPoint: .topLeading, endPoint: .bottomTrailing
                    )
                )
                .overlay(
                    RoundedRectangle(cornerRadius: size * 0.22, style: .continuous)
                        .strokeBorder(.white.opacity(0.12), lineWidth: 1)
                )
                .shadow(color: MetisTheme.accentGlow, radius: size * 0.18, y: size * 0.03)

            ConstellationEdges(points: Self.points, edges: Self.edges)
                .trim(from: 0, to: progress)
                .stroke(
                    LinearGradient(colors: [MetisTheme.accent2, .white.opacity(0.9)], startPoint: .top, endPoint: .bottom),
                    style: StrokeStyle(lineWidth: max(1.2, size * 0.02), lineCap: .round, lineJoin: .round)
                )
                .padding(size * 0.18)

            GeometryReader { geo in
                let inset = size * 0.18
                let rect = CGRect(x: inset, y: inset, width: geo.size.width - inset * 2, height: geo.size.height - inset * 2)
                ForEach(Array(Self.points.enumerated()), id: \.offset) { idx, p in
                    let threshold = CGFloat(idx) / CGFloat(Self.points.count)
                    Circle()
                        .fill(.white)
                        .frame(width: size * 0.055, height: size * 0.055)
                        .shadow(color: MetisTheme.accent2, radius: size * 0.03)
                        .position(x: rect.minX + p.x * rect.width, y: rect.minY + p.y * rect.height)
                        .opacity(progress >= threshold ? 1 : 0)
                        .scaleEffect(progress >= threshold ? 1 : 0.4)
                        .animation(.spring(duration: 0.35), value: progress >= threshold)
                }
            }
            .padding(0)
        }
        .frame(width: size, height: size)
        .onAppear {
            if animated {
                withAnimation(.easeInOut(duration: 1.4)) { progress = 1 }
            } else {
                progress = 1
            }
        }
        .accessibilityHidden(true)
    }
}

/// The constellation's connecting lines as a single trimmable path (unit points scaled into the frame).
private struct ConstellationEdges: Shape {
    let points: [CGPoint]
    let edges: [(Int, Int)]
    func path(in rect: CGRect) -> Path {
        var path = Path()
        for (a, b) in edges {
            let pa = CGPoint(x: rect.minX + points[a].x * rect.width, y: rect.minY + points[a].y * rect.height)
            let pb = CGPoint(x: rect.minX + points[b].x * rect.width, y: rect.minY + points[b].y * rect.height)
            path.move(to: pa)
            path.addLine(to: pb)
        }
        return path
    }
}

#Preview {
    ZStack { MetisBackground(); MetisMark(size: 120) }
        .frame(width: 300, height: 300)
}
