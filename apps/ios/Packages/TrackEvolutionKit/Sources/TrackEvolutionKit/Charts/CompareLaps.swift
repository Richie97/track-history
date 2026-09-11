import Foundation

/// Cross-event lap comparison (#165): the pure half of "compare two laps" —
/// pick any two laps with stored channel data at a track, put them on one
/// distance grid, and reduce each to head-to-head numbers.
///
/// A port of `public/js/compare-laps.js` — same function names, same inclusive
/// thresholds — pinned against the web implementation by
/// `contracts/logic/compare-laps.json` (`CompareLapsTests`). The pair that
/// `alignLapPair` returns is an ordinary `SessionChannels`, so the existing
/// chart stack draws a cross-event pair the same way it draws one session.
public enum CompareLaps {
    /// "Flat out" / "on the brakes" thresholds for `lapMetrics`' percentages.
    /// Display semantics, not physics — see the JS.
    public static let FULL_THROTTLE_PCT: Double = 95
    public static let BRAKING_PCT: Double = 10

    /// Two laps whose driven lengths differ by more than this are probably not
    /// the same layout / start line — the screen warns past it.
    public static let LENGTH_MISMATCH_WARN = 0.05

    /// One event's contribution to the picker: what `comparableLaps` reads off
    /// an event detail. A struct of its own (rather than `EventDetail`) so the
    /// contract test can build inputs without fabricating a full event row.
    public struct EventLaps: Sendable {
        public var eventId: Int
        public var date: String
        public var club: String?
        public var sessions: [SessionLaps]

        public init(eventId: Int, date: String, club: String?, sessions: [SessionLaps]) {
            self.eventId = eventId
            self.date = date
            self.club = club
            self.sessions = sessions
        }

        public init(detail: EventDetail) {
            self.init(
                eventId: detail.event.id,
                date: detail.event.startDate,
                club: detail.event.club,
                sessions: detail.sessions.map(SessionLaps.init(session:))
            )
        }
    }

    public struct SessionLaps: Sendable {
        public var sessionId: Int
        public var label: String?
        public var laps: [Lap]
        public var channels: SessionChannels?

        public init(sessionId: Int, label: String?, laps: [Lap], channels: SessionChannels?) {
            self.sessionId = sessionId
            self.label = label
            self.laps = laps
            self.channels = channels
        }

        public init(session: Session) {
            self.init(sessionId: session.id, label: session.label, laps: session.laps, channels: session.channels)
        }
    }

    /// One pickable lap: a stored lap row that `matchLapsToChannels` paired
    /// with a channel entry. `chIdx` indexes that session's `channels.laps`.
    public struct Row: Sendable, Equatable {
        public var eventId: Int
        public var date: String
        public var club: String?
        public var sessionId: Int
        public var sessionLabel: String?
        public var lapNum: Int
        public var timeMs: Int
        public var chIdx: Int

        public init(
            eventId: Int, date: String, club: String?, sessionId: Int, sessionLabel: String?,
            lapNum: Int, timeMs: Int, chIdx: Int
        ) {
            self.eventId = eventId
            self.date = date
            self.club = club
            self.sessionId = sessionId
            self.sessionLabel = sessionLabel
            self.lapNum = lapNum
            self.timeMs = timeMs
            self.chIdx = chIdx
        }
    }

    /// Flatten event details into one pickable list of laps that have channel
    /// data. Keeps the given event order; within an event, session order then
    /// lap order. Laps without a channel entry (hand-added, no distance
    /// window) drop out, exactly as on the web.
    public static func comparableLaps(_ events: [EventLaps]) -> [Row] {
        var rows: [Row] = []
        for event in events {
            for session in event.sessions {
                guard let channels = session.channels, !channels.laps.isEmpty, !session.laps.isEmpty else {
                    continue
                }
                for match in ChannelGraphs.matchLapsToChannels(session.laps, channels.laps)
                where match.hasChannels {
                    rows.append(
                        Row(
                            eventId: event.eventId,
                            date: event.date,
                            club: event.club,
                            sessionId: session.sessionId,
                            sessionLabel: session.label,
                            lapNum: match.lap.lapNum,
                            timeMs: match.lap.timeMs,
                            chIdx: match.chIdx
                        )
                    )
                }
            }
        }
        return rows
    }

    /// Default selection: side A is "current me" — the best lap of the most
    /// recent event with comparable laps — and side B is "best me", the
    /// overall best lap; when they coincide, B falls back to the best of the
    /// rest. Indexes into the rows, nil when there is nothing to compare.
    public static func defaultComparePicks(_ rows: [Row]) -> (a: Int, b: Int)? {
        guard rows.count >= 2 else { return nil }
        let latest = rows.map(\.date).max() ?? rows[0].date
        func bestIn(_ idxs: [Int]) -> Int {
            idxs.dropFirst().reduce(idxs[0]) { rows[$1].timeMs < rows[$0].timeMs ? $1 : $0 }
        }
        let all = Array(rows.indices)
        let a = bestIn(all.filter { rows[$0].date == latest })
        var b = bestIn(all)
        if b == a { b = bestIn(all.filter { $0 != a }) }
        return (a, b)
    }

    /// Linear-resample one stored channel-lap entry from its grid spacing onto
    /// another. Identity when the spacings already match (every writer uses
    /// 20 m today, but `dStepM` is stored per session and this must not
    /// assume). Same arithmetic as the JS, so the fixture pins every value.
    public static func resampleChannelLap(_ entry: LapChannels, _ fromStepM: Double, _ toStepM: Double) -> LapChannels {
        guard fromStepM != toStepM else { return entry }
        func resample(_ arr: [Double]?) -> [Double]? {
            guard let arr, arr.count >= 2 else { return nil }
            let n = Int((Double(arr.count - 1) * fromStepM / toStepM).rounded(.down)) + 1
            return (0..<n).map { k in
                let p = Double(k) * toStepM / fromStepM
                let i0 = Swift.min(arr.count - 2, Int(p.rounded(.down)))
                return arr[i0] + (arr[i0 + 1] - arr[i0]) * (p - Double(i0))
            }
        }
        return LapChannels(
            n: entry.n,
            timeMs: entry.timeMs,
            speed: resample(entry.speed),
            rpm: resample(entry.rpm),
            latG: resample(entry.latG),
            throttle: resample(entry.throttle),
            brake: resample(entry.brake),
            steering: resample(entry.steering)
        )
    }

    /// Put a pair of channel-lap entries on one grid: side B is resampled onto
    /// side A's spacing when the two sessions stored different grids.
    public static func alignLapPair(
        _ entryA: LapChannels, _ stepA: Double, _ entryB: LapChannels, _ stepB: Double
    ) -> SessionChannels {
        SessionChannels(v: 1, dStepM: stepA, laps: [entryA, resampleChannelLap(entryB, stepB, stepA)])
    }

    /// Driven length a stored entry covers (its grid extent, metres).
    public static func drivenLengthM(_ entry: LapChannels, _ stepM: Double) -> Double {
        let n = entry.speed?.count ?? 0
        return n > 1 ? Double(n - 1) * stepM : 0
    }

    /// Relative driven-length difference between two entries (0 = identical).
    /// Distance is measured from each lap's own start line, so a large ratio
    /// means a different layout, picked line, or off-track excursion — the
    /// comparison still renders, with a warning past `LENGTH_MISMATCH_WARN`.
    public static func lengthMismatchRatio(
        _ entryA: LapChannels, _ stepA: Double, _ entryB: LapChannels, _ stepB: Double
    ) -> Double {
        let la = drivenLengthM(entryA, stepA)
        let lb = drivenLengthM(entryB, stepB)
        let longest = Swift.max(la, lb)
        return longest > 0 ? abs(la - lb) / longest : 0
    }

    /// One lap's channels reduced to head-to-head numbers. Speed stays km/h as
    /// stored (the screen converts for display); percentages are shares of
    /// grid samples — on a uniform distance grid, shares of driven distance.
    public struct Metrics: Sendable, Equatable {
        public var timeMs: Int
        public var topSpeedKph: Double?
        public var minSpeedKph: Double?
        public var avgSpeedKph: Double?
        public var maxRpm: Double?
        public var maxLatG: Double?
        public var fullThrottlePct: Double?
        public var brakingPct: Double?
    }

    public static func lapMetrics(_ entry: LapChannels) -> Metrics {
        let speed = (entry.speed?.isEmpty == false) ? entry.speed : nil
        func share(_ arr: [Double]?, _ min: Double) -> Double? {
            guard let arr, !arr.isEmpty else { return nil }
            return 100 * Double(arr.filter { $0 >= min }.count) / Double(arr.count)
        }
        func max(_ arr: [Double]?) -> Double? {
            guard let arr, !arr.isEmpty else { return nil }
            return arr.max()
        }
        return Metrics(
            timeMs: entry.timeMs,
            topSpeedKph: speed?.max(),
            minSpeedKph: speed?.min(),
            avgSpeedKph: speed.map { $0.reduce(0, +) / Double($0.count) },
            maxRpm: max(entry.rpm),
            maxLatG: max(entry.latG),
            fullThrottlePct: share(entry.throttle, FULL_THROTTLE_PCT),
            brakingPct: share(entry.brake, BRAKING_PCT)
        )
    }
}
