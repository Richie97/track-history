import SwiftUI
import TrackEvolutionKit

/// One leaderboard row, opened (NS-35). `viewLeaderboardLap` in `public/app.js`
/// is the reference.
///
/// The server publishes the lap and nothing else — no session, no event, no car,
/// nothing user-entered — so this screen is deliberately thin above the charts:
/// a time, whose it is, the date, and what the recorder measured.
///
/// The comparison is the point of the screen rather than a feature on it. When
/// the viewer has a lap of their own with telemetry at this track, the two go
/// through `CompareLaps.alignLapPair` and render in the same `LapChannelPanel`
/// the two-lap compare uses; when they don't, the same panel draws one side and
/// the screen says why there is only one. **Their lap is always side A**, so the
/// leaderboard lap keeps its colour whether or not there is something to put
/// beside it.
///
/// Presented as a sheet from `LeaderboardScreen`, like `CompareLapsScreen` is
/// from the track screen and for the same reason: the stacked charts want the
/// full height, and a Swift Charts chart of this many marks inside a `List` row
/// never settles.
struct LeaderboardLapScreen: View {
    let trackId: Int
    let lapId: Int

    @Environment(AuthController.self) private var auth
    @State private var model: LeaderboardLapModel?

    var body: some View {
        TELoadable(state: model?.state ?? .loading, retry: { await model?.load() }) {
            if let model, let lap = model.lap {
                content(model, lap)
            }
        }
        .background(Color(.bgPage))
        .task {
            if model == nil {
                let model = LeaderboardLapModel(api: auth.api, trackId: trackId, lapId: lapId)
                self.model = model
                await model.load()
            }
        }
    }

    // MARK: - Content

    @ViewBuilder
    private func content(_ model: LeaderboardLapModel, _ lap: LeaderboardLap) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header(lap)

                // The racing line is free: `channels` is the one Pro field
                // (NS-32 rule 4), so a free account still gets the shape of the
                // lap and the paywall sits under it rather than over the screen.
                if let trace = lap.trace, trace.count > 1 {
                    TECard {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Racing line — brighter is faster")
                                .teStyle(.xs)
                                .foregroundStyle(Color(.textFaint))
                            TrackMapView(trace: trace)
                                .frame(height: 220)
                        }
                    }
                }

                if lap.entry == nil {
                    if !Entitlement.canViewChannels(auth.entitlement) {
                        ProUpsellCard(
                            title: "Telemetry",
                            blurb: "See this lap's speed, throttle, brake and steering traces — and put your own "
                                + "best lap at this track beside it, corner for corner."
                        )
                    } else {
                        TEEmpty("This lap's telemetry isn't available.")
                    }
                } else if let view = model.panel {
                    if view.mine == nil {
                        Text("You have no lap with telemetry at this track yet, so there's nothing to overlay. "
                            + "Record with the app or import a session and this screen will put the two side by side.")
                            .teStyle(.xs)
                            .foregroundStyle(Color(.textMuted))
                    } else {
                        minePicker(model, view)
                        if view.mismatch > CompareLaps.LENGTH_MISMATCH_WARN {
                            Text("⚠️ These laps cover driven distances \(Int((view.mismatch * 100).rounded()))% apart — likely a different layout or start/finish line, so the distance alignment may be off.")
                                .teStyle(.xs)
                                .foregroundStyle(Color(.textMuted))
                        }
                    }
                    headToHead(view)
                    Text(view.mine == nil
                        ? "Tap a chart to read values."
                        : "The delta chart shows where you gain or lose against this lap; the channels below show why. Tap a chart to read values.")
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textFaint))
                    LapChannelPanel(
                        channels: view.aligned,
                        laps: view.laps,
                        preselect: view.mine == nil ? [0] : [0, 1]
                    )
                    // Recreate the panel when the pick changes: its highlight
                    // selection is @State seeded on appear, and a stale selection
                    // against new channel data would light the wrong laps.
                    .id(model.selectedMine ?? -1)
                }
            }
            .padding(TESpacing.pageGutter)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - Header

    private func header(_ lap: LeaderboardLap) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(LapTime.fmtMs(lap.timeMs))
                .teStyle(.h1)
                .foregroundStyle(Color(.textStrong))
            Text(subtitle(lap))
                .teStyle(.sm)
                .foregroundStyle(Color(.textMuted))
        }
        .accessibilityElement(children: .combine)
    }

    /// Whose lap, when, and what the recorder measured around it. Nothing here is
    /// user-entered — the typed `temp_f` deliberately has no counterpart.
    private func subtitle(_ lap: LeaderboardLap) -> String {
        var parts = [lap.you ? "Your leaderboard lap" : "\(lap.name ?? "Driver")'s leaderboard lap"]
        parts.append(EventDates.fmtDate(lap.date))
        if let c = lap.ambientC { parts.append(SessionConditions.tempText(c, SessionConditions.Units(auth.units))) }
        let elevation = SessionConditions.elevationText(lap.elevationM, SessionConditions.Units(auth.units))
        if !elevation.isEmpty { parts.append(elevation) }
        return parts.joined(separator: " · ")
    }

    // MARK: - Which of my laps

    /// Only offered once there is a choice to make: with one lap of your own it is
    /// already the one shown, and a menu with a single item is a control that does
    /// nothing.
    @ViewBuilder
    private func minePicker(_ model: LeaderboardLapModel, _ view: LeaderboardLapModel.Panel) -> some View {
        if model.rows.count > 1 {
            HStack(spacing: 8) {
                Circle()
                    .fill(Color(.chartLineB))
                    .frame(width: 10, height: 10)
                Menu {
                    ForEach(model.rows.indices, id: \.self) { index in
                        Button {
                            model.selectedMine = index
                        } label: {
                            if index == model.selectedMine {
                                Label(model.pickLabel(index), systemImage: "checkmark")
                            } else {
                                Text(model.pickLabel(index))
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 6) {
                        Text(model.pickLabel(model.selectedMine ?? 0))
                            .teStyle(.bodyStrong)
                            .foregroundStyle(Color(.textStrong))
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Color(.textFaint))
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color(.surfaceRaised), in: .rect(cornerRadius: TERadius.sm))
                    .overlay(
                        RoundedRectangle(cornerRadius: TERadius.sm)
                            .strokeBorder(Color(.borderHairline), lineWidth: 1)
                    )
                }
                .accessibilityLabel("Your lap: \(model.pickLabel(model.selectedMine ?? 0))")
            }
        }
    }

    // MARK: - Head to head

    /// The same rows the two-lap compare shows, minus max RPM: a stranger's engine
    /// speed against yours is a fact about two different cars, not about the lap.
    /// The Δ column disappears when there is only one lap to read.
    private func headToHead(_ view: LeaderboardLapModel.Panel) -> some View {
        TECard {
            VStack(spacing: 0) {
                row("Lap time", view, { LapTime.fmtMs($0.timeMs) }, deltaMs(view))
                divider()
                metric("Top speed", view, \.topSpeedKph, mph, mphDelta)
                divider()
                metric("Min speed", view, \.minSpeedKph, mph, mphDelta)
                divider()
                metric("Avg speed", view, \.avgSpeedKph, mph, mphDelta)
                divider()
                metric("Max lateral G", view, \.maxLatG, { String(format: "%.2f", $0) },
                       { signed($0, String(format: "%.2f", abs($0))) })
                divider()
                metric("Full throttle", view, \.fullThrottlePct, { "\(Int($0.rounded()))% of lap" }, ppDelta)
                divider()
                metric("On the brakes", view, \.brakingPct, { "\(Int($0.rounded()))% of lap" }, ppDelta)
            }
        }
    }

    private func divider() -> some View {
        Divider().overlay(Color(.borderHairline))
    }

    private func row(
        _ label: String, _ view: LeaderboardLapModel.Panel,
        _ fmt: (CompareLaps.Metrics) -> String, _ delta: String?
    ) -> some View {
        HStack(spacing: 8) {
            Text(label)
                .teStyle(.sm)
                .foregroundStyle(Color(.textMuted))
            Spacer(minLength: 8)
            Text(fmt(view.theirMetrics))
                .teStyle(.lapTime)
                .foregroundStyle(Color(.textStrong))
            if let mine = view.myMetrics {
                Text(fmt(mine))
                    .teStyle(.lapTime)
                    .foregroundStyle(Color(.textStrong))
                Text(delta ?? "—")
                    .teStyle(.lapTime)
                    .foregroundStyle(Color(.textFaint))
                    .frame(minWidth: 64, alignment: .trailing)
            }
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel(label, view, fmt, delta))
    }

    private func accessibilityLabel(
        _ label: String, _ view: LeaderboardLapModel.Panel,
        _ fmt: (CompareLaps.Metrics) -> String, _ delta: String?
    ) -> String {
        guard let mine = view.myMetrics else { return "\(label), \(fmt(view.theirMetrics))" }
        return "\(label), theirs \(fmt(view.theirMetrics)), yours \(fmt(mine)), difference \(delta ?? "unknown")"
    }

    private func metric(
        _ label: String, _ view: LeaderboardLapModel.Panel,
        _ key: KeyPath<CompareLaps.Metrics, Double?>,
        _ fmt: @escaping (Double) -> String,
        _ deltaFmt: (Double) -> String
    ) -> some View {
        let theirs = view.theirMetrics[keyPath: key]
        let mine = view.myMetrics?[keyPath: key]
        let delta = theirs.flatMap { t in mine.map { deltaFmt($0 - t) } }
        return row(label, view, { m in m[keyPath: key].map(fmt) ?? "—" }, delta)
    }

    private func deltaMs(_ view: LeaderboardLapModel.Panel) -> String? {
        guard let mine = view.myMetrics else { return nil }
        return LapTime.fmtDelta(mine.timeMs - view.theirMetrics.timeMs)
    }

    private func mph(_ kph: Double) -> String { Units.fmtSpeedKph(kph, auth.units) }

    private func mphDelta(_ d: Double) -> String {
        signed(d, Units.fmtSpeedKph(abs(d), auth.units))
    }

    private func ppDelta(_ d: Double) -> String { signed(d, String(format: "%.1fpp", abs(d))) }

    /// The sign is the message, so it is always shown.
    private func signed(_ value: Double, _ magnitude: String) -> String {
        value < 0 ? "−\(magnitude)" : "+\(magnitude)"
    }
}

/// The screen's data: the published lap, and the viewer's own comparable laps at
/// the same track.
@MainActor
@Observable
final class LeaderboardLapModel {
    private let api: APIClient
    let trackId: Int
    let lapId: Int

    private(set) var state: LoadState = .loading
    private(set) var lap: LeaderboardLap?
    /// The viewer's own laps with telemetry here — the same flattening the
    /// two-lap compare does, so the pick list reads identically.
    private(set) var rows: [CompareLaps.Row] = []
    private var channelsBySession: [Int: SessionChannels] = [:]
    /// Index into ``rows``, defaulted to the viewer's own fastest: the comparison
    /// anyone opening a leaderboard row wants is "my best against theirs".
    var selectedMine: Int?

    init(api: APIClient, trackId: Int, lapId: Int) {
        self.api = api
        self.trackId = trackId
        self.lapId = lapId
    }

    func load() async {
        do {
            lap = try await api.leaderboardLap(trackId: trackId, lapId: lapId)
            await loadMine()
            state = .ready
        } catch let error as APIError {
            state = .failed(error.message)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    /// A failure here costs the comparison, never the screen: their lap still
    /// renders, which is what the viewer tapped for.
    private func loadMine() async {
        guard lap?.entry != nil else { return }
        do {
            let events = try await api.events(trackId: trackId)
            var details: [EventDetail] = []
            for event in events where event.lapCount > 0 {
                details.append(try await api.event(id: event.id))
            }
            rows = CompareLaps.comparableLaps(details.map(CompareLaps.EventLaps.init(detail:)))
            channelsBySession = details.reduce(into: [:]) { acc, detail in
                for session in detail.sessions { acc[session.id] = session.channels }
            }
            selectedMine = rows.indices.min { rows[$0].timeMs < rows[$1].timeMs }
        } catch {
            rows = []
            channelsBySession = [:]
            selectedMine = nil
        }
    }

    /// "May 3, 2026 · Sat AM · Lap 2 — 1:30.480", trimmed to what the row has.
    func pickLabel(_ index: Int) -> String {
        guard rows.indices.contains(index) else { return "—" }
        let row = rows[index]
        let parts = [EventDates.fmtDate(row.date), row.sessionLabel, "Lap \(String(row.lapNum))"]
        return "\(parts.compactMap(\.self).joined(separator: " · ")) — \(LapTime.fmtMs(row.timeMs))"
    }

    /// Everything the view draws, with the leaderboard lap always at index 0.
    struct Panel {
        var aligned: SessionChannels
        /// Synthetic lap rows for the panel's chips, so `matchLapsToChannels`
        /// pairs them by time the way it does for a real session.
        var laps: [Lap]
        var theirMetrics: CompareLaps.Metrics
        var myMetrics: CompareLaps.Metrics?
        var mine: CompareLaps.Row?
        var mismatch: Double
    }

    var panel: Panel? {
        guard let lap, let theirs = lap.entry, let step = lap.channels?.dStepM else { return nil }
        let theirLap = Lap(id: 0, sessionId: 0, lapNum: theirs.n, timeMs: theirs.timeMs)
        guard let index = selectedMine, rows.indices.contains(index),
              let channels = channelsBySession[rows[index].sessionId],
              channels.laps.indices.contains(rows[index].chIdx)
        else {
            return Panel(
                aligned: SessionChannels(v: 1, dStepM: step, laps: [theirs]),
                laps: [theirLap],
                theirMetrics: CompareLaps.lapMetrics(theirs),
                myMetrics: nil,
                mine: nil,
                mismatch: 0
            )
        }
        let row = rows[index]
        let mine = channels.laps[row.chIdx]
        return Panel(
            aligned: CompareLaps.alignLapPair(theirs, step, mine, channels.dStepM),
            laps: [theirLap, Lap(id: 1, sessionId: row.sessionId, lapNum: row.lapNum, timeMs: mine.timeMs)],
            theirMetrics: CompareLaps.lapMetrics(theirs),
            myMetrics: CompareLaps.lapMetrics(mine),
            mine: row,
            mismatch: CompareLaps.lengthMismatchRatio(theirs, step, mine, channels.dStepM)
        )
    }
}
