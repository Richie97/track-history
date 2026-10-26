import AVFoundation
import QuartzCore
import SwiftUI
import TrackEvolutionKit

/// The one driven distance every chart, the map and the now-strip mark (NS-51).
///
/// Its own small observable rather than a property of the stage model, and that
/// is the performance rule: `LapChannelPanel` holds a reference to this and
/// **only its overlays read `mark`**, so a frame redraws a line and a few dots
/// while the traces — hundreds of marks per lap — are never asked to re-render
/// because the playhead moved.
@MainActor
@Observable
final class LapPlayhead {
    struct Mark: Equatable {
        /// Where the line goes: side A's grid index, on the panel's grid.
        var k: Double
        /// A dot per side on its own trace, keyed by the panel's channel-lap
        /// index — the same place in *Same place*, each side's own place in
        /// *Same time*, so the gap shows as two dots apart.
        var dots: [Int: Double]
    }

    /// nil out of the lap (or with no stage): nothing is drawn and the
    /// read-outs go back to what a tap parked.
    var mark: Mark?
}

/// One lap on the stage, as the page that hosts the stage describes it.
struct StageSideInput: Equatable {
    var key: VideoSync.SideKey
    /// The lap's stored channel entry — for a cross-event pair, the aligned one.
    var entry: LapChannels
    var dStepM: Double
    /// A clip this viewer may play (the tier is the host's to decide), or nil:
    /// the side replays on the map.
    var clip: LapClip?
    /// Where the entry sits in the panel's channels, for the playhead's dots.
    var chIdx: Int
    var lapNum: Int
    var timeMs: Int
    var isBest: Bool

    /// "Lap 5 · 2:19.812 ★" — the slot's chip.
    var chip: String {
        "Lap \(String(lapNum)) · \(LapTime.fmtMs(timeMs))\(isBest ? " ★" : "")"
    }
}

/// A side's video: the player, and whether it can play yet.
@MainActor
@Observable
final class StageVideo {
    enum Status: Equatable {
        case loading
        case ready
        /// The words the slot says over its replay — today's player's.
        case failed(String)
    }

    let clip: LapClip
    fileprivate(set) var player: AVPlayer?
    fileprivate(set) var status: Status = .loading
    /// Whether this player is the clock right now: playing, and the master.
    @ObservationIgnored fileprivate var isDriving = false
    @ObservationIgnored fileprivate var seeking = false
    @ObservationIgnored fileprivate var retried = false
    @ObservationIgnored fileprivate var lastRateAt: CFTimeInterval = 0
    @ObservationIgnored fileprivate var statusObservation: NSKeyValueObservation?

    init(clip: LapClip) {
        self.clip = clip
    }

    var isReady: Bool { status == .ready }
}

/// The lap stage's engine (NS-51): up to two sides, their players, the sync
/// mode, which side is the master, and the master's elapsed time — the clock
/// every other thing on the page is read from.
///
/// The maths is the Kit's `VideoSync` (pinned to the web by
/// `contracts/logic/video-sync.json`); this is the part that owns AVFoundation.
///
/// **One clock, two sources.** A display link ticks while playing; each tick
/// takes the master's time from its player when the master video is playing,
/// else advances by the wall clock (replay, or the master out of its clip). The
/// web's `requestAnimationFrame` over `currentTime`, and the same seam the spec
/// asks for: the panel can't tell a video clock from a replay one.
@MainActor
@Observable
final class LapStageModel {
    let playhead = LapPlayhead()
    /// How a stage fetches a clip's signed URL — the owner's scoped client, a
    /// shared link's own endpoint, or (DEBUG) a local file.
    typealias URLSource = (LapClip) async throws -> URL

    private(set) var inputs: [StageSideInput] = []
    private(set) var sides: VideoSync.Sides?
    private(set) var videos: [VideoSync.SideKey: StageVideo] = [:]
    /// The session's corners on the shared grid, for the words and the ticks.
    private(set) var corners: [Corners.Corner] = []
    /// The racing line the map card and replay slots draw: the session best's.
    private(set) var trace: [TracePoint]?

    /// Whether the large video is B's (a phone's inset tapped). Per view, never
    /// remembered.
    private(set) var swapped = false
    private(set) var playing = false
    /// 0.25×, 0.5× or 1× (large screens' rate menu). A slowed master slows the
    /// follower by the same factor.
    private(set) var rate: Double = 1
    var mode: VideoSync.SyncMode {
        didSet {
            guard mode != oldValue else { return }
            store?.mode = mode
            apply(eMaster, seek: .exact)
        }
    }

    /// The master's elapsed seconds from its line — negative in the run-up.
    /// Written every frame while playing; read only by the transport, the
    /// now-strip and the map's dots.
    private(set) var eMaster: Double = 0
    /// The whole view at `eMaster`; nil until there are sides.
    private(set) var state: VideoSync.Playhead?
    /// Whether the scrubber is being dragged.
    private(set) var scrubbing = false
    /// What the scrubber's track draws — rebuilt when the sides or the master
    /// change, never per frame.
    private(set) var scrub = ScrubGeometry()
    /// The account's units, for what the live region says.
    @ObservationIgnored var units: UnitSystem = Units.DEFAULT_UNITS

    @ObservationIgnored private let urlFor: URLSource
    @ObservationIgnored private weak var store: SyncModeStore?
    @ObservationIgnored private var link: CADisplayLink?
    @ObservationIgnored private var lastTick: CFTimeInterval = 0
    @ObservationIgnored private var wasPlayingBeforeScrub = false

    init(mode: VideoSync.SyncMode, store: SyncModeStore?, urlFor: @escaping URLSource) {
        self.mode = mode
        self.store = store
        self.urlFor = urlFor
    }

    // MARK: - Sides

    var isTwoSided: Bool { sides?.b != nil }

    /// Which side's clock runs the stage.
    var masterKey: VideoSync.SideKey {
        guard sides?.b != nil else { return .A }
        return swapped ? .B : .A
    }

    func input(_ key: VideoSync.SideKey) -> StageSideInput? {
        inputs.first { $0.key == key }
    }

    func side(_ key: VideoSync.SideKey) -> VideoSync.Side? {
        key == .A ? sides?.a : sides?.b
    }

    /// Whether a side has a player that can show its picture.
    func hasVideo(_ key: VideoSync.SideKey) -> Bool {
        guard let video = videos[key] else { return false }
        if case .failed = video.status { return false }
        return true
    }

    var hasAnyVideo: Bool { hasVideo(.A) || hasVideo(.B) }

    /// Set (or change) what the stage shows. A side whose lap and clip didn't
    /// change keeps its player; the playhead keeps its place, and playback
    /// carries on if it was playing — the web rebuilds its stage the same way
    /// when the lit laps change.
    func configure(
        _ newInputs: [StageSideInput], trace: [TracePoint]?, corners: [Corners.Corner]
    ) {
        guard newInputs != inputs || trace != self.trace || corners != self.corners else { return }
        let wasPlaying = playing
        if wasPlaying { pause(announce: false) }
        self.trace = trace
        self.corners = corners
        let previous = inputs
        inputs = newInputs
        let a = newInputs.first { $0.key == .A }.flatMap(Self.side)
        let b = newInputs.first { $0.key == .B }.flatMap(Self.side)
        sides = a.map { VideoSync.Sides(a: $0, b: b) }

        for key in [VideoSync.SideKey.A, .B] {
            let old = previous.first { $0.key == key }
            let new = newInputs.first { $0.key == key }
            if old?.clip != new?.clip || new == nil {
                videos[key]?.player?.pause()
                videos[key]?.statusObservation?.invalidate()
                videos[key] = nil
                if let clip = new?.clip {
                    let video = StageVideo(clip: clip)
                    videos[key] = video
                    Task { await load(video, key: key) }
                }
            }
        }
        // A side with no video is never the large one when the other has one:
        // "the master is the side with video if A has none".
        if sides?.b != nil, videos[.A] == nil, videos[.B] != nil { swapped = true }
        if sides?.b == nil { swapped = false }
        muteFollower()
        rebuildScrub()
        if previous.isEmpty, let master = sides.map({ masterSide($0) }) {
            // A fresh stage opens where every player opens: `PLAYBACK_LEAD_S`
            // before the line.
            eMaster = VideoSync.scrubRange(master).min
        }
        apply(eMaster, seek: .exact)
        if wasPlaying { play() }
    }

    private static func side(_ input: StageSideInput) -> VideoSync.Side? {
        VideoSync.makeSide(
            input.key, input.entry, input.dStepM,
            input.clip.map { VideoSync.Clip(lapOffsetMs: Double($0.lapOffsetMs), durationMs: Double($0.durationMs)) }
        )
    }

    private func masterSide(_ sides: VideoSync.Sides) -> VideoSync.Side {
        masterKey == .B ? (sides.b ?? sides.a) : sides.a
    }

    // MARK: - Video

    private func load(_ video: StageVideo, key: VideoSync.SideKey) async {
        video.status = .loading
        let url: URL
        do {
            url = try await urlFor(video.clip)
        } catch let error as APIError {
            video.status = .failed(LapVideoPlayer.words(for: error))
            return
        } catch {
            video.status = .failed(error.localizedDescription)
            return
        }
        guard videos[key] === video else { return }
        let item = AVPlayerItem(url: url)
        let player = AVPlayer(playerItem: item)
        player.isMuted = key != masterKey
        // Hold the last frame at the end rather than resetting — a follower whose
        // target runs past its clip waits on its final frame.
        player.actionAtItemEnd = .pause
        video.player = player
        // KVO rather than a poll: the item says when it can play.
        video.statusObservation = item.observe(\.status, options: [.initial, .new]) { [weak self, weak video] item, _ in
            let status = item.status
            let error = item.error
            Task { @MainActor in
                guard let self, let video else { return }
                self.itemStatusChanged(video, key: key, status: status, error: error)
            }
        }
    }

    private func itemStatusChanged(
        _ video: StageVideo, key: VideoSync.SideKey, status: AVPlayerItem.Status, error: (any Error)?
    ) {
        guard videos[key] === video else { return }
        switch status {
        case .readyToPlay:
            guard video.status != .ready else { return }
            video.status = .ready
            // Put the new picture where the playhead already is.
            apply(eMaster, seek: .exact)
            if playing { syncVideos(state, seek: nil) }
        case .failed:
            video.statusObservation?.invalidate()
            video.player = nil
            if !video.retried {
                // A signed URL lasts an hour: on a failure fetch it again, past
                // the cache, and come back to the same place.
                video.retried = true
                Task { await load(video, key: key) }
            } else if let error = error as? URLError,
                      [.notConnectedToInternet, .networkConnectionLost].contains(error.code) {
                video.status = .failed(LapVideoPlayer.needsConnection)
            } else {
                video.status = .failed("This video couldn't be played.")
            }
        default:
            break
        }
    }

    private func muteFollower() {
        for (key, video) in videos {
            video.player?.isMuted = key != masterKey
        }
    }

    // MARK: - Transport

    func togglePlay() {
        playing ? pause() : play()
    }

    func play() {
        guard let sides, !playing else { return }
        let range = VideoSync.scrubRange(masterSide(sides))
        if eMaster >= range.max - 0.05 { eMaster = range.min }
        playing = true
        lastTick = CACurrentMediaTime()
        startLink()
        // No seek here: the master lands exactly on its start and then runs
        // (`syncVideos`), and the clock holds until it has.
        apply(eMaster, seek: nil)
    }

    func pause(announce: Bool = true) {
        guard playing else { return }
        playing = false
        stopLink()
        for video in videos.values {
            video.player?.pause()
            video.isDriving = false
        }
        if announce { announcePlace() }
    }

    func setRate(_ rate: Double) {
        self.rate = rate
        if playing { syncVideos(state, seek: nil) }
    }

    /// The phone's inset tapped: B becomes the large video and the clock, and
    /// the scrubber and the times follow it. The place is kept.
    func swap() {
        guard let sides, sides.b != nil else { return }
        let otherE = (masterKey == .A ? state?.b?.e : state?.a.e) ?? eMaster
        let wasPlaying = playing
        if wasPlaying { pause(announce: false) }
        swapped.toggle()
        muteFollower()
        rebuildScrub()
        apply(otherE, seek: .exact)
        if wasPlaying { play() }
    }

    enum SeekKind { case fast, exact }

    /// A tap on a chart, a corner stop, a key: pause, go to `eMaster`, park.
    func seek(toElapsed e: Double, pause shouldPause: Bool = true) {
        guard let sides else { return }
        if shouldPause { pause(announce: false) }
        let range = VideoSync.scrubRange(masterSide(sides))
        apply(min(max(e, range.min), range.max), seek: .exact)
        if !playing { announcePlace() }
    }

    /// A tap at side A's grid index `k` — the panel's `onSeek`. The master's
    /// time at the same place, whichever side the master is.
    func seek(toGridA k: Double) {
        guard let sides else { return }
        let a = sides.a
        guard masterKey == .B, let b = sides.b else {
            seek(toElapsed: VideoSync.valueAt(a.t, k) ?? 0)
            return
        }
        // B's grid index at A's place: by fraction when the lengths differ
        // past the warning, as `playheadAt` matches them.
        let kB = VideoSync.matchByFraction(a, b) && a.t.count > 1
            ? k * Double(b.t.count - 1) / Double(a.t.count - 1)
            : k
        seek(toElapsed: VideoSync.valueAt(b.t, kB) ?? 0)
    }

    func step(seconds: Double) {
        seek(toElapsed: eMaster + seconds)
    }

    /// One grid point (20 m) along, at the master's place.
    func step(gridPoints: Int) {
        guard let sides else { return }
        let master = masterSide(sides)
        let k = VideoSync.gridAtElapsed(master.t, eMaster) + Double(gridPoints)
        seek(toElapsed: VideoSync.valueAt(master.t, k) ?? eMaster)
    }

    /// One frame along, paused — the master's frame rate where a video is
    /// loaded, else a thirtieth.
    func step(frames: Int) {
        guard !playing else { return }
        // A thirtieth: the PDR's own rate, and a GoPro's at worst two frames.
        step(seconds: Double(frames) / 30)
    }

    func beginScrub() {
        guard !scrubbing else { return }
        scrubbing = true
        wasPlayingBeforeScrub = playing
        pause(announce: false)
    }

    /// The scrubber dragged to the master's `e`: fast, keyframe-tolerant seeks
    /// while the finger moves — Corvette PDR clips have ~1.5 s GOPs, so an exact
    /// seek per drag event would stall.
    func scrub(to e: Double) {
        apply(e, seek: .fast)
    }

    func endScrub(at e: Double) {
        scrubbing = false
        apply(e, seek: .exact)
        if wasPlayingBeforeScrub { play() } else { announcePlace() }
    }

    /// The screen reader's corner stops (`VideoSync.cornerStops`) on the
    /// master's clock.
    var cornerStops: [VideoSync.Stop] {
        guard let sides else { return [] }
        return VideoSync.cornerStops(corners, masterSide(sides).t)
    }

    func nextCorner(_ direction: Int) {
        let stops = cornerStops
        let target = direction > 0
            ? stops.first { $0.e > eMaster + 0.05 }
            : stops.last { $0.e < eMaster - 0.05 }
        if let target { seek(toElapsed: target.e) }
    }

    // MARK: - The clock

    private func startLink() {
        guard link == nil else { return }
        let link = CADisplayLink(target: DisplayLinkTarget(self), selector: #selector(DisplayLinkTarget.fire))
        // 30 Hz is enough for a line and a dot.
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 24, maximum: 30, preferred: 30)
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    private func stopLink() {
        link?.invalidate()
        link = nil
    }

    /// Leaving the page: stop the clock and the players. Kept here rather than in
    /// `deinit`, which can't reach main-actor state.
    func teardown() {
        pause(announce: false)
        stopLink()
    }

    fileprivate func tick() {
        let now = CACurrentMediaTime()
        let dt = now - lastTick
        lastTick = now
        guard playing, let sides else { return }
        let master = masterSide(sides)
        var e = eMaster
        if let video = videos[masterKey], video.isDriving, let player = video.player {
            e = (player.currentTime().seconds * 1000 - (master.clip?.lapOffsetMs ?? 0)) / 1000
        } else if videos[masterKey]?.seeking == true {
            // Hold while the master is still landing on its start: the picture
            // and the line move off together.
        } else {
            e += dt * rate
        }
        let range = VideoSync.scrubRange(master)
        if e >= range.max {
            apply(range.max, seek: nil)
            pause()
            return
        }
        apply(e, seek: nil)
    }

    /// Move the whole view to the master's `e`. `seek` is how the players get
    /// there: nil keeps them in step while playing, `.fast`/`.exact` seeks them.
    private func apply(_ e: Double, seek: SeekKind?) {
        guard let sides else {
            state = nil
            playhead.mark = nil
            return
        }
        eMaster = e
        let st = VideoSync.playheadAt(sides, masterKey, e, mode)
        state = st
        playhead.mark = Self.mark(st, inputs: inputs)
        syncVideos(st, seek: seek)
    }

    static func mark(_ st: VideoSync.Playhead, inputs: [StageSideInput]) -> LapPlayhead.Mark? {
        guard st.inLap else { return nil }
        var dots: [Int: Double] = [:]
        if let a = inputs.first(where: { $0.key == .A }) { dots[a.chIdx] = st.a.k }
        if let b = inputs.first(where: { $0.key == .B }), let bState = st.b { dots[b.chIdx] = bState.k }
        return LapPlayhead.Mark(k: st.a.k, dots: dots)
    }

    /// Keep each side's player where the playhead says it should be — the
    /// spec's *Keeping the follower in step*.
    private func syncVideos(_ st: VideoSync.Playhead?, seek: SeekKind?) {
        guard let st, let sides else { return }
        let now = CACurrentMediaTime()
        let kMaster = masterKey == .A ? st.a.k : (st.b?.k ?? st.a.k)
        for (key, video) in videos {
            guard video.isReady, let player = video.player,
                  let ss = key == .A ? st.a : st.b, let clipMs = ss.clipMs
            else { continue }
            let isMaster = key == masterKey
            let duration = Double(video.clip.durationMs)
            if !ss.inClip {
                // Outside this side's clip — a cut that started late, or the
                // other lap's run-up: replay until the target re-enters.
                if player.rate != 0 { player.pause() }
                video.isDriving = false
                if seek != nil { place(player, video, at: min(max(clipMs, 0), duration), exact: false) }
                continue
            }
            if let seek {
                if !playing { player.pause() }
                place(player, video, at: clipMs, exact: seek == .exact)
                video.isDriving = false
                continue
            }
            guard playing else { continue }
            if isMaster {
                if !video.isDriving, !video.seeking {
                    // Entering the clip, or starting: land exactly, then run.
                    place(player, video, at: clipMs, exact: true) { [weak self, weak video] in
                        guard let self, let video, self.playing, self.videos[key] === video else { return }
                        video.player?.rate = Float(self.rate)
                        video.isDriving = true
                    }
                }
            } else {
                let follow = mode == .place ? VideoSync.followRate(sides, masterKey, kMaster) : 1
                let target = Float(follow * rate)
                if player.rate == 0 || now - video.lastRateAt >= 0.25 {
                    if player.rate != target { player.rate = target }
                    video.lastRateAt = now
                }
                let actual = player.currentTime().seconds * 1000
                if !video.seeking, VideoSync.needsResync(clipMs, actual) {
                    place(player, video, at: clipMs, exact: true) { [weak self, weak video] in
                        guard let self, self.playing else { return }
                        video?.player?.rate = target
                    }
                }
            }
        }
    }

    private func place(
        _ player: AVPlayer, _ video: StageVideo, at clipMs: Double, exact: Bool,
        then: (@MainActor @Sendable () -> Void)? = nil
    ) {
        let time = CMTime(value: CMTimeValue(clipMs.rounded()), timescale: 1000)
        let tolerance: CMTime = exact ? .zero : .positiveInfinity
        video.seeking = true
        player.seek(to: time, toleranceBefore: tolerance, toleranceAfter: tolerance) { [weak video] _ in
            Task { @MainActor in
                video?.seeking = false
                then?()
            }
        }
    }

    // MARK: - The scrubber's track

    /// Everything the scrubber draws under its thumb, on the master's clock.
    struct ScrubGeometry: Equatable, Sendable {
        var min: Double = -LapClips.PLAYBACK_LEAD_S
        var max: Double = LapClips.PLAYBACK_LEAD_S
        /// The master's lap time — the clock's second figure.
        var lapS: Double = 0
        /// The line along the track: x the master's elapsed seconds, y the delta
        /// (A − the other side) scaled to the lap's largest |delta| (−1…1), or
        /// with no other side A's speed scaled 0…1.
        var points: [CGPoint] = []
        var isDelta = false
        /// Where each corner starts, and the two sector boundaries.
        var corners: [Double] = []
        var sectors: [Double] = []
    }

    private func rebuildScrub() {
        guard let sides else {
            scrub = ScrubGeometry()
            return
        }
        let master = masterSide(sides)
        let range = VideoSync.scrubRange(master)
        var geometry = ScrubGeometry(min: range.min, max: range.max, lapS: master.t.last ?? 0)
        let a = sides.a
        let nA = a.t.count
        if let b = sides.b, nA > 1 {
            let byFraction = VideoSync.matchByFraction(a, b)
            var raw: [(e: Double, d: Double)] = []
            for k in 0..<nA {
                let kB = byFraction ? Double(k) * Double(b.t.count - 1) / Double(nA - 1) : Double(k)
                let eB = VideoSync.valueAt(b.t, kB) ?? 0
                raw.append((masterKey == .A ? a.t[k] : eB, a.t[k] - eB))
            }
            let peak = Swift.max(raw.map { abs($0.d) }.max() ?? 0, 0.01)
            geometry.points = raw.map { CGPoint(x: $0.e, y: $0.d / peak) }
            geometry.isDelta = true
        } else if let speed = a.entry.speed, let top = speed.max(), top > 0 {
            geometry.points = zip(a.t, speed).map { CGPoint(x: $0, y: $1 / top) }
        }
        geometry.corners = cornerStops.map(\.e)
        let n = Double(master.t.count - 1)
        geometry.sectors = (1..<Sectors.SECTOR_COUNT).compactMap {
            VideoSync.valueAt(master.t, n * Double($0) / Double(Sectors.SECTOR_COUNT))
        }
        scrub = geometry
    }

    /// Where the map's dots go: A's place, and in *Same time* B's own — each as a
    /// fraction of its own lap.
    func mapDots() -> [TrackMapView.Dot] {
        guard let st = state, st.inLap, let sides else { return [] }
        let fraction = { (side: VideoSync.Side, distM: Double) -> Double in
            let length = Double(side.t.count - 1) * side.dStepM
            return length > 0 ? distM / length : 0
        }
        var dots = [TrackMapView.Dot(frac: fraction(sides.a, st.a.distM), color: Color(.chartLine))]
        if st.mode == .time, let b = sides.b, let bState = st.b {
            dots.append(TrackMapView.Dot(frac: fraction(b, bState.distM), color: Color(.chartLineB)))
        }
        return dots
    }

    // MARK: - Words

    /// The playhead's words (`VideoSync.playheadText`).
    func text(_ units: UnitSystem) -> VideoSync.Text? {
        state.map { VideoSync.playheadText($0, corners, units) }
    }

    /// The live region speaks the place on a pause and after a seek, never
    /// every frame.
    private func announcePlace() {
        guard UIAccessibility.isVoiceOverRunning, let text = text(units) else { return }
        AccessibilityNotification.Announcement(text.place).post()
    }
}

/// `CADisplayLink` retains its target, so the model is held weakly through
/// this, and the link is invalidated on pause and on leaving the page.
private final class DisplayLinkTarget: NSObject {
    weak var model: LapStageModel?

    init(_ model: LapStageModel) {
        self.model = model
    }

    @MainActor @objc func fire() {
        model?.tick()
    }
}
