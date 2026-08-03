package app.trackevolution.data

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import app.trackevolution.core.api.ApiClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.time.Duration

/**
 * Decides *when* the offline queue is replayed (NS-22).
 *
 * Two triggers, and they are deliberately different in kind:
 *
 * 1. **Anything pending schedules work.** Collecting `syncStatus` means every
 *    queued write asks for a replay, whether it was made offline or the server
 *    merely blinked. The work is unique and [ExistingWorkPolicy.KEEP], so asking
 *    twice costs nothing.
 * 2. **A network arriving kicks it immediately.** WorkManager's `CONNECTED`
 *    constraint would get there on its own, but on its own schedule; the
 *    callback is what makes reconnecting in the paddock feel instant.
 *
 * A callback, never a poll — and, per the spec, "has a network" is only a hint.
 * Captive portals and dead paddock Wi-Fi both report connected, so the signal
 * that actually matters is whether a write got through, which is
 * [ReplayWorker]'s business rather than this class's.
 */
internal class SyncScheduler(
    context: Context,
    private val api: ApiClient,
) {
    private val appContext = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            schedule()
        }
    }

    fun start() {
        scope.launch {
            api.syncStatus.collect { status ->
                if (status.pending > 0) schedule()
            }
        }

        val manager = appContext.getSystemService(ConnectivityManager::class.java)
        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        // Registered for the life of the process and never unregistered: the
        // scheduler is a process-wide singleton, so there is no unbalanced-
        // registration hazard and nothing to leak into.
        runCatching { manager?.registerNetworkCallback(request, callback) }
    }

    /**
     * Ask for a replay. Safe to call as often as you like.
     *
     * [ExistingWorkPolicy.KEEP] rather than `REPLACE` (which would cancel a
     * replay mid-queue) or `APPEND_OR_REPLACE` (which would build a chain of
     * redundant drains, and wedge on the first cancelled link). Keeping the
     * existing request is only correct because [ReplayWorker] refuses to
     * succeed while the queue is non-empty — so the pending work item is always
     * one that will finish the job.
     */
    fun schedule() {
        val request = OneTimeWorkRequestBuilder<ReplayWorker>()
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build(),
            )
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, MIN_BACKOFF)
            .build()

        WorkManager.getInstance(appContext)
            .enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.KEEP, request)
    }

    private companion object {
        const val WORK_NAME = "offline-replay"
        val MIN_BACKOFF: Duration = Duration.ofSeconds(30)
    }
}
