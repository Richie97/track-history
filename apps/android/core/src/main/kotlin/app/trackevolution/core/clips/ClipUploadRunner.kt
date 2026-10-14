package app.trackevolution.core.clips

import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.api.ClipMissingParts
import app.trackevolution.core.clips.ClipUploadQueue.Action
import app.trackevolution.core.clips.ClipUploadQueue.DropReason
import app.trackevolution.core.clips.ClipUploadQueue.Response
import app.trackevolution.core.model.ClipCreate
import app.trackevolution.core.model.ClipUpload
import app.trackevolution.core.offline.OfflineStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.File
import java.util.concurrent.atomic.AtomicLong

/**
 * Drives one [ClipJob] through [ClipUploadQueue] (NS-45) — the loop iOS's
 * `ClipUploader.step` runs, with the transport, the offline id map and the
 * clock injected so `ClipUploadRunnerTest` runs it on the JVM. Every decision
 * is [ClipUploadQueue]'s; this performs the action it names, reads the answer
 * back into a [Response], and persists what [ClipUploadQueue.apply] says after
 * every step, so a worker the system stops resumes at the next part.
 *
 * `ClipUploadWorker` in `:app` is the shell: it turns [Outcome.WaitUntil] and
 * [Outcome.WaitForSession] into the next run's delay, so the backoff is the
 * Kit's 30 s … 1 h on both phones rather than WorkManager's own.
 *
 * Two things here exist so an upload can't sit on *Video uploading* forever
 * after a patchy track connection — iOS's `ClipUploader` does both:
 *
 * - **A part that sends nothing for [STALL_MS] is cancelled** and read as a
 *   transport failure, so it backs off and is sent again rather than hanging.
 *   The worker only runs with a network its constraint allows, which is what
 *   iOS's "app in front and a usable network" condition is for there.
 * - **A dropped job is kept, with its reason** ([ClipManifest.drop]), so the
 *   lap page says why once instead of the video silently never appearing.
 *   *Lap already has a clip* is the exception: the lap shows that clip, which
 *   says enough.
 *
 * [parts] is the bytes sent of each job's part in flight, for the lap page's
 * percentage.
 */
public class ClipUploadRunner(
    private val manifest: ClipManifest,
    private val transport: Transport,
    private val ids: TempIds,
    private val now: () -> Long = System::currentTimeMillis,
) {
    /** The three clip routes the upload uses. [ApiClient] is the real one ([transport]). */
    public interface Transport {
        public suspend fun create(sessionId: Int, body: ClipCreate): ClipUpload

        /** [onProgress] is called with the part's bytes sent so far, as they go. */
        public suspend fun uploadPart(clipId: Int, partNumber: Int, file: File, offset: Long, length: Long, onProgress: (Long) -> Unit)

        /** Throws [ClipMissingParts] for `complete`'s 409 that names them. */
        public suspend fun complete(clipId: Int)
    }

    /** Where a temp id stands in the offline store — `APIClient.tempIdState` on iOS. */
    public fun interface TempIds {
        public suspend fun state(tempId: Int): OfflineStore.TempIdState
    }

    public sealed interface Outcome {
        /** Uploaded and complete; the job and its file are gone. */
        public data object Done : Outcome

        /** Never going to upload; the job and its file are gone. */
        public data class Dropped(val reason: DropReason) : Outcome

        /** The session's create is still queued offline. Look again shortly. */
        public data object WaitForSession : Outcome

        /** Backing off until [ms] (epoch); progress so far is kept. */
        public data class WaitUntil(val ms: Long) : Outcome

        /** Not an uploadable job (still cutting, a failed cut, or gone). */
        public data object Skipped : Outcome
    }

    private val sending = MutableStateFlow<Map<String, Long>>(emptyMap())

    /** Bytes sent so far of the part in flight, by job id; a job with no part in flight is absent. */
    public val parts: StateFlow<Map<String, Long>> = sending.asStateFlow()

    /** Drives job [id] until it finishes, is dropped, or has to wait. */
    public suspend fun run(id: String): Outcome {
        while (true) {
            val job = manifest.get(id) ?: return Outcome.Skipped
            if (job.state != ClipJob.State.PENDING) return Outcome.Skipped

            // A cut that is gone or the wrong size (a restored manifest, a
            // cleared directory) has nothing to send, now or later — iOS drops
            // such a job as `.refused` when it can't copy the part out.
            val file = job.file?.let(::File)
            if (file == null || !file.isFile || job.sizeBytes <= 0 || file.length() != job.sizeBytes) {
                return drop(job, DropReason.REFUSED)
            }

            val session = sessionState(job.sessionId)
            if (session is ClipUploadQueue.SessionState.Real && session.id != job.sessionId) {
                manifest.update(id) { it.copy(sessionId = session.id) } ?: return Outcome.Skipped
                continue
            }
            // The event id is only for the lap page to find its pending jobs.
            if (OfflineStore.isTemp(job.eventId)) {
                val real = ids.state(job.eventId).mapped
                if (real != null) {
                    manifest.update(id) { it.copy(eventId = real) } ?: return Outcome.Skipped
                    continue
                }
            }

            val action = ClipUploadQueue.nextAction(job, session, now())
            val response = when (action) {
                Action.WaitForSession -> return Outcome.WaitForSession
                is Action.WaitUntil -> return Outcome.WaitUntil(action.ms)
                is Action.Drop -> return drop(job, action.reason)
                is Action.Create -> attempt { Response.Created(transport.create(action.sessionId, action.body)) }
                is Action.UploadPart -> attempt {
                    sendPart(id, action, file)
                    Response.Ok
                }
                is Action.Complete -> attempt {
                    transport.complete(action.clipId)
                    Response.Ok
                }
            }
            when (val outcome = ClipUploadQueue.apply(job, action, response, now())) {
                is ClipUploadQueue.Outcome.Continue -> manifest.update(id) { outcome.job } ?: return Outcome.Skipped
                ClipUploadQueue.Outcome.Finished -> {
                    manifest.remove(id)
                    return Outcome.Done
                }
                is ClipUploadQueue.Outcome.Dropped -> return drop(job, outcome.reason)
            }
        }
    }

    /**
     * One part, watched: the bytes it has sent are published to [parts], and
     * if none move for [STALL_MS] — counted in [STALL_CHECK_MS] ticks, so a
     * test's virtual clock drives it — the send is cancelled and thrown as a
     * transport failure. Counting from the start means a connect that never
     * answers is a stall too.
     */
    private suspend fun sendPart(id: String, action: Action.UploadPart, file: File) {
        val sent = AtomicLong(0)
        sending.update { it + (id to 0L) }
        var stalled = false
        try {
            coroutineScope {
                val send = async {
                    transport.uploadPart(action.clipId, action.part, file, action.offset, action.length) { bytes ->
                        sent.set(bytes)
                        // A tick per 256 KiB is plenty for a percentage.
                        if (bytes - (sending.value[id] ?: 0) >= PROGRESS_STEP_BYTES || bytes == action.length) {
                            sending.update { it + (id to bytes) }
                        }
                    }
                }
                val watchdog = launch {
                    var seen = -1L
                    var quietMs = 0L
                    while (true) {
                        delay(STALL_CHECK_MS)
                        val now = sent.get()
                        if (now != seen) {
                            seen = now
                            quietMs = 0
                        } else {
                            quietMs += STALL_CHECK_MS
                            if (quietMs >= STALL_MS) {
                                stalled = true
                                send.cancel()
                                return@launch
                            }
                        }
                    }
                }
                try {
                    send.await()
                } finally {
                    watchdog.cancel()
                }
            }
        } catch (e: CancellationException) {
            if (stalled) throw ApiException.Transport("clip part ${action.part} sent nothing for ${STALL_MS / 1000} s", e)
            throw e
        } finally {
            sending.update { it - id }
        }
    }

    private suspend fun sessionState(sessionId: Int): ClipUploadQueue.SessionState {
        if (!OfflineStore.isTemp(sessionId)) return ClipUploadQueue.SessionState.Real(sessionId)
        val state = ids.state(sessionId)
        return ClipUploadQueue.sessionState(sessionId, mapped = state.mapped, queued = state.queued)
    }

    private fun drop(job: ClipJob, reason: DropReason): Outcome {
        if (reason == DropReason.ALREADY_HAS_CLIP) manifest.remove(job.id) else manifest.drop(job.id, reason.rawValue, now())
        return Outcome.Dropped(reason)
    }

    public companion object {
        /** How long a part may send nothing before it is treated as stuck — iOS's `stallSeconds`. */
        public const val STALL_MS: Long = 60_000

        /** How often the stall watchdog looks. */
        public const val STALL_CHECK_MS: Long = 5_000

        private const val PROGRESS_STEP_BYTES: Long = 256 * 1024

        /**
         * An answer that came back as an exception, read the way iOS's
         * `ClipUploader.response(for:)` reads `APIError`: no answer (or one
         * that didn't decode) is [Response.Transport], a refusal before
         * sending is a 403, and everything else is its status and message.
         */
        public fun response(error: Throwable): Response = when (error) {
            is ClipMissingParts -> Response.MissingParts(error.missing)
            is ApiException.Transport, is ApiException.Decoding -> Response.Transport
            is ApiException.ReadOnly -> Response.Status(403, error.message)
            is ApiException -> Response.Status(error.status ?: 0, error.message)
            else -> Response.Transport
        }

        private suspend inline fun attempt(block: () -> Response): Response = try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (@Suppress("TooGenericExceptionCaught") e: Exception) {
            response(e)
        }

        /** The real transport: the app's one [ApiClient]. */
        public fun transport(api: ApiClient): Transport = object : Transport {
            override suspend fun create(sessionId: Int, body: ClipCreate): ClipUpload = api.createClip(sessionId, body)

            override suspend fun uploadPart(clipId: Int, partNumber: Int, file: File, offset: Long, length: Long, onProgress: (Long) -> Unit) =
                api.uploadClipPart(clipId, partNumber, file, offset, length, onProgress)

            override suspend fun complete(clipId: Int) {
                api.completeClip(clipId)
            }
        }

        public fun tempIds(api: ApiClient): TempIds = TempIds { api.tempIdState(it) }
    }
}
