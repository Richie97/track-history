package app.trackevolution.clips

import android.content.Context
import android.util.Log
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import app.trackevolution.core.api.ApiClient
import app.trackevolution.core.clips.ClipJob
import app.trackevolution.core.clips.ClipManifest
import app.trackevolution.core.clips.ClipUploadQueue
import app.trackevolution.core.clips.ClipUploadRunner
import app.trackevolution.data.settingsDataStore
import app.trackevolution.videoimport.ClipCutter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import java.io.File
import java.time.Duration
import java.util.UUID

/**
 * Best-lap clips from the review to the server (NS-45): the [ClipSink] the
 * review hands each clip to, the cut, the job manifest and the upload work.
 *
 * Process-wide (`AppServices`), for the reasons the offline store is: the
 * manifest's in-memory copy is what the lap page observes, a cut must outlive
 * the review that asked for it, and [ClipUploadWorker] — which may run with no
 * activity at all — has to reach the same manifest the UI reads.
 *
 * The order of things is the spec's: the session has been posted before a
 * request arrives here; the cut runs on [Dispatchers.IO] in this object's own
 * scope, **outside the save's job**, so a slow or failing cut can't hold up or
 * fail the save; the job is written `CUTTING` first so the lap page can say
 * *Video uploading* from the moment the review closes; and only a finished
 * cut is handed to WorkManager.
 */
internal class ClipUploads(
    context: Context,
    private val api: ApiClient,
) : ClipSink, ClipStatus {
    private val appContext = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** `filesDir/clips/` — the cut clips and their manifest, excluded from backups. */
    val dir: File = File(appContext.filesDir, DIR)

    val manifest = ClipManifest(dir)

    /** Drives a job through `:core`'s [ClipUploadQueue] — the same state machine as iOS's. */
    val runner = ClipUploadRunner(manifest, ClipUploadRunner.transport(api), ClipUploadRunner.tempIds(api))

    /** Every job, for the lap page's *Video uploading* and *Couldn't save* states. */
    override val jobs: StateFlow<List<ClipJob>> get() = manifest.jobs

    /** *Upload lap videos over cellular* — off by default (Wi-Fi only). */
    override val cellularAllowed: Flow<Boolean> = appContext.settingsDataStore.data.map { it[CELLULAR_KEY] ?: false }

    /**
     * At process start: a cut the last process didn't finish is a failed cut
     * (its source grant died with it), a failed cut a week old is forgotten,
     * and every pending upload is asked for again — `KEEP`, so one already
     * scheduled is left alone.
     */
    fun start() {
        scope.launch {
            manifest.recoverInterrupted()
            manifest.prune(System.currentTimeMillis())
            val cellular = cellularAllowed.first()
            manifest.all().filter { it.state == ClipJob.State.PENDING }.forEach { schedule(it.id, cellular, ExistingWorkPolicy.KEEP) }
        }
    }

    override fun enqueue(request: ClipRequest) {
        val job = ClipJob(
            id = UUID.randomUUID().toString(),
            sessionId = request.sessionId,
            eventId = request.eventId,
            timeMs = request.timeMs,
            state = ClipJob.State.CUTTING,
            createdAt = System.currentTimeMillis(),
        )
        scope.launch {
            manifest.put(job)
            val out = File(dir, "${job.id}.mp4")
            val cut = try {
                ClipCutter.cut(appContext.contentResolver, request.source, request.window, out)
            } catch (e: Exception) {
                // Nothing was written, and the session is already saved. The lap
                // page says so once: "Couldn't save this lap's video".
                Log.w(TAG, "couldn't cut the best lap from ${request.source}", e)
                manifest.update(job.id) { it.copy(state = ClipJob.State.CUT_FAILED, file = null) }
                return@launch
            }
            manifest.update(job.id) {
                it.copy(
                    state = ClipJob.State.PENDING,
                    file = cut.file.path,
                    sizeBytes = cut.sizeBytes,
                    durationMs = cut.durationMs,
                    lapOffsetMs = cut.lapOffsetMs,
                )
            } ?: run {
                // Signed out while it was cutting: the job is gone, so is the file.
                cut.file.delete()
                return@launch
            }
            schedule(job.id, cellularAllowed.first(), ExistingWorkPolicy.KEEP)
        }
    }

    /** Settings' switch. Re-asks every pending upload under the new network rule. */
    override suspend fun setCellularAllowed(allowed: Boolean) {
        appContext.settingsDataStore.edit { it[CELLULAR_KEY] = allowed }
        // REPLACE: a request waiting for Wi-Fi has to be swapped for one that
        // may use cellular (and back). One mid-part is cancelled and resumes at
        // that part — the manifest has every part that landed.
        manifest.all().filter { it.state == ClipJob.State.PENDING }.forEach { schedule(it.id, allowed, ExistingWorkPolicy.REPLACE) }
    }

    /** Sign-out: no upload of the last account's video runs under the next one. */
    fun clear() {
        WorkManager.getInstance(appContext).cancelAllWorkByTag(TAG)
        manifest.clear()
    }

    /**
     * The next run of a job that has to wait — for its session's offline
     * create, or out a backoff — after [delayMs]. Called from inside the
     * running worker, so it is **appended** to the job's unique chain: it
     * starts once this run returns, after its delay. The wait is therefore
     * the queue's own (30 s … 1 h, as on iOS), not WorkManager's backoff.
     */
    suspend fun scheduleAgain(jobId: String, delayMs: Long) {
        schedule(jobId, cellularAllowed.first(), ExistingWorkPolicy.APPEND_OR_REPLACE, delayMs)
    }

    private fun schedule(jobId: String, cellular: Boolean, policy: ExistingWorkPolicy, delayMs: Long = 0) {
        val request = OneTimeWorkRequestBuilder<ClipUploadWorker>()
            .setInputData(workDataOf(ClipUploadWorker.KEY_JOB to jobId))
            .setInitialDelay(Duration.ofMillis(delayMs.coerceAtLeast(0)))
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(if (cellular) NetworkType.CONNECTED else NetworkType.UNMETERED)
                    .build(),
            )
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, MIN_BACKOFF)
            .addTag(TAG)
            .build()
        WorkManager.getInstance(appContext).enqueueUniqueWork(workName(jobId), policy, request)
    }

    companion object {
        const val DIR = "clips"
        private const val TAG = "clip-upload"
        private val MIN_BACKOFF: Duration = Duration.ofSeconds(30)
        private val CELLULAR_KEY = booleanPreferencesKey("clip_upload_cellular")

        /** One unique work per job, so a job is never uploaded by two workers at once. */
        fun workName(jobId: String): String = "clip-upload-$jobId"
    }
}
