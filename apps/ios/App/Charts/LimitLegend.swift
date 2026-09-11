import SwiftUI
import TrackEvolutionKit

/// The track map's limit legend (#188) — the counterpart of the `limit-legend`
/// row in `viewEvent` (`public/app.js`).
///
/// One entry per kind actually marked on this lap, drawn with the same shape and
/// fill rule `TrackMapView` uses, so the glyph on the map is matched by eye
/// rather than by memory. Nothing renders when the lap hit no limits — an empty
/// legend would imply the marks exist and are hiding somewhere.
///
/// It says "on this lap" for a reason: the stored trace is the **best lap only**,
/// so these marks are that lap's and not the session's.
struct LimitLegend: View {
    let markers: [Limits.Marker]

    private var kinds: [Limits.Kind] {
        Limits.LIMIT_KINDS.filter { kind in markers.contains { $0.kind == kind.key } }
    }

    var body: some View {
        let present = kinds
        if !present.isEmpty {
            // Wraps rather than scrolls: five kinds of two words each will not fit
            // one phone line, and a legend you have to scroll is not a legend.
            FlowRow(spacing: 12) {
                Text("At the limit on this lap:")
                    .teStyle(.xxs)
                    .foregroundStyle(Color(.textFaint))
                ForEach(present, id: \.key) { kind in
                    HStack(spacing: 5) {
                        LimitGlyph(kind: kind)
                        Text(kind.label)
                            .teStyle(.xxs)
                            .foregroundStyle(Color(.textMuted))
                    }
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(
                "At the limit on this lap: " + present.map(\.label).joined(separator: ", ")
            )
        }
    }
}

/// One kind's marker at legend size: the same shape and fill rule the map draws.
struct LimitGlyph: View {
    let kind: Limits.Kind

    var body: some View {
        let color = LapChannelPanel.color(kind.side)
        shape
            .fill(kind.filled ? color : Color(.surfaceCard))
            .overlay(shape.stroke(color, lineWidth: 1.6))
            .frame(width: 11, height: 11)
    }

    private var shape: AnyShape {
        switch kind.shape {
        case .circle: AnyShape(Circle())
        case .triangle: AnyShape(TriangleGlyph())
        case .diamond: AnyShape(DiamondGlyph())
        }
    }
}

private struct TriangleGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.midX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
        path.closeSubpath()
        return path
    }
}

private struct DiamondGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.midX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
        path.addLine(to: CGPoint(x: rect.midX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.midY))
        path.closeSubpath()
        return path
    }
}

/// A minimal wrapping row.
///
/// `Layout` rather than a `LazyVGrid`: the entries are different widths ("ABS"
/// against "Stability control"), and a grid would column them to the widest,
/// leaving a legend mostly of gaps.
struct FlowRow: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: proposal.width ?? x, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
