package app.trackevolution.core.clips

import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.api.ApiException
import app.trackevolution.core.model.ClipCreate
import app.trackevolution.core.model.ClipUpload
import app.trackevolution.core.offline.OfflineStore
import kotlinx.coroutines.CancellationException
import java.io.File

/**
 * The best-lap clip upload, as a state machine over one [ClipJob] at a time
 * (NS-45). Pure in the sense that matters: the transport and the offline id
 * map are injected, the job's progress lives in [ClipManifest], and nothing
 * here knows about WorkManager, notifications or Wi-Fi — so `ClipUploadQueueTest`
 * runs every transition on the JVM. `ClipUploadWorker` in `:app` is the shell
 * that calls [run] and turns its [Outcome] into a WorkManager result.
 *
 * The spec has iOS's Kit carry the same machine under the same name; this one
 * was written to the spec's contract while that was being built, with the
 * transitions spelled out here so the two can be reconciled by eye.
 *
 * ## Transitions, in the order [run] takes them
 *
 * 1. **Not ready.** A job still `CUTTING`, or a failed cut, is not uploaded:
 *    [Outcome.Skipped]. It stays in the manifest for the lap page to read.
 * 2. **File check.** No file, a missing file, or one whose length isn't the
 *    declared size (a restored manifest, a cleared cache) can never upload:
 *    the job is dropped ([Outcome.Dropped]).
 * 3. **Temp session id.** A negative id is a session whose create is still in
 *    the offline queue. It is resolved through `OfflineStore`'s id map; while
 *    unresolved and the queue still holds writes, the job **waits**
 *    ([Outcome.Waiting]). Unresolved with the queue empty means the create was
 *    refused or cancelled — the session never existed — and the job is
 *    dropped. The event id is resolved the same way, for the lap page.
 * 4. **Create** `POST /sessions/:id/clip`, every run — it is idempotent for
 *    resume with the same size, and its `uploaded` list is the server's word
 *    on which parts it already holds, so a part this side thinks it sent but
 *    the server never stored is sent again.
 * 5. **Parts** `PUT /clips/:id/parts/:n` for every part not uploaded, each
 *    `part_bytes` long (the last the remainder), each recorded in the manifest
 *    as soon as it lands, so a killed worker resumes at the next part.
 * 6. **Complete** `POST /clips/:id/complete`. A 200 is [Outcome.Done]: the job
 *    and its file are deleted.
 *
 * ## Failures
 *
 * - **409 on create** — `clip storage full`, `lap already has a clip` — and
 *   any **400, 402 or 404 on create** never change on retry: dropped, file
 *   deleted. (A 402 is a lapse between saving and uploading; a 404 is a
 *   session or lap deleted since.)
 * - **404 on a part or on complete**: the clip row is gone (deleted, or swept
 *   as a week-stale upload). The job forgets its clip id and retries, which
 *   creates a fresh row.
 * - **409 on a part** (`clip already uploaded`) goes straight to complete;
 *   **409 on complete** (`missing parts`) retries, and the next create says
 *   which parts the server is missing.
 * - **Transport failures, 401 and 429** retry ([Outcome.Retry]) without
 *   counting; **5xx** retries and counts, and is dropped after [MAX_ATTEMPTS].
 *
 * A clip never costs its session: by the time a job exists the session has
 * already been posted (or queued), and nothing here touches it.
 */
public class ClipUploadQueue(
    private val manifest: ClipManifest,
    private val transport: Transport,
    private val ids: TempIds,
) {
    /** The three clip routes the upload uses. [ApiClient] is the real one ([from]). */
    public interface Transport {
        public suspend fun create(sessionId: Int, body: ClipCreate): ClipUpload

        public suspend fun uploadPart(clipId: Int, partNumber: Int, file: File, offset: Long, length: Long)

        public suspend fun complete(clipId: Int)
    }

    /** `OfflineStore`'s id map and queue depth, which is all a temp id needs. */
    public interface TempIds {
        public suspend fun resolve(tempId: Int): Int?

        public suspend fun pendingWrites(): Int
    }

    public sealed interface Outcome {
        /** Uploaded and complete; the job and its file are gone. */
        public data object Done : Outcome

        /** Never going to upload; the job and its file are gone. */
        public data class Dropped(val reason: String) : Outcome

        /** The session's create is still queued offline. Try again later. */
        public data object Waiting : Outcome

        /** A failure worth retrying with backoff; progress so far is kept. */
        public data class Retry(val reason: String) : Outcome

        /** Not an uploadable job (still cutting, or a failed cut, or gone). */
        public data object Skipped : Outcome
    }

    /** Drives job [id] as far as it will go this time. */
    public suspend fun run(id: String): Outcome {
        var job = manifest.get(id) ?: return Outcome.Skipped
        if (job.state != ClipJob.State.PENDING) return Outcome.Skipped

        val path = job.file
        val file = path?.let(::File)
        if (file == null || !file.isFile || file.length() != job.sizeBytes || job.sizeBytes <= 0) {
            return drop(job, "the cut clip is missing")
        }

        // 3. A session still waiting in the offline queue.
        if (OfflineStore.isTemp(job.sessionId)) {
            val real = ids.resolve(job.sessionId)
            when {
                real != null -> job = manifest.update(id) { it.copy(sessionId = real) } ?: return Outcome.Skipped
                ids.pendingWrites() > 0 -> return Outcome.Waiting
                // The queue drained between the two reads: one more look.
                else -> {
                    val late = ids.resolve(job.sessionId) ?: return drop(job, "the session was never saved")
                    job = manifest.update(id) { it.copy(sessionId = late) } ?: return Outcome.Skipped
                }
            }
        }
        if (OfflineStore.isTemp(job.eventId)) {
            ids.resolve(job.eventId)?.let { real -> job = manifest.update(id) { it.copy(eventId = real) } ?: job }
        }

        // 4. Create, or resume.
        val upload = try {
            transport.create(
                job.sessionId,
                ClipCreate(timeMs = job.timeMs, sizeBytes = job.sizeBytes, durationMs = job.durationMs, lapOffsetMs = job.lapOffsetMs),
            )
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiException) {
            return when {
                e.status == 409 || e.status == 400 || e.status == 402 || e.status == 404 -> drop(job, e.message)
                else -> failure(job, e)
            }
        }
        job = manifest.update(id) {
            it.copy(clipId = upload.clipId, partBytes = upload.partBytes, parts = upload.parts, uploaded = upload.uploaded.sorted())
        } ?: return Outcome.Skipped

        // 5. Parts.
        val partBytes = upload.partBytes
        for (n in 1..upload.parts) {
            if (n in job.uploaded) continue
            val offset = (n - 1) * partBytes
            val length = minOf(partBytes, job.sizeBytes - offset)
            if (length <= 0) return drop(job, "the clip is smaller than its parts")
            try {
                transport.uploadPart(upload.clipId, n, file, offset, length)
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                when (e.status) {
                    409 -> break // already uploaded: complete answers the clip
                    404 -> return restart(job, e.message)
                    400 -> return drop(job, e.message)
                    else -> return failure(job, e)
                }
            }
            job = manifest.update(id) { it.copy(uploaded = (it.uploaded + n).distinct().sorted()) } ?: return Outcome.Skipped
        }

        // 6. Complete.
        try {
            transport.complete(upload.clipId)
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiException) {
            return when (e.status) {
                404 -> restart(job, e.message)
                // Missing parts: the next create's `uploaded` says which.
                409 -> {
                    manifest.update(id) { it.copy(uploaded = emptyList()) }
                    Outcome.Retry(e.message)
                }
                else -> failure(job, e)
            }
        }
        manifest.remove(id)
        return Outcome.Done
    }

    private fun drop(job: ClipJob, reason: String): Outcome {
        manifest.remove(job.id)
        return Outcome.Dropped(reason)
    }

    /** The clip row is gone server-side: forget it, so the next run creates a fresh one. */
    private fun restart(job: ClipJob, reason: String): Outcome {
        manifest.update(job.id) { it.copy(clipId = null, partBytes = null, parts = null, uploaded = emptyList()) }
        return Outcome.Retry(reason)
    }

    private fun failure(job: ClipJob, e: ApiException): Outcome {
        val counted = (e.status ?: 0) >= 500
        if (!counted) return Outcome.Retry(e.message)
        val next = manifest.update(job.id) { it.copy(attempts = it.attempts + 1) } ?: return Outcome.Skipped
        return if (next.attempts >= MAX_ATTEMPTS) drop(next, e.message) else Outcome.Retry(e.message)
    }

    public companion object {
        /** Server errors (5xx) before a clip is given up on. Transport failures never count. */
        public const val MAX_ATTEMPTS: Int = 8

        /** The real transport and id map: the app's one [ApiClient]. */
        public fun transport(api: ApiClient): Transport = object : Transport {
            override suspend fun create(sessionId: Int, body: ClipCreate): ClipUpload = api.createClip(sessionId, body)

            override suspend fun uploadPart(clipId: Int, partNumber: Int, file: File, offset: Long, length: Long) =
                api.uploadClipPart(clipId, partNumber, file, offset, length)

            override suspend fun complete(clipId: Int) {
                api.completeClip(clipId)
            }
        }

        public fun tempIds(api: ApiClient): TempIds = object : TempIds {
            override suspend fun resolve(tempId: Int): Int? = api.resolveTempId(tempId)

            override suspend fun pendingWrites(): Int = api.pendingWriteCount()
        }
    }
}
