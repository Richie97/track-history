package app.trackevolution.core.telemetry

import app.trackevolution.core.Units
import app.trackevolution.core.model.ClipStorage
import app.trackevolution.core.model.Entitlement
import kotlin.math.max
import kotlin.math.min

/**
 * Best-lap video clips (NS-45): which lap of an imported video gets saved, the
 * window cut around it, and what the import review's *Save best-lap video* row
 * and Settings' storage line say.
 *
 * The port of `public/js/import/clip.js` under the same names, pinned case for
 * case by `contracts/logic/lap-clips.json` — the fixture the iOS Kit asserts
 * against too, so both ports are checked against the web implementation rather
 * than against each other.
 *
 * Times are seconds on the telemetry clock (a lap's `startT`/`endT`), which is
 * the file's media timeline: the telemetry track is muxed into the same MP4 —
 * verified on real PDR and PDR 2.5 footage to within a quarter second (the
 * spec's *As built*). The window here is the *requested* cut; a passthrough cut
 * starts at the keyframe before it, so `ClipCutter` reports the lap's real
 * offset inside the clip it made.
 */
public object LapClips {
    /** Seconds kept before the lap starts, clamped to the file. */
    public const val PRE_ROLL_S: Double = 3.0

    /**
     * Seconds kept after the lap ends, clamped to the file. The longer of the two:
     * a lap's `endT` can sit a beat early of the car crossing the line on video,
     * and a clip that stops on the line looks cut off.
     */
    public const val POST_ROLL_S: Double = 4.0

    /**
     * Seconds of run-up a player shows before the line: it opens this far ahead
     * of `lapOffsetMs`, so the crossing is seen.
     */
    public const val PLAYBACK_LEAD_S: Double = 2.0

    /** Where a player opens a clip, in ms: [PLAYBACK_LEAD_S] ahead of the lap's start inside it, never before 0. */
    public fun playbackStartMs(lapOffsetMs: Int): Int = maxOf(0, lapOffsetMs - (PLAYBACK_LEAD_S * 1000).toInt())

    /** A lap longer than this gets no clip (inclusive: exactly 600 s still does). */
    public const val MAX_CLIP_S: Double = 600.0

    /**
     * The parsers whose source is a video file. A phone recording (`live`), a
     * `.vbo` and a Track Precision `.csv` have no video to cut. PDR 2.5 resolves
     * to `pdr`.
     */
    public val VIDEO_KINDS: List<String> = listOf("pdr", "gopro")

    /** `{ startS, endS, lapOffsetS }` — the padded window and where the lap starts in it. */
    public data class ClipWindow(val startS: Double, val endS: Double, val lapOffsetS: Double)

    /** `{ lap, index }` — the lap to save and its index into `parsed.laps`. */
    public data class ClipCandidate(val lap: ParsedLap, val index: Int)

    /**
     * A review item as [clipOffer] reads it — the native `ReviewItem`'s names
     * plus the source file's size, as `clip.js` takes them.
     */
    public data class OfferItem(val parsed: ParsedTelemetry?, val include: Boolean, val fileBytes: Long?)

    /** Which state the review row is in. [rawValue] is the JS string. */
    public enum class ClipOffer(public val rawValue: String) {
        /** No included item has a clip candidate — the row isn't drawn. */
        NONE("none"),

        /** A free account: drawn as the Pro offer, never hidden. */
        LOCKED("locked"),

        /** The candidates' estimates would take storage over the quota. */
        FULL("full"),

        /** Offered (the switch itself starts on, every review). */
        ON("on"),
    }

    private fun Double?.finite(): Boolean = this != null && this.isFinite()

    /**
     * The padded window around one lap, clamped to `[0, durationS]`, or null
     * when the lap has no usable window: no `startT`/`endT`, one outside the
     * file, or a lap longer than [MAX_CLIP_S].
     */
    public fun clipWindow(lap: ParsedLap?, durationS: Double?): ClipWindow? {
        if (lap == null || !lap.startT.finite() || !lap.endT.finite() || !durationS.finite()) return null
        val startT = lap.startT!!
        val endT = lap.endT!!
        val duration = durationS!!
        if (startT < 0 || endT <= startT || endT > duration) return null
        if (endT - startT > MAX_CLIP_S) return null
        val startS = max(0.0, startT - PRE_ROLL_S)
        val endS = min(duration, endT + POST_ROLL_S)
        return ClipWindow(startS = startS, endS = endS, lapOffsetS = startT - startS)
    }

    /**
     * The lap to save from one parsed video, or null. The best lap that has a
     * usable window; a tie on time goes to the earlier index (the lower lap
     * number), which is also the lap the server attaches the clip to
     * (`POST /sessions/:id/clip` keys on the time, lowest `lap_num` first). An
     * `estimated` lap still counts: an estimated boundary is still a boundary,
     * and the padding absorbs the error.
     */
    public fun clipCandidate(parsed: ParsedTelemetry?): ClipCandidate? {
        if (parsed == null || parsed.kind.rawValue !in VIDEO_KINDS) return null
        var best: ClipCandidate? = null
        parsed.laps.forEachIndexed { index, lap ->
            if (clipWindow(lap, parsed.durationS) == null) return@forEachIndexed
            val current = best
            if (current == null || lap.timeMs < current.lap.timeMs) best = ClipCandidate(lap, index)
        }
        return best
    }

    /**
     * Roughly how big the cut will be: the file's average bitrate over the
     * window. A passthrough cut keeps the source's bitrate, so this is close
     * (within 1–7% on real footage); it is what the row's "about N MB" and the
     * quota check use. Null when there's nothing to estimate from.
     */
    public fun estimateClipBytes(lap: ParsedLap?, fileBytes: Long?, durationS: Double?): Long? {
        val w = clipWindow(lap, durationS) ?: return null
        if (fileBytes == null || fileBytes <= 0 || durationS!! <= 0) return null
        // Math.round in JS: half up, on the double — floor(x + 0.5).
        return Math.floor((fileBytes.toDouble() / durationS) * (w.endS - w.startS) + 0.5).toLong()
    }

    /**
     * Which state the review row is in, over the review's items. [clips] is
     * `user.clips` from `GET /api/me`, and may be missing from a cached `/me`
     * older than the field — in which case nothing is known to be full.
     */
    public fun clipOffer(items: List<OfferItem>, entitlement: Entitlement?, clips: ClipStorage?): ClipOffer {
        val candidates = items
            .filter { it.include }
            .mapNotNull { item -> clipCandidate(item.parsed)?.let { item to it } }
        if (candidates.isEmpty()) return ClipOffer.NONE
        if (!Entitlement.canSaveLapVideo(entitlement)) return ClipOffer.LOCKED
        if (clips != null) {
            val adding = candidates.sumOf { (item, c) ->
                estimateClipBytes(c.lap, item.fileBytes, item.parsed?.durationS) ?: 0L
            }
            if (clips.usedBytes + adding > clips.quotaBytes) return ClipOffer.FULL
        }
        return ClipOffer.ON
    }

    /**
     * The row's second sentence: who else will see the video. One sentence for
     * any number of coaches — naming them is the Coaching page's job, and a
     * count in a switch's subtitle reads as a warning.
     */
    public fun clipOfferNote(clips: ClipStorage?): String =
        if (clips != null && clips.coachCount >= 1) "Your coaches can watch it too." else ""

    private const val MiB: Double = 1024.0 * 1024.0
    private const val GiB: Double = 1024.0 * MiB

    /**
     * "150 MB", "3.2 GB", "20 GB": binary units, as the quota is set, with GB
     * to one decimal and a whole number left whole. The tenth is rounded the
     * way `toFixed` rounds — on the double's exact binary value, half up — so
     * 3.25 GiB (exact) is "3.3" and 3.35 GiB (just under, in binary) is "3.3";
     * `%.1f` gets one of those wrong.
     */
    public fun fmtClipBytes(bytes: Double?): String {
        if (bytes == null || !bytes.isFinite() || bytes <= 0) return "0 MB"
        val mb = max(1.0, Math.floor(bytes / MiB + 0.5)).toLong()
        if (mb < 1024) return "$mb MB"
        val gb = Units.toFixed(bytes / GiB, 1)
        return "${if (gb.endsWith(".0")) gb.dropLast(2) else gb} GB"
    }

    public fun fmtClipBytes(bytes: Long?): String = fmtClipBytes(bytes?.toDouble())

    /** The row's first sentence, with the size estimate when there is one. */
    public fun clipOfferText(estimateBytes: Long?): String {
        val size = if (estimateBytes != null && estimateBytes > 0) ", about ${fmtClipBytes(estimateBytes)} each" else ""
        return "A clip of each session's fastest lap$size. Uploads on Wi-Fi."
    }

    /** What the row says, switched off and disabled, once storage is full. */
    public fun clipFullText(clips: ClipStorage?): String {
        val quota = if (clips != null) " (${fmtClipBytes(clips.quotaBytes)})" else ""
        return "Your lap video storage is full$quota. Delete old clips from a lap's page."
    }

    /** Settings' storage line: "Lap videos: 3.2 GB of 20 GB". Null without the field. */
    public fun clipStorageLine(clips: ClipStorage?): String? {
        if (clips == null) return null
        return "Lap videos: ${fmtClipBytes(clips.usedBytes)} of ${fmtClipBytes(clips.quotaBytes)}"
    }
}
