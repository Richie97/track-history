package app.trackevolution.core.telemetry

import app.trackevolution.core.GpsPoint
import app.trackevolution.core.Lap
import app.trackevolution.core.ParsedRecording
import app.trackevolution.core.TraceSample
import app.trackevolution.core.model.SessionChannels

/**
 * One parsed telemetry source, whatever produced it.
 *
 * The shape every parser in `public/js/import/parse.js` resolves to, and the
 * reason the review flow doesn't care where laps came from: a PDR file with
 * beacons arrives with exact laps and skips the line picker, a GoPro clip
 * arrives with a trace and [needsLine], and a phone recording
 * ([ParsedRecording]) converts into the same value via [asTelemetry]. The
 * review flow in `:app` takes this so all three share one screen — the same
 * generalisation NS-30 made on iOS.
 *
 * Immutable, unlike the JS object the importer mutates in place: every step
 * ([TelemetryChannels.attachLapChannels], [Telemetry.applyGate],
 * [PDRLaps.anchorPdrBatch]) returns the value it would have produced. Same
 * names, so the two still diff by eye.
 */
public data class ParsedTelemetry(
    val kind: Kind,
    /** Local `yyyy-MM-dd` from the file, when it carries one. */
    val date: String? = null,
    /** Local `HH:mm:ss`. */
    val time: String? = null,
    val durationS: Double = 0.0,
    val laps: List<ParsedLap> = emptyList(),
    /**
     * Decoded GPS trace in degrees, or null when the source has none the app
     * can use — normal for a PDR recording whose coordinates don't decode.
     */
    val gps: List<GpsPoint>? = null,
    /** The user has to pick a start/finish line before this has laps. */
    val needsLine: Boolean = false,
    /** Best-lap polyline, drawn as the racing line on the event page. */
    val bestLapTrace: List<TraceSample>? = null,
    /** Per-lap channel arrays on a driven-distance grid, stored with the session. */
    val lapChannels: SessionChannels? = null,
    /** Session maxima from a PDR file's car channels. */
    val metrics: Metrics? = null,

    // ---- PDR-only ----------------------------------------------------------

    /**
     * How many beacon crossings the recorder actually logged. Zero means every
     * lap here was derived rather than timed.
     */
    val beaconCount: Int = 0,
    /** Raw latitude and odometer series, kept for lap recovery ([PDRLaps]). */
    val channels: RawChannels? = null,
    /** Scaled car channels for the per-lap graphs. */
    val carChannels: CarChannels = CarChannels(),
    /**
     * The slow channels, keyed by `SCALAR_NAMES`, before they are reduced to one
     * value per lap. A map rather than a data class because nothing reads an
     * individual one — `buildLapChannels` walks the whole list.
     */
    val lapScalarChannels: Map<String, List<ChannelPoint>> = emptyMap(),
    /** Session-level numbers, stored as the channel blob's `meta`. */
    val sessionMeta: SessionMeta? = null,
    /** Set when laps came from lat-vs-distance periodicity rather than beacons. */
    val lapRecovery: LapRecovery? = null,
) {
    /** Which parser produced this. `KIND_LABELS` in the JS. */
    public enum class Kind(public val rawValue: String, public val label: String) {
        PDR("pdr", "PDR"),
        GOPRO("gopro", "GoPro"),
        /** Not a file parser: the in-app lap recorder. */
        LIVE("live", "Recorded"),
    }

    /**
     * Session maxima — each null when the file doesn't carry the channel, or
     * carries one whose peak isn't plausible.
     */
    public data class Metrics(
        val topSpeedKph: Double? = null,
        val maxRpm: Double? = null,
        val maxLatG: Double? = null,
        /**
         * Peak braking, reported positive the way a driver talks about it — it
         * is the negative half of longitudinal G.
         */
        val maxBrakeG: Double? = null,
        val maxBoostKpa: Double? = null,
        val maxOilC: Double? = null,
    )

    /**
     * Session-level numbers from a PDR file, carried into the stored blob's
     * `meta`. `sessionMeta` in the JS.
     */
    public data class SessionMeta(
        val ambientC: Double? = null,
        val intakeC: Double? = null,
        val elevationM: Double? = null,
        /** The car's lifetime odometer, not this session's distance. */
        val odometerKm: Double? = null,
    )

    /** The two raw PDR series lap recovery works from. */
    public data class RawChannels(
        val latPts: List<ChannelPoint>,
        val odoPts: List<ChannelPoint>,
    )

    /**
     * Car channels in display units: speed km/h, latG in G, throttle/brake in
     * %, steering in signed steering-wheel degrees. Null where the file lacks
     * the channel.
     */
    public data class CarChannels(
        val speed: List<ChannelPoint>? = null,
        val rpm: List<ChannelPoint>? = null,
        val latG: List<ChannelPoint>? = null,
        val throttle: List<ChannelPoint>? = null,
        val brake: List<ChannelPoint>? = null,
        val steering: List<ChannelPoint>? = null,
        /** Signed: negative under braking. */
        val longG: List<ChannelPoint>? = null,
        /** Degrees per second, signed. */
        val yaw: List<ChannelPoint>? = null,
        /** 1–8, or 0 for the clutch-in / no-gear state. */
        val gear: List<ChannelPoint>? = null,
        /** (driven − non-driven) wheelspeed, percent. */
        val wheelSlip: List<ChannelPoint>? = null,
        /** Manifold gauge pressure, kPa. */
        val boost: List<ChannelPoint>? = null,
        /** ABS | traction control shl 1 | stability control shl 2. */
        val flags: List<ChannelPoint>? = null,
    ) {
        /** `chans[name]` in the JS. */
        public operator fun get(name: String): List<ChannelPoint>? = when (name) {
            "speed" -> speed
            "rpm" -> rpm
            "latG" -> latG
            "throttle" -> throttle
            "brake" -> brake
            "steering" -> steering
            "longG" -> longG
            "yaw" -> yaw
            "gear" -> gear
            "wheelSlip" -> wheelSlip
            "boost" -> boost
            "flags" -> flags
            else -> null
        }

        public fun with(name: String, values: List<ChannelPoint>?): CarChannels = when (name) {
            "speed" -> copy(speed = values)
            "rpm" -> copy(rpm = values)
            "latG" -> copy(latG = values)
            "throttle" -> copy(throttle = values)
            "brake" -> copy(brake = values)
            "steering" -> copy(steering = values)
            "longG" -> copy(longG = values)
            "yaw" -> copy(yaw = values)
            "gear" -> copy(gear = values)
            "wheelSlip" -> copy(wheelSlip = values)
            "boost" -> copy(boost = values)
            "flags" -> copy(flags = values)
            else -> this
        }
    }

    /** The outcome of lat-vs-distance lap recovery for a beacon-less recording. */
    public data class LapRecovery(
        val laps: List<ParsedLap>,
        val lapM: Double,
        /** Periodicity confidence of the recovered lap length. */
        val r: Double,
        /**
         * Whether the boundaries were pulled onto a real start/finish by a
         * beacon-timed recording in the same batch.
         */
        val anchored: Boolean,
        /** Template-match confidence, once anchored. */
        val phaseR: Double? = null,
    )
}

/**
 * A lap as a parser reports it.
 *
 * [Lap] (the geometry's derived lap) with two differences that matter: a PDR
 * beacon carries an absolute crossing number ([lapNumber]), and a hand-entered
 * lap has no time window at all — which is exactly the case
 * [TelemetryChannels.buildLapChannels] skips.
 */
public data class ParsedLap(
    /** The recorder's own crossing number, when there is one. */
    val lapNumber: Int? = null,
    val timeMs: Int,
    /** Derived rather than timed by a beacon. Rendered with a `~` prefix. */
    val estimated: Boolean,
    /** On the telemetry clock, the same clock as `gps[].t`. */
    val startT: Double? = null,
    val endT: Double? = null,
) {
    public companion object {
        /** A line-derived lap from the geometry port. */
        public fun of(lap: Lap): ParsedLap =
            ParsedLap(timeMs = lap.timeMs, estimated = lap.estimated, startT = lap.startT, endT = lap.endT)
    }
}

/**
 * A finished phone recording as a parsed source, so it enters the same review
 * flow an imported clip does.
 */
public fun ParsedRecording.asTelemetry(): ParsedTelemetry = ParsedTelemetry(
    kind = ParsedTelemetry.Kind.LIVE,
    date = date,
    time = time,
    durationS = durationS,
    laps = emptyList(),
    gps = gps,
    needsLine = needsLine,
)
