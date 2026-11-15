import MapKit
import SwiftUI
import TrackEvolutionKit
import UIKit

/// The racing line on a real map (NS-53 ticket 2): a session's best lap, or a
/// leaderboard lap, laid over Apple's satellite imagery where the driver can
/// pan, pinch, rotate and tap the line to read the speed there.
///
/// The port of `bindMapViewer` in `public/js/map-viewer.js`; the decisions are
/// the Kit's `MapViewer` and `Geo`, shared word for word with the web. Three
/// rules shape it, as there:
///
/// - **The line never depends on the map.** No anchor, or MapKit failing to
///   load (offline with nothing cached), leaves the viewer on the drawn line
///   (`TrackMapView`) with one sentence saying why.
/// - **The device's own position is never asked for or shown.** No
///   `showsUserLocation`, no location permission.
/// - **A pushed page, never a sheet**, owning its gestures outright: a map
///   inside a scrolling page fights the page for every drag.
///
/// The map is an `MKMapView` in a `UIViewRepresentable` rather than SwiftUI's
/// `Map`, for per-segment colour, a fit with padding, a zoom range, and the
/// tap's screen-to-coordinate conversion.
struct TrackMapScreen: View {
    let source: TrackMapSource
    /// A line drawn without a server — DEBUG's `-trackMap` only.
    var preset: TrackMapModel.Line? = nil

    @Environment(AuthController.self) private var auth
    @Environment(\.logbookOwner) private var owner
    @Environment(\.unitSystem) private var units
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage(MapViewer.MAP_TYPE_KEY) private var storedType = MapViewer.DEFAULT_MAP_TYPE.rawValue

    @State private var model: TrackMapModel?
    /// MapKit reported it could not load the map — offline with no tiles cached.
    @State private var loadFailed = false
    @State private var hit: Geo.TraceHit?
    /// Bumped by *Fit*; the map re-fits whenever it changes.
    @State private var fitRequest = 0

    var body: some View {
        TELoadable(state: model?.state ?? .loading, retry: { await model?.load() }) {
            if let line = model?.line {
                content(line)
            }
        }
        .background(Color(.bgPage))
        .navigationTitle(model?.line?.title ?? "Map")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if model == nil {
                let model = TrackMapModel(api: auth.api.scoped(to: owner), source: source, preset: preset)
                self.model = model
                if preset == nil { await model.load() }
            }
        }
    }

    // MARK: - Layout

    private func plan(_ line: TrackMapModel.Line) -> MapViewer.Plan {
        MapViewer.viewerPlan(geo: line.geo, loadFailed: loadFailed)
    }

    private func type(_ plan: MapViewer.Plan) -> MapViewer.MapType {
        MapViewer.startType(plan, MapViewer.mapType(fromStored: storedType))
    }

    private func content(_ line: TrackMapModel.Line) -> some View {
        let plan = plan(line)
        let type = type(plan)
        return VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                Text(line.sub)
                    .teStyle(.sm)
                    .foregroundStyle(Color(.textMuted))
                if let note = plan.note {
                    Text(note)
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textMuted))
                        .accessibilityIdentifier("trackMapNote")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, TESpacing.pageGutter)
            .padding(.vertical, 8)

            stage(line, type: type)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(TrackMapView.label(line.markers)), \(type.label)")
                .accessibilityValue(hit.map { readout(line, $0) } ?? TrackMapView.summary(line.trace, line.markers, units: units))
                .accessibilityAdjustableAction { direction in
                    step(line, direction == .increment ? 1 : -1)
                }
                .accessibilityIdentifier("trackMapStage")

            bar(plan, type: type)
        }
    }

    @ViewBuilder
    private func stage(_ line: TrackMapModel.Line, type: MapViewer.MapType) -> some View {
        ZStack(alignment: .top) {
            if type == .line || line.geo == nil {
                VStack(spacing: 10) {
                    TrackMapView(trace: line.trace, markers: line.markers, highlight: hit?.idx)
                    LimitLegend(markers: line.markers)
                }
                .padding(TESpacing.pageGutter)
            } else if let geo = line.geo {
                MapLineView(
                    trace: line.trace,
                    geo: geo,
                    mapType: type,
                    markers: line.markers,
                    hit: hit,
                    fitRequest: fitRequest,
                    animateFit: !reduceMotion,
                    onTap: { hit = $0 },
                    onLoadFailed: { loadFailed = true }
                )
                .ignoresSafeArea(edges: .horizontal)
            }
            if let hit {
                Text(readout(line, hit))
                    .teStyle(.bodyStrong)
                    .monospacedDigit()
                    .foregroundStyle(Color(.textStrong))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(Color(.surfaceCard), in: .capsule)
                    .overlay(Capsule().strokeBorder(Color(.borderHairline), lineWidth: 1))
                    .padding(.top, 10)
                    .allowsHitTesting(false)
                    .accessibilityIdentifier("trackMapReadout")
            }
        }
    }

    /// The map types, the ones this plan can't offer disabled, and *Fit*. Below
    /// the map, so nothing covers MapKit's logo and legal link.
    private func bar(_ plan: MapViewer.Plan, type: MapViewer.MapType) -> some View {
        HStack(spacing: 12) {
            HStack(spacing: 0) {
                ForEach(MapViewer.MAP_TYPES, id: \.self) { option in
                    let on = plan.types.contains(option)
                    Button {
                        storedType = option.rawValue
                        hit = nil
                    } label: {
                        Text(option.label)
                            .teStyle(.sm)
                            .foregroundStyle(option == type ? Color(.textStrong) : Color(.textMuted))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 7)
                            .background(option == type ? Color(.surfaceRaised) : .clear, in: .rect(cornerRadius: TERadius.sm))
                    }
                    .buttonStyle(.plain)
                    .disabled(!on)
                    .opacity(on ? 1 : 0.4)
                    .accessibilityAddTraits(option == type ? .isSelected : [])
                    .accessibilityIdentifier("mapType-\(option.rawValue)")
                }
            }
            .padding(3)
            .background(Color(.surfaceCard), in: .rect(cornerRadius: TERadius.md))
            .overlay(RoundedRectangle(cornerRadius: TERadius.md).strokeBorder(Color(.borderHairline), lineWidth: 1))
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Map type")

            Spacer(minLength: 0)

            if type != .line {
                Button {
                    fitRequest += 1
                } label: {
                    Label("Fit", systemImage: "scope")
                        .teStyle(.sm)
                        .foregroundStyle(Color(.textStrong))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(Color(.surfaceCard), in: .rect(cornerRadius: TERadius.md))
                        .overlay(RoundedRectangle(cornerRadius: TERadius.md).strokeBorder(Color(.borderHairline), lineWidth: 1))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Fit the line")
                .accessibilityIdentifier("trackMapFit")
            }
        }
        .padding(.horizontal, TESpacing.pageGutter)
        .padding(.vertical, 10)
        .background(Color(.bgPage))
    }

    // MARK: - The read-out

    private func readout(_ line: TrackMapModel.Line, _ hit: Geo.TraceHit) -> String {
        MapViewer.readoutText(MapViewer.placeAt(hit, speed: line.speed, dStepM: line.dStepM), units)
    }

    /// VoiceOver's *Next point / Previous point*: 5 % of the lap a step.
    private func step(_ line: TrackMapModel.Line, _ sign: Double) {
        let from = hit?.frac ?? (sign > 0 ? -MapViewer.STEP_FRAC : 1 + MapViewer.STEP_FRAC)
        hit = MapViewer.hitAtFraction(line.trace, max(0, min(1, from + sign * MapViewer.STEP_FRAC)))
    }
}

// MARK: - Model

/// The one line the viewer draws, read from the cache the page behind it
/// already filled — so it opens offline, on the line, without imagery.
@MainActor
@Observable
final class TrackMapModel {
    struct Line {
        var title: String
        var sub: String
        var trace: [TracePoint]
        var geo: TraceGeo?
        /// The traced lap's own speed channel (stored km/h) for the read-out.
        var speed: [Double]?
        var dStepM: Double?
        var markers: [Limits.Marker]
    }

    private let api: APIClient
    let source: TrackMapSource
    private(set) var state: LoadState = .loading
    private(set) var line: Line?

    init(api: APIClient, source: TrackMapSource, preset: Line? = nil) {
        self.api = api
        self.source = source
        if let preset {
            line = preset
            state = .ready
        }
    }

    func load() async {
        do {
            switch source {
            case .session(let eventId, let sessionId):
                let detail = try await api.event(id: eventId)
                line = Self.sessionLine(detail, sessionId: sessionId)
            case .leaderboardLap(let trackId, let lapId):
                let lap = try await api.leaderboardLap(trackId: trackId, lapId: lapId)
                let tracks = (try? await api.tracks()) ?? []
                line = Self.leaderboardLine(lap, trackName: tracks.first { $0.id == trackId }?.name)
            }
            state = line == nil ? .failed("This lap has no racing line to map.", retryable: false) : .ready
        } catch let error as APIError {
            state = .failed(error.message)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    /// The session's best lap — the only lap a session stores a line for —
    /// with its channel entry for the read-out and the limit marks.
    static func sessionLine(_ detail: EventDetail, sessionId: Int) -> Line? {
        guard let session = detail.sessions.first(where: { $0.id == sessionId }),
              let trace = session.trace, trace.count >= 10,
              let best = session.laps.min(by: { $0.timeMs < $1.timeMs })
        else { return nil }
        var entry: LapChannels?
        if let channels = session.channels, !channels.laps.isEmpty {
            let row = ChannelGraphs.matchLapsToChannels(session.laps, channels.laps)
                .first { $0.hasChannels && $0.lap.id == best.id }
            entry = row.map { channels.laps[$0.chIdx] }
        }
        return Line(
            title: detail.event.trackName,
            sub: "\(LapTime.fmtMs(best.timeMs)) · \(EventDates.fmtDate(detail.event.startDate))",
            trace: trace,
            geo: session.traceGeo,
            speed: entry?.speed,
            dStepM: session.channels?.dStepM,
            markers: EventScreen.limitMarkers(session)
        )
    }

    static func leaderboardLine(_ lap: LeaderboardLap, trackName: String?) -> Line? {
        guard let trace = lap.trace, trace.count >= 10 else { return nil }
        let markers = lap.entry.flatMap { entry in
            lap.channels.map { Limits.limitMarkers(entry, $0.dStepM, trace) }
        } ?? []
        return Line(
            title: trackName ?? "Leaderboard lap",
            sub: "\(LapTime.fmtMs(lap.timeMs)) · \(lap.you ? "your lap" : (lap.name ?? "Driver"))",
            trace: trace,
            geo: lap.traceGeo,
            speed: lap.entry?.speed,
            dStepM: lap.channels?.dStepM,
            markers: markers
        )
    }
}

#if DEBUG
extension TrackMapScreen {
    /// `-trackMap`: the viewer on a synthetic lap anchored at VIR, no server —
    /// `-trackMapApprox` marks the anchor estimated, `-trackMapNoAnchor` drops it.
    ///   xcrun simctl launch <device> app.trackevolution -trackMap
    static var demo: some View {
        let args = ProcessInfo.processInfo.arguments
        let trace: [TracePoint] = (0..<120).map { i in
            let a = Double(i) / 119 * 2 * .pi
            let slow = sin(a) > 0.6
            let r = slow ? 180.0 : 420
            return TracePoint(x: r * sin(a), y: 300 - r * cos(a), v: slow ? 18 + Double(i) * 0.1 : 52 - Double(i % 7) * 2.5)
        }
        var geo: TraceGeo? = TraceGeo(lat: 36.5607123, lon: -79.2064456)
        if args.contains("-trackMapApprox") { geo?.approx = true }
        if args.contains("-trackMapNoAnchor") { geo = nil }
        let line = TrackMapModel.Line(
            title: "VIR (Full)", sub: "2:02.110 · Sample", trace: trace, geo: geo,
            speed: (0..<200).map { 100 + 80 * sin(Double($0) / 15) }, dStepM: 20, markers: []
        )
        return NavigationStack {
            TrackMapScreen(source: .session(eventId: 0, sessionId: 0), preset: line)
        }
    }
}
#endif

// MARK: - The map

/// An `MKMapView` drawing one speed-painted line over a dark casing, with the
/// start/finish, the direction of travel, the limit marks and the tapped
/// point. No pitch, no user location; rotation on, with the compass MapKit
/// shows once the map is turned.
private struct MapLineView: UIViewRepresentable {
    let trace: [TracePoint]
    let geo: TraceGeo
    let mapType: MapViewer.MapType
    let markers: [Limits.Marker]
    let hit: Geo.TraceHit?
    let fitRequest: Int
    let animateFit: Bool
    let onTap: (Geo.TraceHit?) -> Void
    let onLoadFailed: () -> Void

    @Environment(\.colorScheme) private var scheme

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> FittingMapView {
        let map = FittingMapView()
        map.delegate = context.coordinator
        map.isPitchEnabled = false
        map.isRotateEnabled = true
        map.showsUserLocation = false
        map.showsCompass = true
        map.showsScale = true
        map.pointOfInterestFilter = .excludingAll
        let coordinator = context.coordinator
        coordinator.map = map
        map.onFirstLayout = { [weak coordinator] in coordinator?.fit(animated: false, initial: true) }

        let tap = UITapGestureRecognizer(target: coordinator, action: #selector(Coordinator.tapped(_:)))
        // A double tap zooms, as MapKit has it; it must not also drop a dot.
        for view in [map] + map.subviews {
            for other in view.gestureRecognizers ?? [] {
                if let double = other as? UITapGestureRecognizer, double.numberOfTapsRequired == 2 {
                    tap.require(toFail: double)
                }
            }
        }
        map.addGestureRecognizer(tap)
        return map
    }

    func updateUIView(_ map: FittingMapView, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self
        map.overrideUserInterfaceStyle = scheme == .dark ? .dark : .light
        let wanted: MKMapType = mapType == .standard ? .standard : .satellite
        if map.mapType != wanted { map.mapType = wanted }
        if coordinator.drawnTrace != trace || coordinator.drawnScheme != scheme {
            coordinator.draw(trace: trace, geo: geo, markers: markers, scheme: scheme)
        }
        coordinator.showHit(hit)
        if coordinator.fitRequest != fitRequest {
            coordinator.fitRequest = fitRequest
            coordinator.fit(animated: animateFit, initial: false)
        }
    }

    // MARK: Coordinator

    @MainActor
    final class Coordinator: NSObject, MKMapViewDelegate {
        var parent: MapLineView?
        weak var map: FittingMapView?
        var drawnTrace: [TracePoint]?
        var drawnScheme: ColorScheme?
        var fitRequest = 0
        private var casing: MKPolyline?
        private var colours: [ObjectIdentifier: UIColor] = [:]
        private var arrow: LineMark?
        private var tapMark: LineMark?
        private var shownHit: Geo.TraceHit?

        /// The line's coordinates.
        private var coords: [CLLocationCoordinate2D] = []

        func draw(trace: [TracePoint], geo: TraceGeo, markers: [Limits.Marker], scheme: ColorScheme) {
            guard let map else { return }
            drawnTrace = trace
            drawnScheme = scheme
            map.removeOverlays(map.overlays)
            map.removeAnnotations(map.annotations)
            colours = [:]
            tapMark = nil
            shownHit = nil
            coords = Geo.unprojectTrace(trace, geo).map { CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lon) }
            guard coords.count > 1 else { return }

            // The casing first, so the speed colours read on pale concrete and
            // dark trees alike; then one overlay per run of one colour —
            // `speedRuns`, so every client colours the same metres the same.
            let casing = MKPolyline(coordinates: coords, count: coords.count)
            self.casing = casing
            var overlays: [any MKOverlay] = [casing]
            let traits = UITraitCollection(userInterfaceStyle: scheme == .dark ? .dark : .light)
            let slow = UIColor(resource: .mapSlow).resolvedColor(with: traits)
            let fast = UIColor(resource: .mapFast).resolvedColor(with: traits)
            for run in Geo.speedRuns(trace, buckets: MapViewer.SPEED_BUCKETS) {
                let slice = Array(coords[run.from...run.to])
                let polyline = MKPolyline(coordinates: slice, count: slice.count)
                colours[ObjectIdentifier(polyline)] = Self.mix(
                    slow, fast, MapViewer.rampFraction(run.bucket, MapViewer.SPEED_BUCKETS)
                )
                overlays.append(polyline)
            }
            map.addOverlays(overlays, level: .aboveRoads)

            var annotations: [any MKAnnotation] = [LineMark(.startFinish, coords[0], title: "Start/finish")]
            // The way round, a little past the line.
            let ai = min(trace.count - 2, max(1, Int((Double(trace.count) * 0.04).rounded())))
            let arrow = LineMark(.arrow(MapViewer.headingDeg(trace, ai)), coords[ai], title: "Direction of travel")
            self.arrow = arrow
            annotations.append(arrow)
            for marker in markers where coords.indices.contains(marker.idx) {
                guard let kind = Limits.kindDef(marker.kind) else { continue }
                annotations.append(LineMark(.limit(kind), coords[marker.idx], title: kind.label))
            }
            map.addAnnotations(annotations)
        }

        /// The initial camera — the trace's bounds, north up, 48 pt of padding —
        /// and, the first time, the zoom range: out to twice the fitted span.
        func fit(animated: Bool, initial: Bool) {
            guard let map, let casing, map.bounds.width > 0 else { return }
            let pad = MapViewer.FIT_PADDING_PX
            let insets = UIEdgeInsets(top: pad, left: pad, bottom: pad, right: pad)
            // North up first: a visible rect is fitted in the camera's own frame,
            // so a turned map would fit the line turned.
            if map.camera.heading != 0 {
                let camera = map.camera.copy() as! MKMapCamera
                camera.heading = 0
                map.setCamera(camera, animated: false)
            }
            map.setVisibleMapRect(casing.boundingMapRect, edgePadding: insets, animated: animated && !initial)
            if initial {
                // Out to twice the fitted span; in, as far as the provider goes.
                let fitted = map.camera.centerCoordinateDistance
                map.cameraZoomRange = MKMapView.CameraZoomRange(maxCenterCoordinateDistance: fitted * 2)
            }
        }

        func showHit(_ hit: Geo.TraceHit?) {
            guard let map, hit != shownHit else { return }
            shownHit = hit
            if let tapMark { map.removeAnnotation(tapMark) }
            tapMark = nil
            guard let hit, let parent, let trace = drawnTrace else { return }
            // The point on the line, not the vertex: between two fixes on a
            // straight the nearer vertex can be tens of metres off.
            let p = MapViewer.pointAlong(trace, hit.alongM)
            let at = Geo.unprojectTrace([TracePoint(x: p.x, y: p.y, v: 0)], parent.geo)[0]
            let mark = LineMark(.tap, CLLocationCoordinate2D(latitude: at.lat, longitude: at.lon), title: "Selected point")
            tapMark = mark
            map.addAnnotation(mark)
        }

        @objc func tapped(_ gesture: UITapGestureRecognizer) {
            guard let map, let parent else { return }
            let point = gesture.location(in: map)
            let c = map.convert(point, toCoordinateFrom: map)
            // Metres per screen point here, measured across 100 points.
            let a = map.convert(CGPoint(x: point.x - 50, y: point.y), toCoordinateFrom: map)
            let b = map.convert(CGPoint(x: point.x + 50, y: point.y), toCoordinateFrom: map)
            let metresPerPx = MKMapPoint(a).distance(to: MKMapPoint(b)) / 100
            parent.onTap(MapViewer.tapHit(parent.trace, parent.geo, c.latitude, c.longitude, metresPerPx))
        }

        // MARK: MKMapViewDelegate

        func mapView(_ mapView: MKMapView, rendererFor overlay: any MKOverlay) -> MKOverlayRenderer {
            guard let polyline = overlay as? MKPolyline else { return MKOverlayRenderer(overlay: overlay) }
            let renderer = MKPolylineRenderer(polyline: polyline)
            renderer.lineCap = .round
            renderer.lineJoin = .round
            if polyline === casing {
                renderer.strokeColor = UIColor(red: 10 / 255, green: 10 / 255, blue: 11 / 255, alpha: 0.6)
                renderer.lineWidth = 7
            } else {
                renderer.strokeColor = colours[ObjectIdentifier(polyline)] ?? .white
                renderer.lineWidth = 5
            }
            return renderer
        }

        func mapView(_ mapView: MKMapView, viewFor annotation: any MKAnnotation) -> MKAnnotationView? {
            guard let mark = annotation as? LineMark else { return nil }
            let view = MKAnnotationView(annotation: mark, reuseIdentifier: nil)
            view.canShowCallout = false
            view.isEnabled = false
            view.image = mark.image(heading: mapView.camera.heading)
            view.zPriority = mark.kind.isTap ? .max : .defaultSelected
            return view
        }

        func mapView(_ mapView: MKMapView, regionDidChangeAnimated animated: Bool) {
            // The arrow is drawn for a north-up map; turn it with the camera.
            guard let arrow, let view = mapView.view(for: arrow) else { return }
            view.image = arrow.image(heading: mapView.camera.heading)
        }

        func mapViewDidFailLoadingMap(_ mapView: MKMapView, withError error: any Error) {
            parent?.onLoadFailed()
        }

        static func mix(_ a: UIColor, _ b: UIColor, _ t: Double) -> UIColor {
            var (r1, g1, b1, a1): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
            var (r2, g2, b2, a2): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
            a.getRed(&r1, green: &g1, blue: &b1, alpha: &a1)
            b.getRed(&r2, green: &g2, blue: &b2, alpha: &a2)
            let t = CGFloat(t)
            return UIColor(red: r1 + (r2 - r1) * t, green: g1 + (g2 - g1) * t, blue: b1 + (b2 - b1) * t, alpha: a1 + (a2 - a1) * t)
        }
    }
}

/// An `MKMapView` that says when it first has a size, so the first camera can
/// fit the line rather than land on MapKit's default region.
final class FittingMapView: MKMapView {
    var onFirstLayout: (() -> Void)?

    override func layoutSubviews() {
        super.layoutSubviews()
        if bounds.width > 0, let once = onFirstLayout {
            onFirstLayout = nil
            once()
        }
    }
}

/// A mark on the map line: the start/finish tick, the direction arrow, a limit
/// mark, or the tapped point.
private final class LineMark: NSObject, MKAnnotation {
    enum Kind {
        case startFinish
        case arrow(Double)
        case limit(Limits.Kind)
        case tap

        var isTap: Bool { if case .tap = self { true } else { false } }
    }

    let kind: Kind
    let coordinate: CLLocationCoordinate2D
    let title: String?

    init(_ kind: Kind, _ coordinate: CLLocationCoordinate2D, title: String) {
        self.kind = kind
        self.coordinate = coordinate
        self.title = title
    }

    @MainActor
    func image(heading: CLLocationDirection) -> UIImage {
        switch kind {
        case .startFinish:
            return Self.label("S/F")
        case .arrow(let deg):
            return Self.arrow(rotation: (deg - heading) * .pi / 180)
        case .limit(let kind):
            let color: UIColor = switch kind.side {
            case .brake: UIColor(resource: .limitBrake)
            case .power: UIColor(resource: .limitPower)
            case .stability: UIColor(resource: .textStrong)
            }
            return Self.dot(diameter: 13, fill: kind.filled ? color : .white, ring: kind.filled ? .white : color)
        case .tap:
            return Self.dot(diameter: 16, fill: UIColor(resource: .accent), ring: .white)
        }
    }

    private static func dot(diameter: CGFloat, fill: UIColor, ring: UIColor) -> UIImage {
        let size = CGSize(width: diameter + 4, height: diameter + 4)
        return UIGraphicsImageRenderer(size: size).image { ctx in
            let rect = CGRect(x: 2, y: 2, width: diameter, height: diameter)
            ring.setStroke()
            fill.setFill()
            let path = UIBezierPath(ovalIn: rect)
            path.lineWidth = 2.5
            path.fill()
            path.stroke()
            _ = ctx
        }
    }

    private static func label(_ text: String) -> UIImage {
        let font = UIFont.systemFont(ofSize: 11, weight: .bold)
        let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: UIColor.white]
        let textSize = (text as NSString).size(withAttributes: attrs)
        let size = CGSize(width: textSize.width + 10, height: textSize.height + 4)
        return UIGraphicsImageRenderer(size: size).image { _ in
            UIColor(red: 10 / 255, green: 10 / 255, blue: 11 / 255, alpha: 0.85).setFill()
            UIBezierPath(roundedRect: CGRect(origin: .zero, size: size), cornerRadius: 4).fill()
            (text as NSString).draw(at: CGPoint(x: 5, y: 2), withAttributes: attrs)
        }
    }

    private static func arrow(rotation: Double) -> UIImage {
        let side: CGFloat = 22
        return UIGraphicsImageRenderer(size: CGSize(width: side, height: side)).image { ctx in
            let c = ctx.cgContext
            c.translateBy(x: side / 2, y: side / 2)
            c.rotate(by: CGFloat(rotation))
            let path = UIBezierPath()
            path.move(to: CGPoint(x: 0, y: -8))
            path.addLine(to: CGPoint(x: 6.5, y: 6))
            path.addLine(to: CGPoint(x: 0, y: 3))
            path.addLine(to: CGPoint(x: -6.5, y: 6))
            path.close()
            UIColor.white.setFill()
            UIColor(red: 10 / 255, green: 10 / 255, blue: 11 / 255, alpha: 0.8).setStroke()
            path.lineWidth = 1.5
            path.fill()
            path.stroke()
        }
    }
}

// MARK: - The door

/// The track map card's expand control (NS-53): opens the line on a real map.
/// Hidden on a shared page, whose readers never get the anchor.
struct OpenOnMapButton: View {
    let route: Route
    /// When set, called instead of pushing — a page presented as a sheet
    /// closes itself first.
    var onOpen: ((Route) -> Void)?

    @Environment(AppRouter.self) private var router
    @Environment(\.logbookOwner) private var owner
    @Environment(\.layout) private var layout

    var body: some View {
        Button {
            let target = owner.link(route)
            if let onOpen { onOpen(target) } else { router.push(target, at: layout.layoutClass) }
        } label: {
            Image(systemName: "arrow.up.left.and.arrow.down.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color(.textMuted))
                .frame(width: 32, height: 28)
                .background(Color(.surfaceRaised), in: .rect(cornerRadius: TERadius.sm))
                .overlay(RoundedRectangle(cornerRadius: TERadius.sm).strokeBorder(Color(.borderHairline), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open on a map")
        .accessibilityIdentifier("openOnMap")
    }
}
