import SwiftUI
import TrackEvolutionKit

/// Compare any two laps with telemetry at one track — different sessions, events,
/// even years apart (#165). `viewLapCompare` in `public/app.js` is the reference:
/// the same "current me vs best me" default picks, head-to-head numbers and
/// length-mismatch warning, with the maths in the Kit's `CompareLaps`, pinned to
/// the web implementation by `contracts/logic/compare-laps.json`.
///
/// Presented as a sheet from the track screen, like the event page's channel
/// graphs and for the same reason: the stacked charts want the full height.
struct CompareLapsScreen: View {
    let trackId: Int

    @Environment(AuthController.self) private var auth
    @State private var model: CompareLapsModel?

    private static let kphToMph = 0.621371

    var body: some View {
        TELoadable(state: model?.state ?? .loading, retry: { await model?.load() }) {
            if let model {
                content(model)
            }
        }
        .background(Color(.bgPage))
        .task {
            if model == nil {
                let model = CompareLapsModel(api: auth.api, trackId: trackId)
                self.model = model
                await model.load()
            }
        }
    }

    @ViewBuilder
    private func content(_ model: CompareLapsModel) -> some View {
        if let pair = model.pair {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Compare two laps")
                        .teStyle(.h1)
                        .foregroundStyle(Color(.textStrong))
                    picker("Lap A", selection: model.selA, color: Color(.chartLine), model) { model.pick(a: $0) }
                    picker("Lap B", selection: model.selB, color: Color(.chartLineB), model) { model.pick(b: $0) }
                    if pair.mismatch > CompareLaps.LENGTH_MISMATCH_WARN {
                        Text("⚠️ These laps cover driven distances \(Int((pair.mismatch * 100).rounded()))% apart — likely a different layout or start/finish line, so the distance alignment may be off.")
                            .teStyle(.xs)
                            .foregroundStyle(Color(.textMuted))
                    }
                    headToHead(pair)
                    Text("The delta chart shows where time is gained or lost vs the faster lap; the channels below show why. Tap a chart to read values.")
                        .teStyle(.xs)
                        .foregroundStyle(Color(.textFaint))
                    LapChannelPanel(channels: pair.aligned, laps: pair.laps, preselect: [0, 1])
                        // Recreate the panel when the picks change: its highlight
                        // selection is @State seeded on appear, and a stale selection
                        // against new channel data would highlight the wrong laps.
                        .id("\(model.selA)-\(model.selB)")
                }
                .padding(TESpacing.pageGutter)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else {
            TEPage {
                Text("Compare two laps")
                    .teStyle(.h1)
                    .foregroundStyle(Color(.textStrong))
                TEEmpty("Comparing laps needs two laps with telemetry at this track — import a session (or record laps) first.")
            }
        }
    }

    // MARK: - Lap pickers

    private func picker(
        _ label: String, selection: Int, color: Color, _ model: CompareLapsModel, set: @escaping (Int) -> Void
    ) -> some View {
        HStack(spacing: 8) {
            Circle()
                .fill(color)
                .frame(width: 10, height: 10)
            Menu {
                ForEach(model.rows.indices, id: \.self) { index in
                    Button {
                        set(index)
                    } label: {
                        if index == selection {
                            Label(model.pickLabel(index), systemImage: "checkmark")
                        } else {
                            Text(model.pickLabel(index))
                        }
                    }
                }
            } label: {
                HStack(spacing: 6) {
                    Text(model.pickLabel(selection))
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
            .accessibilityLabel("\(label): \(model.pickLabel(selection))")
        }
    }

    // MARK: - Head to head

    private func headToHead(_ pair: CompareLapsModel.Pair) -> some View {
        TECard {
            VStack(spacing: 0) {
                statRow("Lap time", fmt: { LapTime.fmtMs($0.timeMs) }, delta: deltaMs(pair), pair)
                divider()
                metric("Top speed", pair, \.topSpeedKph, mph, deltaFmt: mphDelta)
                divider()
                metric("Min speed", pair, \.minSpeedKph, mph, deltaFmt: mphDelta)
                divider()
                metric("Avg speed", pair, \.avgSpeedKph, mph, deltaFmt: mphDelta)
                divider()
                metric("Max RPM", pair, \.maxRpm, { "\(Int($0.rounded()))" }, deltaFmt: { signed($0, "\(Int(abs($0).rounded()))") })
                divider()
                metric("Max lateral G", pair, \.maxLatG, { String(format: "%.2f", $0) }, deltaFmt: { signed($0, String(format: "%.2f", abs($0))) })
                divider()
                metric("Full throttle", pair, \.fullThrottlePct, { "\(Int($0.rounded()))% of lap" }, deltaFmt: ppDelta)
                divider()
                metric("On the brakes", pair, \.brakingPct, { "\(Int($0.rounded()))% of lap" }, deltaFmt: ppDelta)
            }
        }
    }

    private func divider() -> some View {
        Divider().overlay(Color(.borderHairline))
    }

    private func statRow(
        _ label: String, fmt: (CompareLaps.Metrics) -> String, delta: String?, _ pair: CompareLapsModel.Pair
    ) -> some View {
        HStack(spacing: 8) {
            Text(label)
                .teStyle(.sm)
                .foregroundStyle(Color(.textMuted))
            Spacer(minLength: 8)
            Text(fmt(pair.metricsA))
                .teStyle(.lapTime)
                .foregroundStyle(Color(.textStrong))
            Text(fmt(pair.metricsB))
                .teStyle(.lapTime)
                .foregroundStyle(Color(.textStrong))
            Text(delta ?? "—")
                .teStyle(.lapTime)
                .foregroundStyle(Color(.textMuted))
                .frame(minWidth: 56, alignment: .trailing)
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label): lap A \(fmt(pair.metricsA)), lap B \(fmt(pair.metricsB)), delta \(delta ?? "none")")
    }

    private func metric(
        _ label: String,
        _ pair: CompareLapsModel.Pair,
        _ key: KeyPath<CompareLaps.Metrics, Double?>,
        _ fmt: (Double) -> String,
        deltaFmt: (Double) -> String
    ) -> some View {
        let a = pair.metricsA[keyPath: key]
        let b = pair.metricsB[keyPath: key]
        let delta = (a != nil && b != nil) ? deltaFmt(b! - a!) : nil
        return statRow(
            label,
            fmt: { $0[keyPath: key].map(fmt) ?? "—" },
            delta: delta,
            pair
        )
    }

    private func deltaMs(_ pair: CompareLapsModel.Pair) -> String {
        LapTime.fmtDelta(pair.metricsB.timeMs - pair.metricsA.timeMs)
    }

    private func mph(_ kph: Double) -> String {
        "\(Int((kph * Self.kphToMph).rounded())) mph"
    }

    private func mphDelta(_ kph: Double) -> String {
        signed(kph, "\(Int((abs(kph) * Self.kphToMph).rounded())) mph")
    }

    private func ppDelta(_ d: Double) -> String {
        signed(d, String(format: "%.1fpp", abs(d)))
    }

    /// The sign is the message, so it is always shown.
    private func signed(_ value: Double, _ magnitude: String) -> String {
        value < 0 ? "−\(magnitude)" : "+\(magnitude)"
    }
}

/// The compare screen's data: every event detail at the track with channel data,
/// flattened to pickable laps, and the currently selected pair.
@MainActor
@Observable
final class CompareLapsModel {
    private let api: APIClient
    let trackId: Int

    private(set) var state: LoadState = .loading
    private(set) var rows: [CompareLaps.Row] = []
    /// `sessions.channels` by session id, so a picked row finds its entry.
    private var channelsBySession: [Int: SessionChannels] = [:]

    /// Indexes into `rows` — seeded by `CompareLaps.defaultComparePicks`.
    var selA = 0
    var selB = 0

    init(api: APIClient, trackId: Int) {
        self.api = api
        self.trackId = trackId
    }

    func load() async {
        do {
            let events = try await api.events(trackId: trackId)
            var details: [EventDetail] = []
            for event in events where event.lapCount > 0 {
                details.append(try await api.event(id: event.id))
            }
            rows = CompareLaps.comparableLaps(details.map(CompareLaps.EventLaps.init(detail:)))
            channelsBySession = details.reduce(into: [:]) { acc, detail in
                for session in detail.sessions {
                    acc[session.id] = session.channels
                }
            }
            if let picks = CompareLaps.defaultComparePicks(rows) {
                selA = picks.a
                selB = picks.b
            }
            state = .ready
        } catch let error as APIError {
            state = .failed(error.message)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    /// Picking the lap the other side already shows swaps the two instead of
    /// comparing a lap to itself — the web view's rule.
    func pick(a index: Int) {
        if index == selB { selB = selA }
        selA = index
    }

    func pick(b index: Int) {
        if index == selA { selA = selB }
        selB = index
    }

    /// "May 3, 2026 · Sat AM · Lap 2 — 1:30.480", trimmed to what the row has.
    func pickLabel(_ index: Int) -> String {
        guard rows.indices.contains(index) else { return "—" }
        let row = rows[index]
        let parts = [EventDates.fmtDate(row.date), row.sessionLabel, "Lap \(String(row.lapNum))"]
        return "\(parts.compactMap(\.self).joined(separator: " · ")) — \(LapTime.fmtMs(row.timeMs))"
    }

    /// Everything the view needs for the current pair, or nil when fewer than two
    /// laps have channel data.
    struct Pair {
        var aligned: SessionChannels
        /// Synthetic lap rows for the panel's chips: ids 0 and 1, the rows' own lap
        /// numbers, and the entries' times so `matchLapsToChannels` pairs them.
        var laps: [Lap]
        var metricsA: CompareLaps.Metrics
        var metricsB: CompareLaps.Metrics
        var mismatch: Double
    }

    var pair: Pair? {
        guard rows.count >= 2,
              rows.indices.contains(selA), rows.indices.contains(selB), selA != selB,
              let chanA = channelsBySession[rows[selA].sessionId],
              let chanB = channelsBySession[rows[selB].sessionId],
              chanA.laps.indices.contains(rows[selA].chIdx),
              chanB.laps.indices.contains(rows[selB].chIdx)
        else { return nil }
        let entryA = chanA.laps[rows[selA].chIdx]
        let entryB = chanB.laps[rows[selB].chIdx]
        let aligned = CompareLaps.alignLapPair(entryA, chanA.dStepM, entryB, chanB.dStepM)
        return Pair(
            aligned: aligned,
            laps: [
                Lap(id: 0, sessionId: rows[selA].sessionId, lapNum: rows[selA].lapNum, timeMs: entryA.timeMs),
                Lap(id: 1, sessionId: rows[selB].sessionId, lapNum: rows[selB].lapNum, timeMs: entryB.timeMs),
            ],
            metricsA: CompareLaps.lapMetrics(entryA),
            metricsB: CompareLaps.lapMetrics(entryB),
            mismatch: CompareLaps.lengthMismatchRatio(entryA, chanA.dStepM, entryB, chanB.dStepM)
        )
    }
}
