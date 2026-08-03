package app.trackevolution.data

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

/**
 * Replays the offline write queue (NS-22).
 *
 * A worker rather than a coroutine in a ViewModel because the writes it is
 * draining were made in a paddock: the app that queued them is very likely gone
 * — swiped away, or killed while the phone sat in a pocket — long before signal
 * comes back. WorkManager outlives the process; a ViewModel does not.
 *
 * **It only reports success when the queue is empty.** Anything else is
 * [Result.retry], which keeps the unique work alive and lets WorkManager apply
 * its own backoff. That is what closes the gap a "drain once and finish" worker
 * leaves: `OfflineStore.flush` snapshots the queue when it starts, so a write
 * added while it runs is still waiting afterwards, and a worker that returned
 * success there would strand it until the next reconnect.
 */
internal class ReplayWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val api = AppServices.get(applicationContext).api
        var previous = Int.MAX_VALUE

        repeat(MAX_PASSES) {
            // Null means this client has no offline store at all, so there is
            // nothing to drain and never will be.
            val status = api.flushQueue() ?: return Result.success()

            if (status.pending == 0) return Result.success()
            // No answer from the server. The remainder of the queue is intact;
            // the CONNECTED constraint will bring us back.
            if (status.offline) return Result.retry()
            // Still pending, still online, and no smaller than last pass: the
            // head of the queue is stuck on a 5xx. Back off rather than spin —
            // this is also what stops a concurrent flush (whose `tryLock` makes
            // our call a no-op returning the same count) from becoming a hot
            // loop.
            if (status.pending >= previous) return Result.retry()

            previous = status.pending
        }

        // Draining, but not finished inside one run — come back rather than
        // hold a worker open indefinitely.
        return Result.retry()
    }

    companion object {
        /**
         * Passes per run. More than one because a write can be queued while a
         * flush is in flight; bounded because an unbounded loop plus a stuck
         * queue is a battery bug.
         */
        private const val MAX_PASSES = 4
    }
}
