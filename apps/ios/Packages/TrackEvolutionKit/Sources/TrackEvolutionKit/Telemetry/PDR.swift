import Foundation

/// Corvette PDR (Cosworth "Marlin PDR") video telemetry parser.
///
/// A port of `public/pdr.js`, line for line and name for name (`gpsFromChannels`,
/// `UNIT_CONV`, `parsePdrFile`), with its test cases (`test/unit/pdr.test.js` →
/// `PDRTests`) and a cross-language fixture (`contracts/logic/video-parsers.json`)
/// pinning lap times to the JS implementation's to the millisecond.
///
/// **This decoder is reverse-engineered.** Its JS comment block is the only
/// specification that exists, so it is reproduced below rather than summarised,
/// and the structure here follows the JS's step for step. Resist restructuring
/// it: the pinned fixtures, not readability, are what say whether the port is
/// right.
///
/// PDR MP4s carry a third track (handler `ctbx`, sample format `marl`) holding
/// telemetry. This reads only the MP4 index and the ~5 MB of telemetry samples
/// through `TelemetryByteSource` — the video itself is never read or uploaded.
///
/// Lap extraction (validated against Cosworth Toolbox lap times from real
/// sessions):
///   - "Beacon" events mark start/finish crossings with millisecond-exact
///     timestamps and an absolute crossing number — but the recorder drops some.
///   - "Recording Event Odometer" is cumulative distance (metres, ~7 Hz).
///     Beacon-to-beacon distance / crossing count = lap length, so missing
///     crossings are recovered at the time distance passes D0 + k·lapLength
///     (validated accuracy: ~50–150 ms; flagged `estimated`).
///   - Crossings before the first / after the last beacon are extrapolated by
///     distance and accepted only if GPS latitude matches the beacon-calibrated
///     start/finish latitude.
///
/// Record framing inside a telemetry sample (this matches ExifTool's GM.pm, the
/// reference decoder for the Marlin format —
/// https://exiftool.org/forum/index.php?topic=11335):
///   - 16-byte full record: hi 2 bits of first byte = 11 (hi byte 0xff ends the
///     sample): `[flags:u4|chan:u28][value:s32][ts:u64 100ns]`
///   - 8-byte delta record: hi 2 bits = 01:
///     `[chanDiff:s6][valueDiff:s24][tsDiff:u32 100ns]` applied to the running
///     channel/value/timestamp state, which persists **across samples**. Any
///     other record is skipped 8 bytes at a time.
///
/// Most of the stream is delta records: a channel gets one full record and then
/// streams diffs. (An earlier version of the JS read only full records, which
/// made it look like GPS wasn't recorded — longitude gets exactly one full record
/// at recording start, with everything after arriving as deltas. Decoding deltas
/// yields ~11 Hz lat/lon plus Speed, RPM, accelerations, etc.)
///
/// Channel definitions live in the `mrld` table (448-byte entries: id u32 at +0,
/// units chars at +12, min/max s32 at +88/+92, multiplier/offset f64 at
/// +112/+120, name chars at +128). raw·multiplier + offset gives SI units
/// (radians for lat/lon, m/s for speed); a per-unit factor converts to display
/// units. Session local date/time is in `mrlv`.
public enum PDR {
    /// Conversions from the SI value (raw · multiplier + offset) to the unit
    /// named in the channel dictionary, as (factor, offset) — mirrors ExifTool
    /// GM.pm's conversions for the units this app surfaces (lat/lon in radians
    /// → degrees, m/s → km/h, m/s² → G, and Cosworth's factor-of-10 rpm).
    ///
    /// Three of these are units the dictionary *labels* in display terms while
    /// storing SI, and getting them wrong is silent rather than obvious:
    /// `"°C"` channels are Kelvin (the channel's own `off` carries
    /// 233.15/253.15), which is why this table holds an offset and not just a
    /// factor; `"kPa"` channels hold Pascals; `"km"` channels hold metres. The
    /// odometer is deliberately not run through this table — it stays raw
    /// because it is the driven-distance axis, not a displayed value.
    public static let UNIT_CONV: [String: (f: Double, off: Double)] = [
        "deg": (180 / .pi, 0),
        "deg/sec": (180 / .pi, 0),
        "kph": (3.6, 0),
        "G": (1 / 9.80665, 0),
        "rpm": (10, 0),
        "%": (100, 0),
        "degC": (1, -273.15),
        "kPa": (0.001, 0),
        "km": (0.001, 0),
    ]

    static func normUnits(_ u: String) -> String {
        u == "°" ? "deg" : (u == "°/sec" ? "deg/sec" : (u == "°C" ? "degC" : u))
    }

    /// Channel-dictionary name → the key this parser knows it by. `CHANNEL_TAGS`
    /// in the JS, kept as an ordered array because the JS builds its bucket map
    /// by walking the keys in insertion order and letting a later one win.
    ///
    /// Channels deliberately left out: the recorder's own CPU/disk
    /// housekeeping, values constant across a session, Boost Pressure Ind
    /// (redundant with Intake Boost Pressure), Vertical Acceleration, Heading,
    /// Engine Torque Req, and the four suspension displacements plus Clutch
    /// Pos, whose scaling needs a second car to validate.
    public static let CHANNEL_TAGS: [(name: String, key: String)] = [
        ("Beacon", "beacon"),
        ("Recording Event Odometer", "odometer"),
        ("Latitude", "latitude"),
        ("Longitude", "longitude"),
        ("Speed", "speed"),
        ("RPM", "rpm"),
        ("Lateral Acceleration", "latAcc"),
        ("Accel Pos", "throttle"),
        ("Brake Pos", "brake"),
        ("Steering Angle", "steering"),
        ("Longitudinal Acceleration", "longAcc"),
        ("Yaw Rate", "yaw"),
        ("Gear", "gear"),
        ("Intake Boost Pressure", "boost"),
        ("Wheelspeed Left Non-Driven", "wsLN"),
        ("Wheelspeed Right Non-Driven", "wsRN"),
        ("Wheelspeed Left Driven", "wsLD"),
        ("Wheelspeed Right Driven", "wsRD"),
        ("ABS Active", "absActive"),
        ("Traction Control Active", "tcActive"),
        ("Vehicle Stability Active", "vscActive"),
        ("Oil Temp", "oilC"),
        ("Oil Pressure", "oilKpa"),
        ("Coolant Temp", "coolantC"),
        ("Trans Oil Temp", "transC"),
        ("Fuel Level", "fuelPct"),
        ("Battery Voltage", "battV"),
        ("LF Tyre Pressure", "tyreKpaLF"),
        ("RF Tyre Pressure", "tyreKpaRF"),
        ("LR Tyre Pressure", "tyreKpaLR"),
        ("RR Tyre Pressure", "tyreKpaRR"),
        ("LF Tyre Temp", "tyreCLF"),
        ("RF Tyre Temp", "tyreCRF"),
        ("LR Tyre Temp", "tyreCLR"),
        ("RR Tyre Temp", "tyreCRR"),
        ("Outside Air Temperature", "ambientC"),
        ("Intake Air Temperature", "intakeC"),
        ("Altitude", "altitude"),
        ("Distance", "carOdo"),  // the car's lifetime odometer
    ]

    /// The `CHANNEL_TAGS` keys reduced to one value per lap rather than a
    /// trace. `SCALAR_CHANNEL_KEYS` in the JS.
    public static let SCALAR_CHANNEL_KEYS = [
        "oilC", "oilKpa", "coolantC", "transC", "fuelPct", "battV",
        "tyreKpaLF", "tyreKpaRF", "tyreKpaLR", "tyreKpaRR",
        "tyreCLF", "tyreCRF", "tyreCLR", "tyreCRR",
    ]

    /// The insertion order of the JS's `tags` object: the four observed
    /// defaults, then whatever the dictionary named. Two keys resolving to one
    /// tag id is pathological but possible (a file with no Latitude entry, and
    /// another channel at 0x31), and the JS's Map lets the later key win — so
    /// the bucket table below is built in this order for the same reason.
    static let TAG_KEY_ORDER: [String] = {
        var out = ["beacon", "odometer", "latitude", "longitude"]
        for (_, key) in CHANNEL_TAGS where !out.contains(key) { out.append(key) }
        return out
    }()

    static let CHANNEL_TAG_BY_NAME: [String: String] = Dictionary(
        uniqueKeysWithValues: CHANNEL_TAGS.map { ($0.name, $0.key) }
    )

    /// 24 h in 100 ns units: anything above is corrupt.
    static let MAX_TICKS = 864_000_000_000

    /// One `mrld` channel-dictionary entry.
    struct ChannelDef {
        var name: String
        var units: String
        var min: Int
        var max: Int
        var mult: Double
        var off: Double
    }

    /// A lat/lon interpretation: how a raw s32 becomes degrees. Lat and lon must
    /// decode under the same one.
    public struct Decoder {
        public var lat: @Sendable (Int) -> Double
        public var lon: @Sendable (Int) -> Double

        public init(lat: @escaping @Sendable (Int) -> Double, lon: @escaping @Sendable (Int) -> Double) {
            self.lat = lat
            self.lon = lon
        }
    }

    // MARK: - GPS decoding

    /// Decode raw Latitude/Longitude channel samples (`{t, v: s32}`) into a GPS
    /// trace in decimal degrees.
    ///
    /// When the file's channel dictionary supplies lat/lon multipliers, that
    /// conversion (radians → degrees) is tried first; then the heuristics —
    /// degrees · 1e7 in the s32, or IEEE float degrees in the same 4 bytes. Every
    /// interpretation is accepted only when the result actually looks like a car
    /// on a track (coordinates in range, extent between ~1 m and ~1 degree).
    /// Returns nil rather than garbage.
    ///
    /// `speedS` (optional Speed-channel series, m/s) or `odo` (optional odometer
    /// series) supplies speed in m/s for the racing line.
    public static func gpsFromChannels(
        _ latPts: [ChannelPoint],
        _ lonPts: [ChannelPoint],
        _ odo: Series? = nil,
        dictConv: Decoder? = nil,
        speedS: Series? = nil
    ) -> [Geo.Point]? {
        if latPts.count < 10 || lonPts.count < 10 { return nil }

        let shared: [@Sendable (Int) -> Double] = [
            { Double($0) / 1e7 },
            { Double(Float(bitPattern: UInt32(bitPattern: Int32(truncatingIfNeeded: $0)))) },
        ]
        // Lat and lon must decode under the same interpretation — a device
        // doesn't mix encodings, and float bits of one channel can masquerade as
        // plausible scaled integers of the other. The dictionary conversion
        // counts as one interpretation (each channel has its own multiplier).
        var decoders = shared.map { Decoder(lat: $0, lon: $0) }
        if let dictConv { decoders.insert(dictConv, at: 0) }

        func decode(_ pts: [ChannelPoint], _ conv: (Int) -> Double, _ limit: Double) -> [ChannelPoint]? {
            var minV = Double.infinity
            var maxV = -Double.infinity
            var out: [ChannelPoint] = []
            out.reserveCapacity(pts.count)
            for p in pts {
                let deg = conv(Int(p.v))
                if deg < minV { minV = deg }
                if deg > maxV { maxV = deg }
                out.append(ChannelPoint(t: p.t, v: deg))
            }
            let span = maxV - minV
            if !span.isFinite || Swift.max(abs(minV), abs(maxV)) > limit { return nil }
            return span > 1e-5 && span < 1 ? out : nil
        }

        for conv in decoders {
            guard let lat = decode(latPts, conv.lat, 90),
                  let lon = decode(lonPts, conv.lon, 180)
            else { continue }
            let lonS = series(lon)
            let t0 = Swift.max(lat[0].t, lon[0].t)
            let t1 = Swift.min(lat[lat.count - 1].t, lon[lon.count - 1].t)
            let gps = lat.filter { $0.t >= t0 && $0.t <= t1 }.map { p in
                Geo.Point(
                    t: p.t,
                    lat: p.v,
                    lon: lonS.at(p.t),
                    v: speedS.map { Swift.max(0, $0.at(p.t)) } ?? odo.map { Swift.max(0, $0.rate(p.t)) }
                )
            }
            return gps.count >= 10 ? gps : nil
        }
        return nil
    }

    // MARK: - The file

    public static func parsePdrFile(_ source: some TelemetryByteSource) throws -> ParsedTelemetry {
        // 1. Locate moov among top-level boxes (usually at file end).
        let moovBox = try MP4.readMoov(source)
        let moov = moovBox.view
        let root = moovBox.root

        // 2. Find the telemetry track (handler 'ctbx').
        var stbl: MP4.Box?
        for trak in MP4.boxes(moov, root.body, root.size).filter({ $0.type == "trak" }) {
            guard let mdia = MP4.child(moov, trak, "mdia") else { continue }
            guard let hdlr = MP4.child(moov, mdia, "hdlr"),
                  MP4.fourcc(moov, hdlr.body + 8) == "ctbx"
            else { continue }
            let minf = MP4.child(moov, mdia, "minf")
            stbl = minf.flatMap { MP4.child(moov, $0, "stbl") }
        }
        guard let stbl else {
            throw TelemetryParseError(message: "No PDR telemetry track in this video", isNoTrack: true)
        }

        guard let stco = MP4.child(moov, stbl, "stco") ?? MP4.child(moov, stbl, "co64"),
              let stsz = MP4.child(moov, stbl, "stsz"),
              let stsd = MP4.child(moov, stbl, "stsd")
        else { throw TelemetryParseError(message: "Telemetry track is missing sample tables") }

        let is64 = stco.type == "co64"
        let nChunks = moov.getUint32(stco.body + 4)
        var offsets: [Int] = []
        for i in 0..<nChunks {
            offsets.append(
                is64
                    ? Int(bitPattern: UInt(moov.getBigUint64(stco.body + 8 + i * 8)))
                    : moov.getUint32(stco.body + 8 + i * 4)
            )
        }
        let fixedSize = moov.getUint32(stsz.body + 4)
        func sizeAt(_ i: Int) -> Int {
            fixedSize != 0 ? fixedSize : moov.getUint32(stsz.body + 12 + i * 4)
        }

        // 3. Channel table (mrld) -> event tag ids; session metadata (mrlv).
        let subs = MP4.boxes(moov, stsd.body + 8 + 16, stsd.start + stsd.size)
        let mrld = subs.first { $0.type == "mrld" }
        let mrlv = subs.first { $0.type == "mrlv" }

        // Observed defaults, overridden by the dictionary when the file has one.
        var tags: [String: Int] = [
            "beacon": 0x36, "odometer": 0x42, "latitude": 0x31, "longitude": 0x32,
        ]

        var dict: [Int: ChannelDef] = [:]
        if let mrld {
            let STRIDE = 448
            let UNITS_OFF = 12
            let NAME_OFF = 128
            var e = mrld.body
            while e + STRIDE <= mrld.start + mrld.size {
                let name = printablePrefix(moov.utf8String(e + NAME_OFF, 63))
                let ch = ChannelDef(
                    name: name,
                    units: normUnits(moov.utf8String(e + UNITS_OFF, 63)),
                    min: moov.getInt32(e + 88),
                    max: moov.getInt32(e + 92),
                    mult: moov.getFloat64(e + 112),
                    off: moov.getFloat64(e + 120)
                )
                let tagId = moov.getUint32(e)
                dict[tagId] = ch
                if let key = CHANNEL_TAG_BY_NAME[name] { tags[key] = tagId }
                e += STRIDE
            }
        }
        let beaconTag = tags["beacon"] ?? 0x36
        let odometerTag = tags["odometer"] ?? 0x42
        let latitudeTag = tags["latitude"] ?? 0x31
        let longitudeTag = tags["longitude"] ?? 0x32
        // raw -> display units (deg, km/h, rpm, G, °C, kPa) via the dictionary
        // entry. The conversion carries an offset as well as a factor, which is
        // what temperatures need.
        func scaler(_ tagId: Int?) -> (@Sendable (Int) -> Double)? {
            guard let tagId, let ch = dict[tagId], ch.mult.isFinite, ch.mult != 0 else { return nil }
            let conv = UNIT_CONV[ch.units] ?? (f: 1, off: 0)
            let mult = ch.mult
            let off = ch.off
            return { (Double($0) * mult + off) * conv.f + conv.off }
        }

        var date: String?
        var time: String?
        if let mrlv {
            let raw = moov.latin1(mrlv.body, mrlv.size - 8)
            date = firstMatch(raw, after: "ldatdate", shape: "dddd-dd-dd")
                ?? firstMatch(raw, after: "datedate", shape: "dddd-dd-dd")
            if let t = firstMatch(raw, after: "ltimtime", shape: "dd-dd-dd") {
                time = t.replacingOccurrences(of: "-", with: ":")
            }
        }

        // 4. Decode the telemetry samples. Full records carry an absolute
        // channel / value / timestamp; delta records adjust the running state
        // (which persists across samples). Values accumulate in raw
        // (pre-multiplier) units.
        var beacons: [ChannelPoint] = []
        // One bucket per known channel. The JS keys a Map by tag id; here the
        // map goes to a slot index instead, so the decode loop does one
        // Int-keyed lookup per sample rather than hashing a name.
        var slotOfKey: [String: Int] = [:]
        for (i, key) in TAG_KEY_ORDER.enumerated() { slotOfKey[key] = i }
        var slotOfTag: [Int: Int] = [:]
        for key in TAG_KEY_ORDER where key != "beacon" {
            if let id = tags[key], let slot = slotOfKey[key] { slotOfTag[id] = slot }
        }
        var buckets = [[ChannelPoint]](repeating: [], count: TAG_KEY_ORDER.count)
        /// The raw samples of a named channel, [] when the file lacks it.
        func rawPts(_ key: String) -> [ChannelPoint] {
            slotOfKey[key].map { buckets[$0] } ?? []
        }

        var lastTicks = 0
        var vals: [Int: Int] = [:]  // running raw value per channel
        var chan: Int?
        var ticks = -1

        func emit(_ ch: Int, _ v: Int, _ tk: Int) {
            if tk < 0 || tk > MAX_TICKS { return }
            if tk > lastTicks { lastTicks = tk }
            let point = ChannelPoint(t: Double(tk) / 1e7, v: Double(v))
            // The beacon test runs before the bucket lookup, as the JS's does.
            if ch == beaconTag {
                beacons.append(point)
            } else if let slot = slotOfTag[ch] {
                buckets[slot].append(point)
            }
        }

        for i in 0..<nChunks {
            try Task.checkCancellation()
            let s = try bufAt(source, offsets[i], sizeAt(i))
            let n = s.byteLength
            var q = 0
            while q + 8 <= n {
                let a0 = s.getUint32(q)
                let hi = a0 >> 24
                if (hi & 0xc0) == 0xc0 {
                    // full record
                    if hi == 0xff { break }  // empty record: end of this sample
                    if q + 16 > n { break }
                    let c = a0 & 0x0fff_ffff
                    chan = c
                    let v = s.getInt32(q + 4)
                    vals[c] = v
                    // Assembled as a Double, exactly as the JS does: a corrupt
                    // high word makes this larger than any Int, and the MAX_TICKS
                    // test below is what stops it poisoning the stream.
                    let tk = Double(s.getUint32(q + 8)) * 4_294_967_296 + Double(s.getUint32(q + 12))
                    q += 16
                    if tk > Double(MAX_TICKS) { continue }  // corrupt timestamp: keep the value, skip the point
                    ticks = Int(tk)
                    emit(c, v, ticks)
                } else if (hi & 0xc0) == 0x40, var c = chan {
                    // delta record
                    ticks += s.getUint32(q + 4)
                    c += (hi & 0x3f) - ((hi & 0x20) != 0 ? 0x40 : 0)
                    chan = c
                    q += 8
                    if vals[c] == nil {
                        // no full record and no dictionary entry to seed from
                        guard let ch = dict[c],
                              let seed = JSMath.trunc((Double(ch.min) + Double(ch.max)) / 2)
                        else { continue }
                        vals[c] = seed
                    }
                    let d = a0 & 0xff_ffff
                    let v = (vals[c] ?? 0) + (d - ((a0 & 0x80_0000) != 0 ? 0x100_0000 : 0))
                    vals[c] = v
                    emit(c, v, ticks)
                } else {
                    q += 8
                }
            }
        }
        beacons = stableSortedByT(beacons)
        for i in buckets.indices { buckets[i] = stableSortedByT(buckets[i]) }
        let odoPts = rawPts("odometer")
        let latPts = rawPts("latitude")
        let lonPts = rawPts("longitude")

        // Scale the car channels to display units and take session maxima.
        func scaleAll(_ pts: [ChannelPoint], _ conv: (@Sendable (Int) -> Double)?) -> [ChannelPoint] {
            guard let conv else { return [] }
            return pts.map { ChannelPoint(t: $0.t, v: conv(Int($0.v))) }
        }
        /// `scaled("speed")` — that channel's samples in display units.
        func scaled(_ key: String) -> [ChannelPoint] {
            scaleAll(rawPts(key), scaler(tags[key]))
        }
        let speed = scaled("speed")  // km/h
        let rpm = scaled("rpm")
        let latAcc = scaled("latAcc")  // G
        let throttle = scaled("throttle")  // % (dict units "%" -> x100)
        let brake = scaled("brake")  // %
        let longAcc = scaled("longAcc")  // G, signed: negative under braking
        let yaw = scaled("yaw")  // deg/s, signed
        let boost = scaled("boost")  // kPa gauge
        // Real firmware stores steering wheel angle in radians with an *empty*
        // units string, so UNIT_CONV's deg conversion never fires — apply it
        // here unless the dictionary already declared degrees.
        let steeringRad = tags["steering"].flatMap { dict[$0] }?.units != "deg"
        let steering = scaled("steering").map {
            ChannelPoint(t: $0.t, v: steeringRad ? $0.v * 180 / .pi : $0.v)
        }  // deg, signed

        // Gear is an enum, not a measurement: 1-8 are gears, and every other
        // value (13 on a real C7, with the clutch down) means "in transition /
        // no gear". Stored as 0 rather than dropped, so the array stays on the
        // grid with its neighbours.
        let gear = scaled("gear").map {
            ChannelPoint(t: $0.t, v: $0.v >= 1 && $0.v <= 8 ? $0.v.rounded() : 0)
        }

        // Wheel slip from the four wheelspeeds, as one channel rather than
        // four: (driven − non-driven) / non-driven, positive under wheelspin
        // and negative under lockup. Below 5 km/h the ratio is noise over a
        // near-zero divisor.
        let wheel = ["wsLN", "wsRN", "wsLD", "wsRD"].map(scaled)
        var wheelSlip: [ChannelPoint] = []
        if wheel.allSatisfy({ $0.count > 10 }) {
            let ln = series(wheel[0]), rn = series(wheel[1])
            let ld = series(wheel[2]), rd = series(wheel[3])
            wheelSlip = wheel[0].map { p in
                let nd = (ln.at(p.t) + rn.at(p.t)) / 2
                let dr = (ld.at(p.t) + rd.at(p.t)) / 2
                let v = nd < 5 ? 0 : ((dr - nd) / nd) * 100
                return ChannelPoint(t: p.t, v: Swift.max(-100, Swift.min(100, v)))
            }
        }

        // ABS / traction control / stability control packed into one bitfield
        // (bit 0 / 1 / 2) — three near-always-zero channels are not worth three
        // slots in the storage budget. Anchored on ABS's timestamps: the three
        // ship together at the same rate, and ABS is the one that fires.
        let absPts = scaled("absActive")
        let tcPts = scaled("tcActive")
        let vscPts = scaled("vscActive")
        var flags: [ChannelPoint] = []
        if absPts.count > 10 {
            let tc = tcPts.count > 10 ? series(tcPts) : nil
            let vsc = vscPts.count > 10 ? series(vscPts) : nil
            flags = absPts.map { p in
                var bits = p.v > 0.5 ? 1 : 0
                if let tc, tc.at(p.t) > 0.5 { bits |= 2 }
                if let vsc, vsc.at(p.t) > 0.5 { bits |= 4 }
                return ChannelPoint(t: p.t, v: Double(bits))
            }
        }

        // Slow housekeeping (0.5-1.4 Hz). At one real sample every 40-90 m
        // these cannot fill a 20 m distance grid, so they are reduced to one
        // value per lap instead (`TelemetryChannels.SCALAR_NAMES`).
        var lapScalarChannels: [String: [ChannelPoint]] = [:]
        for key in SCALAR_CHANNEL_KEYS {
            let arr = scaled(key)
            if !arr.isEmpty { lapScalarChannels[key] = arr }
        }
        func maxOf(_ pts: [ChannelPoint], _ cap: Double) -> Double? {
            var m = -Double.infinity
            for p in pts where p.v > m { m = p.v }
            return m > 0 && m < cap ? m : nil
        }
        let odoS = odoPts.count > 10 ? series(odoPts) : nil
        var topSpeedKph = maxOf(speed, 500)
        if topSpeedKph == nil, let odoS {
            // no Speed channel: top speed from the odometer slope (m/s -> km/h).
            // Below 30 km/h it's paddock crawling, not a session top speed.
            var m = 0.0
            var t = odoS.first.t + 2
            while t <= odoS.last.t - 2 {
                m = Swift.max(m, odoS.rate(t))
                t += 1
            }
            topSpeedKph = m * 3.6 >= 30 && m * 3.6 < 500 ? m * 3.6 : nil
        }
        func absSeries(_ arr: [ChannelPoint]) -> [ChannelPoint] {
            arr.map { ChannelPoint(t: $0.t, v: abs($0.v)) }
        }
        let metrics = ParsedTelemetry.Metrics(
            topSpeedKph: topSpeedKph,
            maxRpm: maxOf(rpm, 20000),
            maxLatG: maxOf(absSeries(latAcc), 5),
            // Braking is the negative half of longitudinal G; reported
            // positive, the way a driver talks about it.
            maxBrakeG: maxOf(longAcc.map { ChannelPoint(t: $0.t, v: -$0.v) }, 5),
            maxBoostKpa: maxOf(boost, 400),
            maxOilC: maxOf(lapScalarChannels["oilC"] ?? [], 250)
        )

        // Session-level numbers: one value each for the whole recording,
        // stored inside the channel blob's `meta` rather than in their own
        // columns — they are context for the graphs, not queryable facts.
        func median(_ arr: [ChannelPoint]) -> Double? {
            guard arr.count >= 3 else { return nil }
            let v = arr.map(\.v).sorted()
            return v[v.count >> 1]
        }
        let altitude = scaled("altitude")
        let carOdo = scaled("carOdo")  // km, the car's lifetime odometer
        let sessionMeta = ParsedTelemetry.SessionMeta(
            ambientC: median(scaled("ambientC")),
            intakeC: median(scaled("intakeC")),
            elevationM: altitude.count > 10
                ? (altitude.map(\.v).max() ?? 0) - (altitude.map(\.v).min() ?? 0)
                : nil,
            odometerKm: carOdo.isEmpty ? nil : carOdo.map(\.v).max()
        )

        // GPS trace: dictionary conversion first (radians -> degrees), then the
        // heuristic decoders. Speed channel (km/h -> m/s) beats odometer slope
        // for the racing-line speeds.
        let latConv = scaler(tags["latitude"])
        let lonConv = scaler(tags["longitude"])
        let gps = gpsFromChannels(
            latPts, lonPts, odoS,
            dictConv: latConv.flatMap { l in lonConv.map { Decoder(lat: l, lon: $0) } },
            speedS: speed.count > 10 ? series(speed.map { ChannelPoint(t: $0.t, v: $0.v / 3.6) }) : nil
        )

        // A channel is worth handing on only when it actually has a series
        // behind it; ten samples is the same floor buildLapChannels applies.
        func dense(_ arr: [ChannelPoint]) -> [ChannelPoint]? { arr.count > 10 ? arr : nil }

        // 5. Build the full crossing list.
        var crossings = beacons.map { Crossing(v: $0.v, t: $0.t, exact: true) }

        if beacons.count >= 2 && odoPts.count > 10 {
            let odo = series(odoPts)
            let lat = latPts.count > 10 ? series(latPts) : nil
            let d = beacons.map { odo.at($0.t) }
            let first = beacons[0]
            let last = beacons[beacons.count - 1]
            let lapLen = (d[d.count - 1] - d[0]) / (last.v - first.v)

            // beacon-calibrated line signature for validating extrapolated crossings
            let latAtLine = lat.map { l in beacons.reduce(0.0) { $0 + l.at($1.t) } / Double(beacons.count) }
            let latSpan = lat != nil
                ? (latPts.map(\.v).max() ?? 0) - (latPts.map(\.v).min() ?? 0)
                : 0
            let odoRateAtLine = beacons.reduce(0.0) { $0 + odo.rate($1.t) } / Double(beacons.count)

            // fill gaps between known beacons using per-gap lap length
            for i in 1..<beacons.count {
                let a = beacons[i - 1]
                let b = beacons[i]
                let gap = b.v - a.v
                if gap <= 1 { continue }
                let da = odo.at(a.t)
                let Lg = (odo.at(b.t) - da) / gap
                var k = 1.0
                while k < gap {
                    crossings.append(Crossing(v: a.v + k, t: odo.timeAt(da + k * Lg), exact: false))
                    k += 1
                }
            }

            // extrapolate before first / after last beacon while the car is still lapping
            func tryExtrapolate(_ v: Double, _ dTarget: Double) -> Crossing? {
                if dTarget < odo.first.v + lapLen * 0.02 || dTarget > odo.last.v - lapLen * 0.02 { return nil }
                let t = odo.timeAt(dTarget)
                // car must be at pace (not in pits/paddock)
                if odo.rate(t) < 0.4 * odoRateAtLine { return nil }
                // GPS latitude must match the line (within 4% of the track's lat extent)
                if let lat, let latAtLine, abs(lat.at(t) - latAtLine) > 0.04 * latSpan { return nil }
                return Crossing(v: v, t: t, exact: false)
            }
            var v = first.v - 1
            var k = 1.0
            while v >= 0 {
                guard let c = tryExtrapolate(v, d[0] - k * lapLen) else { break }
                crossings.append(c)
                v -= 1
                k += 1
            }
            v = last.v + 1
            k = 1
            while true {
                guard let c = tryExtrapolate(v, d[d.count - 1] + k * lapLen) else { break }
                crossings.append(c)
                v += 1
                k += 1
            }
        }
        crossings = stableSorted(crossings) { (c: Crossing) in c.t }

        // 6. Laps = deltas between consecutive crossings. startT/endT are on the
        // telemetry clock (seconds), same clock as the gps trace's t.
        var laps: [ParsedLap] = []
        if crossings.count > 1 {
            for i in 1..<crossings.count {
                laps.append(
                    ParsedLap(
                        lapNumber: JSMath.roundToInt(crossings[i].v),
                        timeMs: JSMath.roundToInt((crossings[i].t - crossings[i - 1].t) * 1000) ?? 0,
                        estimated: !(crossings[i].exact && crossings[i - 1].exact),
                        startT: crossings[i - 1].t,
                        endT: crossings[i].t
                    )
                )
            }
        }

        return ParsedTelemetry(
            kind: .pdr,
            date: date,
            time: time,
            durationS: Double(lastTicks) / 1e7,
            laps: laps,
            gps: gps,
            needsLine: false,
            metrics: metrics,
            beaconCount: beacons.count,
            channels: ParsedTelemetry.RawChannels(latPts: latPts, odoPts: odoPts),
            carChannels: ParsedTelemetry.CarChannels(
                speed: dense(speed),
                rpm: dense(rpm),
                latG: dense(absSeries(latAcc)),
                throttle: dense(throttle),
                brake: dense(brake),
                steering: dense(steering),
                longG: dense(longAcc),
                yaw: dense(yaw),
                gear: dense(gear),
                wheelSlip: dense(wheelSlip),
                boost: dense(boost),
                flags: dense(flags)
            ),
            lapScalarChannels: lapScalarChannels,
            sessionMeta: sessionMeta
        )
    }

    /// One start/finish crossing: the recorder's absolute crossing number, when
    /// it happened, and whether a beacon timed it or distance placed it.
    struct Crossing {
        var v: Double
        var t: Double
        var exact: Bool
    }

    // MARK: - Small helpers the JS gets from the language

    /// `.replace(/[^\x20-\x7e].*$/, "")` — a dictionary name is ASCII up to the
    /// first byte that isn't, then junk.
    private static func printablePrefix(_ s: String) -> String {
        var out = String.UnicodeScalarView()
        for scalar in s.unicodeScalars {
            if scalar.value < 0x20 || scalar.value > 0x7e { break }
            out.append(scalar)
        }
        return String(out)
    }

    /// The first `marker`-prefixed run matching `shape`, where `d` is a digit and
    /// every other character is itself. Stands in for the JS's two small regexes
    /// over the `mrlv` box; a literal scan avoids depending on a regex flavour
    /// for something this fixed.
    private static func firstMatch(_ raw: String, after marker: String, shape: String) -> String? {
        let chars = Array(raw)
        let mark = Array(marker)
        let want = Array(shape)
        guard chars.count >= mark.count + want.count else { return nil }
        for start in 0...(chars.count - mark.count - want.count) {
            guard Array(chars[start..<(start + mark.count)]) == mark else { continue }
            let body = Array(chars[(start + mark.count)..<(start + mark.count + want.count)])
            var ok = true
            for (i, w) in want.enumerated() {
                if w == "d" {
                    if !body[i].isASCIIDigit { ok = false; break }
                } else if body[i] != w {
                    ok = false
                    break
                }
            }
            if ok { return String(body) }
        }
        return nil
    }
}

/// `Array.prototype.sort` is stable in JavaScript and `Array.sort` is not in
/// Swift. Two channel samples sharing a timestamp reordering would move an
/// interpolated lap boundary, so the ports sort stably everywhere the JS does.
func stableSorted<T>(_ items: [T], by key: (T) -> Double) -> [T] {
    items.enumerated()
        .sorted { a, b in
            let ka = key(a.element)
            let kb = key(b.element)
            return ka == kb ? a.offset < b.offset : ka < kb
        }
        .map(\.element)
}

func stableSortedByT(_ items: [ChannelPoint]) -> [ChannelPoint] {
    stableSorted(items) { $0.t }
}
