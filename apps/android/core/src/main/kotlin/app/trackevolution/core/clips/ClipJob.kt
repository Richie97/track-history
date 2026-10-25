package app.trackevolution.core.clips

import app.trackevolution.core.model.ClipCreate
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * One lap's clip on its way to the server (NS-45; one per lap since NS-50):
 * `{ session id (temp or real), time_ms, lap_num?, file, size, duration, offset, clip id?, uploaded parts }`,
 * the shape the spec fixes for both phones, plus what this side needs to say
 * where it is (the lap page's *Video uploading* / *Couldn't save this lap's
 * video*) and to give up honestly.
 *
 * Persisted as JSON in the app's `clips/` directory by [ClipManifest] — not a
 * Room table, so the offline database owes no migration for it.
 */
@Serializable
public data class ClipJob(
    /** Stable for the job's life: its manifest key and its WorkManager unique name. */
    val id: String,
    /**
     * The session the clip belongs to. **Negative while the session's create is
     * still in the offline queue** — the temp id `OfflineStore` gave it — and
     * swapped for the real id through the store's id map once it flushes.
     */
    @SerialName("session_id") val sessionId: Int,
    /** The event the session is on, for the lap page to find its pending jobs. Temp too, until it isn't. */
    @SerialName("event_id") val eventId: Int,
    /** The lap's time: how `POST /sessions/:id/clip` finds the lap. */
    @SerialName("time_ms") val timeMs: Int,
    /**
     * The lap's place in its session (NS-50), sent beside [timeMs] so a tie on
     * time reaches the right lap, and how the lap page finds its own job when
     * a session saves every lap. Null on a job from a manifest written before
     * it existed, which then posts without it and is matched by time.
     */
    @SerialName("lap_num") val lapNum: Int? = null,
    /** The cut clip, in app-private storage. Null until the cut has finished. */
    val file: String? = null,
    @SerialName("size_bytes") val sizeBytes: Long = 0,
    @SerialName("duration_ms") val durationMs: Int = 0,
    /** Where the lap starts inside the clip, measured from the cut. */
    @SerialName("lap_offset_ms") val lapOffsetMs: Int = 0,
    @SerialName("clip_id") val clipId: Int? = null,
    @SerialName("part_bytes") val partBytes: Long? = null,
    val parts: Int? = null,
    /** Part numbers the server holds, as of the last create or part upload. */
    val uploaded: List<Int> = emptyList(),
    val state: State = State.CUTTING,
    /** Consecutive retryable failures — the backoff's exponent. Reset by any success. */
    val failures: Int = 0,
    /**
     * Times the server lost the upload under us (a 404 on a part or on
     * `complete`: deleted on another device, or swept as a week-stale upload)
     * and it was started over. Past [ClipUploadQueue.MAX_RESTARTS] the job is dropped.
     */
    val restarts: Int = 0,
    /** Epoch ms before which nothing is tried (backoff). */
    @SerialName("not_before_ms") val notBeforeMs: Long? = null,
    /** Epoch ms, for pruning failed jobs a while after they have been said. */
    @SerialName("created_at") val createdAt: Long,
    /**
     * Why the upload was given up on — a [ClipUploadQueue.DropReason]'s raw
     * value, the strings iOS's manifest keeps — for a [State.DROPPED] job.
     */
    @SerialName("drop_reason") val dropReason: String? = null,
    /** Epoch ms the cut failed or the upload was dropped; the week a failure is kept counts from here. */
    @SerialName("failed_at") val failedAt: Long? = null,
) {
    /** The body of `POST /sessions/:id/clip` for this job — iOS's `createBody`. */
    val createBody: ClipCreate
        get() = ClipCreate(timeMs = timeMs, sizeBytes = sizeBytes, durationMs = durationMs, lapOffsetMs = lapOffsetMs, lapNum = lapNum)

    @Serializable
    public enum class State {
        /** Being cut from the source video. Interrupted by a process death, it is [CUT_FAILED]. */
        @SerialName("cutting") CUTTING,

        /** Cut and waiting to upload, or uploading. */
        @SerialName("pending") PENDING,

        /**
         * The cut failed: nothing was written, and the lap page says *"Couldn't
         * save this lap's video."* once. The session is fine.
         */
        @SerialName("cut_failed") CUT_FAILED,

        /**
         * The upload was given up on ([dropReason] says why) and its clip file
         * deleted: kept only so the lap page can say so once, rather than the
         * video quietly never appearing — iOS's `failedCuts` entry with a
         * `reason`. The session is fine.
         */
        @SerialName("dropped") DROPPED,
    }

    /** A cut that failed or an upload given up on, waiting to be said on its lap. */
    val failed: Boolean get() = state == State.CUT_FAILED || state == State.DROPPED
}
