package app.trackevolution.core.clips

import app.trackevolution.core.model.ClipCreate
import app.trackevolution.core.model.ClipUpload
import app.trackevolution.core.model.Lap
import app.trackevolution.core.offline.OfflineStore

/**
 * The clip uploader's state machine (NS-45) — the port of the iOS Kit's
 * `ClipUploadQueue` under the same names, with its tests ported one for one in
 * `ClipUploadQueueTest`. Pure: no network, no file, no clock, so every
 * transition is pinned on the JVM. [ClipUploadRunner] is the loop that drives
 * it, and `ClipUploadWorker` in `:app` the shell around that.
 *
 * A job goes **create → parts → complete**: `POST /sessions/:id/clip` answers a
 * clip id, the part size and (on a resume) the parts already held; each part
 * is `PUT /clips/:id/parts/:n`, exactly `partBytes` long but the last; `POST
 * /clips/:id/complete` stitches them. The driver loop:
 *
 * ```
 * loop:
 *   action = nextAction(job, session = sessionState(...), nowMs)
 *   perform action            // the app's HTTP, file and timer work
 *   outcome = apply(job, action, response, nowMs)
 *   persist / delete the file per outcome
 * ```
 *
 * The transitions — the same table as iOS's, and the tests pin it row by row:
 *
 * | Step | Answer | Then |
 * |---|---|---|
 * | any | session id still temp, its create still queued | wait for the offline queue |
 * | any | session id temp, create gone (the server refused it) | **drop** |
 * | any | `notBeforeMs` in the future | wait until then |
 * | create | 2xx | take `clip_id`, `part_bytes`, `parts`, `uploaded` |
 * | create | 409 *clip storage full* / *lap already has a clip* | **drop** — neither changes on retry |
 * | create | 402, 404, 400, any other 4xx | **drop** |
 * | part | 2xx | mark the part uploaded |
 * | part | 409 (*clip already uploaded*) | treat every part as held; complete |
 * | part | 404 | **restart** from create (the server lost the upload) |
 * | part | 400 / 411 (sizes disagree) | **drop** |
 * | complete | 2xx | **finished** — delete the file |
 * | complete | 409 with `missing` | forget those parts; send them again |
 * | complete | 404 | **restart** |
 * | any | transport, 401, 408, 429, 5xx | **back off**: `failures + 1`, wait [backoffMs] |
 *
 * A restart past [MAX_RESTARTS] drops the job, so a clip that keeps vanishing
 * can't upload forever. Nothing is dropped for being offline, however long.
 */
public object ClipUploadQueue {
    /** The first retry's wait, doubled per consecutive failure up to the cap. */
    public const val BACKOFF_BASE_MS: Long = 30_000
    public const val BACKOFF_MAX_MS: Long = 60L * 60 * 1000
    public const val MAX_RESTARTS: Int = 3

    /** Where a job's session stands. */
    public sealed interface SessionState {
        /** A server id the routes can use. */
        public data class Real(val id: Int) : SessionState

        /** A temp id whose create is still in the offline queue. */
        public data object Waiting : SessionState

        /** A temp id with no create behind it and no mapping: the server refused the session. */
        public data object Lost : SessionState
    }

    /** Resolve a job's session id through the offline store's id map. */
    public fun sessionState(sessionId: Int, mapped: Int?, queued: Boolean): SessionState = when {
        !OfflineStore.isTemp(sessionId) -> SessionState.Real(sessionId)
        mapped != null -> SessionState.Real(mapped)
        queued -> SessionState.Waiting
        else -> SessionState.Lost
    }

    /** What to do next. */
    public sealed interface Action {
        public data object WaitForSession : Action

        public data class WaitUntil(val ms: Long) : Action

        public data class Create(val sessionId: Int, val body: ClipCreate) : Action

        public data class UploadPart(val clipId: Int, val part: Int, val offset: Long, val length: Long) : Action

        public data class Complete(val clipId: Int) : Action

        public data class Drop(val reason: DropReason) : Action
    }

    /** Why a job was given up on — the same strings as iOS's `DropReason`. */
    public enum class DropReason(public val rawValue: String) {
        /** The session the clip belongs to never reached the server. */
        SESSION_LOST("session lost"),

        /** `clip storage full`. */
        STORAGE_FULL("clip storage full"),

        /** `lap already has a clip`. */
        ALREADY_HAS_CLIP("lap already has a clip"),

        /** 402: the account isn't Pro (any more) when the upload started. */
        PRO_REQUIRED("pro required"),

        /** 404 on create: the session or its lap is gone. */
        NOT_FOUND("not found"),

        /** Any other refusal the server won't change its mind about — or a cut file that is gone. */
        REFUSED("refused"),

        /** The server lost the upload more than [MAX_RESTARTS] times. */
        TOO_MANY_RESTARTS("too many restarts"),
    }

    /** What the step got back. */
    public sealed interface Response {
        /** The create's 2xx. */
        public data class Created(val start: ClipUpload) : Response

        /** A part's or `complete`'s 2xx. */
        public data object Ok : Response

        /** `complete`'s 409 with the parts the server is missing. */
        public data class MissingParts(val missing: List<Int>) : Response

        /** Any other non-2xx, with the server's `{ error }`. */
        public data class Status(val status: Int, val error: String?) : Response

        /** No answer at all. */
        public data object Transport : Response
    }

    /** The result of applying a response. */
    public sealed interface Outcome {
        /** Keep going with the updated job (persist it). */
        public data class Continue(val job: ClipJob) : Outcome

        /** `complete` answered: delete the local file and the job. */
        public data object Finished : Outcome

        /** Give up: delete the local file and the job. */
        public data class Dropped(val reason: DropReason) : Outcome
    }

    public fun nextAction(job: ClipJob, session: SessionState, nowMs: Long): Action {
        val sessionId = when (session) {
            SessionState.Lost -> return Action.Drop(DropReason.SESSION_LOST)
            SessionState.Waiting -> return Action.WaitForSession
            is SessionState.Real -> session.id
        }
        job.notBeforeMs?.let { if (it > nowMs) return Action.WaitUntil(it) }
        val clipId = job.clipId
        val partBytes = job.partBytes
        val parts = job.parts
        if (clipId == null || partBytes == null || parts == null) return Action.Create(sessionId, job.createBody)
        nextPart(job)?.let { part ->
            val (offset, length) = partRange(job.sizeBytes, partBytes, parts, part)
            return Action.UploadPart(clipId, part, offset, length)
        }
        return Action.Complete(clipId)
    }

    /** The lowest part the server doesn't hold, or null when it holds them all. */
    public fun nextPart(job: ClipJob): Int? {
        val parts = job.parts ?: return null
        if (parts <= 0) return null
        val held = job.uploaded.toSet()
        return (1..parts).firstOrNull { it !in held }
    }

    /**
     * Byte range of part [part] (1-based): every part [partBytes] long but the
     * last, which is the remainder — `partSize` in `src/lib/clips.ts`.
     */
    public fun partRange(sizeBytes: Long, partBytes: Long, parts: Int, part: Int): Pair<Long, Long> {
        val offset = (part - 1) * partBytes
        val length = if (part < parts) partBytes else sizeBytes - partBytes * (parts - 1)
        return offset to length
    }

    /** The wait after [failures] consecutive failures: 30 s, 1 min, 2 min … 1 h. */
    public fun backoffMs(failures: Int): Long {
        if (failures <= 0) return 0
        val exponent = minOf(failures - 1, 20)
        return minOf(BACKOFF_BASE_MS shl exponent, BACKOFF_MAX_MS)
    }

    public fun apply(job: ClipJob, action: Action, response: Response, nowMs: Long): Outcome {
        // Retryable everywhere: no answer, or an answer that says "later".
        if (isRetryable(response)) {
            val failures = job.failures + 1
            return Outcome.Continue(job.copy(failures = failures, notBeforeMs = nowMs + backoffMs(failures)))
        }
        return when (action) {
            is Action.Create -> when (response) {
                is Response.Created -> {
                    val start = response.start
                    if (start.partBytes <= 0 || start.parts <= 0) {
                        Outcome.Dropped(DropReason.REFUSED)
                    } else {
                        succeeded(
                            job.copy(
                                clipId = start.clipId,
                                partBytes = start.partBytes,
                                parts = start.parts,
                                uploaded = start.uploaded.filter { it in 1..start.parts }.distinct().sorted(),
                            ),
                        )
                    }
                }
                is Response.Status -> when {
                    response.status == 409 && response.error == DropReason.STORAGE_FULL.rawValue -> Outcome.Dropped(DropReason.STORAGE_FULL)
                    response.status == 409 && response.error == DropReason.ALREADY_HAS_CLIP.rawValue -> Outcome.Dropped(DropReason.ALREADY_HAS_CLIP)
                    response.status == 402 -> Outcome.Dropped(DropReason.PRO_REQUIRED)
                    response.status == 404 -> Outcome.Dropped(DropReason.NOT_FOUND)
                    else -> Outcome.Dropped(DropReason.REFUSED)
                }
                else -> Outcome.Dropped(DropReason.REFUSED)
            }
            is Action.UploadPart -> when {
                response == Response.Ok -> succeeded(job.copy(uploaded = (job.uploaded + action.part).distinct().sorted()))
                // The clip is already ready (a complete whose answer was lost):
                // `complete` answers it, so go straight there.
                response is Response.Status && response.status == 409 -> {
                    val parts = job.parts
                    succeeded(if (parts != null && parts > 0) job.copy(uploaded = (1..parts).toList()) else job)
                }
                response is Response.Status && response.status == 404 -> restart(job)
                else -> Outcome.Dropped(DropReason.REFUSED)
            }
            is Action.Complete -> when {
                response == Response.Ok -> Outcome.Finished
                response is Response.MissingParts -> {
                    val gone = response.missing.toSet()
                    succeeded(job.copy(uploaded = job.uploaded.filter { it !in gone }))
                }
                response is Response.Status && response.status == 404 -> restart(job)
                else -> Outcome.Dropped(DropReason.REFUSED)
            }
            Action.WaitForSession, is Action.WaitUntil, is Action.Drop -> Outcome.Continue(job)
        }
    }

    /**
     * Which answers mean "try again later": nothing came back, the session
     * token was refused (the app re-authenticates, and the job waits), the
     * server was busy, or it failed.
     */
    public fun isRetryable(response: Response): Boolean = when (response) {
        Response.Transport -> true
        is Response.Status -> response.status == 401 || response.status == 408 || response.status == 429 || response.status >= 500
        is Response.Created, Response.Ok, is Response.MissingParts -> false
    }

    private fun succeeded(job: ClipJob): Outcome = Outcome.Continue(job.copy(failures = 0, notBeforeMs = null))

    private fun restart(job: ClipJob): Outcome {
        val restarts = job.restarts + 1
        if (restarts > MAX_RESTARTS) return Outcome.Dropped(DropReason.TOO_MANY_RESTARTS)
        return succeeded(job.copy(restarts = restarts, clipId = null, partBytes = null, parts = null, uploaded = emptyList()))
    }

    // ---- What the lap page reads ------------------------------------------

    /**
     * Whether a job (or a failed cut) is for this lap: the same session —
     * matched on either its temp or its real id — and the same time.
     */
    public fun isFor(jobSessionId: Int, jobTimeMs: Int, sessionId: Int, resolved: Int?, timeMs: Int): Boolean =
        jobTimeMs == timeMs && (jobSessionId == sessionId || (resolved != null && resolved == sessionId))

    /**
     * The lap a clip with this time lands on: the lowest lap number among the
     * session's laps with that time, the server's rule. A second lap tied on
     * time never shows the first one's pending upload.
     */
    public fun clipLap(laps: List<Lap>, timeMs: Int): Lap? = laps.filter { it.timeMs == timeMs }.minByOrNull { it.lapNum }
}
