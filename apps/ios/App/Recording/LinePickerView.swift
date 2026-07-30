import SwiftUI
import TrackEvolutionKit

/// Pick the start/finish line by tapping the driven trace.
///
/// A live recording has no lap markers (`needsLine: true`), so this is how a
/// recording becomes laps: tap a point, `Geo.buildGate` builds a gate
/// perpendicular to the direction of travel there, and every pass across it is
/// timed. The lap list updates on each tap, so a bad pick is obvious at once.
///
/// Pan and zoom are a deliberate improvement on the web version, where the touch
/// target for a pick is tiny.
struct LinePickerView: View {
    let trace: [Geo.Projected]
    /// The picked trace index, owned by the caller so the laps live alongside it.
    @Binding var pickedIndex: Int?

    @State private var scale: Double = 1
    @State private var committedScale: Double = 1
    @State private var pan: CGSize = .zero
    @State private var committedPan: CGSize = .zero

    var body: some View {
        GeometryReader { geometry in
            let map = TraceMap(
                trace: trace,
                width: geometry.size.width,
                height: geometry.size.height,
                scale: scale,
                panX: pan.width,
                panY: pan.height
            )

            ZStack {
                Canvas { context, _ in
                    guard let map else { return }
                    draw(trace: trace, map: map, in: &context)
                }
                .contentShape(.rect)
                .gesture(pickGesture(map: map))
                .simultaneousGesture(panGesture)
                .simultaneousGesture(zoomGesture)

                if scale > 1.01 || pan != .zero {
                    resetButton
                }
            }
            // A tappable canvas is invisible to VoiceOver without this, and the
            // identifier is what the UI test taps (styled text can't be matched by
            // string — `.eyebrow` uppercases it).
            .accessibilityElement()
            .accessibilityIdentifier("linePickerMap")
            .accessibilityLabel("Driven trace")
            .accessibilityHint("Tap to place the start/finish line")
            .accessibilityAddTraits(.isButton)
        }
        .background(Color(.bgSubtle), in: .rect(cornerRadius: TERadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: TERadius.md)
                .strokeBorder(Color(.borderHairline), lineWidth: 1)
        )
    }

    // MARK: - Drawing

    private func draw(trace: [Geo.Projected], map: TraceMap, in context: inout GraphicsContext) {
        var path = Path()
        for (i, point) in trace.enumerated() {
            let view = map.viewPoint(point)
            let cgPoint = CGPoint(x: view.x, y: view.y)
            if i == 0 { path.move(to: cgPoint) } else { path.addLine(to: cgPoint) }
        }
        // The driven line, in the map's tarmac token — the trace is the road here,
        // not data, so it reads as surface rather than as a chart series.
        context.stroke(path, with: .color(Color(.mapTarmac)), lineWidth: 3)

        guard let pickedIndex, trace.indices.contains(pickedIndex),
              let gate = Geo.buildGate(trace, idx: pickedIndex)
        else { return }

        let segment = map.viewSegment(for: gate)
        var gatePath = Path()
        gatePath.move(to: CGPoint(x: segment.from.x, y: segment.from.y))
        gatePath.addLine(to: CGPoint(x: segment.to.x, y: segment.to.y))
        context.stroke(gatePath, with: .color(Color(.accent)), lineWidth: 3)

        let centre = map.viewPoint(trace[pickedIndex])
        let dot = CGRect(x: centre.x - 5, y: centre.y - 5, width: 10, height: 10)
        context.fill(Circle().path(in: dot), with: .color(Color(.accent)))
    }

    private var resetButton: some View {
        VStack {
            HStack {
                Spacer()
                Button("Reset view") {
                    withAnimation(TEMotion.standard) {
                        scale = 1
                        committedScale = 1
                        pan = .zero
                        committedPan = .zero
                    }
                }
                .teStyle(.xs)
                .foregroundStyle(Color(.textBody))
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Color(.surfaceRaised), in: .capsule)
                .padding(8)
            }
            Spacer()
        }
    }

    // MARK: - Gestures

    private func pickGesture(map: TraceMap?) -> some Gesture {
        SpatialTapGesture()
            .onEnded { value in
                guard let map,
                      let index = map.nearestIndex(
                          to: value.location.x, viewY: value.location.y, in: trace
                      )
                else { return }
                pickedIndex = index
                // A pick that can't make a gate is reported by the caller, which
                // knows the wording; the tick just confirms the tap landed.
                Haptics.select()
            }
    }

    private var panGesture: some Gesture {
        DragGesture()
            .onChanged { value in
                pan = CGSize(
                    width: committedPan.width + value.translation.width,
                    height: committedPan.height + value.translation.height
                )
            }
            .onEnded { _ in committedPan = pan }
    }

    private var zoomGesture: some Gesture {
        MagnifyGesture()
            .onChanged { value in
                scale = min(max(committedScale * value.magnification, 1), 12)
            }
            .onEnded { _ in committedScale = scale }
    }
}
