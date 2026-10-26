package app.trackevolution.clips

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.util.Log
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
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
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
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
 * *Preparing video* from the moment the review closes; and only a finished
 * cut is handed to WorkManager.
 *
 * **Nothing may sit on *Video uploading* forever** — iOS's `ClipUploader` rule,
 * after a patchy track connection left uploads stuck. The queue backs off up
 * to an hour, and a driver home on good Wi-Fi was waiting out failures counted
 * on the track's network. So the app coming to the front ([becameActive], off
 * [ProcessLifecycleOwner]) and a new usable network (a default-network
 * callback) both end every job's backoff and run it now; a part that stops
 * moving is the runner's to cancel (`ClipUploadRunner.STALL_MS`); and a job
 * the queue gives up on stays in the manifest with its reason, said once on
 * its lap.
 *
 * **One cut and one upload at a time** (NS-50): a session saved lap by lap
 * hands over a job per lap at once, and eight `MediaMuxer` cuts of the same
 * source or eight 50 MiB parts in flight help nobody. Cuts run in the order
 * they were asked for ([cutLock]); each job keeps its own unique work, so
 * every NS-45 rule about scheduling one job holds, and the workers take turns
 * on [uploadLock] — a fair mutex, so they go in the order they arrived.
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

    /** Every job, for the lap page's pending and failed states. */
    override val jobs: StateFlow<List<ClipJob>> get() = manifest.jobs

    override val parts: StateFlow<Map<String, Long>> get() = runner.parts

    private val networkState = MutableStateFlow(ClipNetwork.UNKNOWN)
    override val network: StateFlow<ClipNetwork> = networkState.asStateFlow()

    /** The network the last callback described — its id and the two facts — to notice a new one. */
    private var networkSignature: String? = null

    /** Cuts one at a time, in the order asked for. */
    private val cutLock = Mutex()

    /** Uploads one job at a time: see [oneAtATime]. */
    private val uploadLock = Mutex()

    /**
     * Runs [block] — a worker's whole run of one job — once no other job's run
     * is in progress. A waiting worker holds no thread, and cancelling it (a
     * `REPLACE`, a constraint lost) just leaves the queue.
     */
    suspend fun <T> oneAtATime(block: suspend () -> T): T = uploadLock.withLock { block() }

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
        watchNetwork()
        // Off the process's lifecycle, not an activity's: a rotation is not
        // the app coming back, and must not restart anything.
        ProcessLifecycleOwner.get().lifecycle.addObserver(
            object : DefaultLifecycleObserver {
                override fun onStart(owner: LifecycleOwner) = becameActive()
            },
        )
    }

    /**
     * The app came to the front: every backoff ends and every waiting job runs
     * now. The driver is looking, and whatever failed may well have failed on
     * a network they have since left.
     */
    fun becameActive() {
        runNow(null)
    }

    override fun retryNow(jobId: String) {
        runNow(jobId)
    }

    override fun acknowledge(jobId: String) {
        scope.launch { manifest.acknowledge(jobId) }
    }

    /**
     * Ends the backoff of [jobId] (every job when null) and replaces its
     * waiting work with work that runs at once. A job with a part in flight is
     * left alone — it is moving, and replacing its worker would throw the part
     * away; if it isn't moving, the runner's stall rule ends it.
     */
    private fun runNow(jobId: String?) {
        scope.launch {
            val cellular = cellularAllowed.first()
            val inFlight = runner.parts.value.keys
            manifest.clearBackoff(jobId)
                .filter { it.id !in inFlight }
                .forEach { schedule(it.id, cellular, ExistingWorkPolicy.REPLACE) }
        }
    }

    /**
     * Follows the default network for the lap page's *waiting for a
     * connection* / *Wi-Fi*, and on arriving at a **new** usable one — another
     * network, or the same one turning unmetered — ends every backoff, as
     * iOS's path monitor does. Signal-strength updates, which re-deliver the
     * capabilities constantly on cellular, don't change the signature.
     * Registered for the life of the process, as `SyncScheduler`'s is.
     */
    private fun watchNetwork() {
        val manager = appContext.getSystemService(ConnectivityManager::class.java) ?: return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                networkChanged(
                    "$network",
                    ClipNetwork(
                        online = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET),
                        metered = !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED),
                    ),
                )
            }

            override fun onLost(network: Network) {
                networkChanged(null, networkState.value.copy(online = false))
            }
        }
        runCatching { manager.registerDefaultNetworkCallback(callback) }
    }

    @Synchronized
    private fun networkChanged(id: String?, now: ClipNetwork) {
        val signature = id?.let { "$it ${now.online} ${now.metered}" } ?: "none"
        networkState.value = now
        if (signature == networkSignature) return
        networkSignature = signature
        scope.launch {
            if (now.usable(cellularAllowed.first())) runNow(null)
        }
    }

    override fun enqueue(request: ClipRequest) {
        val job = ClipJob(
            id = UUID.randomUUID().toString(),
            sessionId = request.sessionId,
            eventId = request.eventId,
            timeMs = request.timeMs,
            lapNum = request.lapNum,
            state = ClipJob.State.CUTTING,
            createdAt = System.currentTimeMillis(),
        )
        scope.launch {
            manifest.put(job)
            val out = File(dir, "${job.id}.mp4")
            val cut = try {
                cutLock.withLock {
                    // Signed out while it waited its turn: nothing to cut for.
                    if (manifest.get(job.id) == null) return@launch
                    ClipCutter.cut(appContext.contentResolver, request.source, request.window, out)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Nothing was written, and the session is already saved. The lap
                // page says so once: "Couldn't save this lap's video."
                Log.w(TAG, "couldn't cut lap ${request.lapNum ?: "?"} from ${request.source}", e)
                manifest.update(job.id) { it.copy(state = ClipJob.State.CUT_FAILED, file = null, failedAt = System.currentTimeMillis()) }
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
