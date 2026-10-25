package app.trackevolution.clips

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import app.trackevolution.R
import app.trackevolution.core.clips.ClipUploadRunner.Outcome
import app.trackevolution.data.AppServices
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

/**
 * Uploads one best-lap clip (NS-45): unique work per job, constrained to an
 * unmetered network unless Settings allows cellular, long-running in the
 * foreground with an *Uploading lap video* notification
 * (`foregroundServiceType="dataSync"`, declared on WorkManager's
 * `SystemForegroundService` in the manifest).
 *
 * The shell around `:core`'s [app.trackevolution.core.clips.ClipUploadRunner]
 * and the [app.trackevolution.core.clips.ClipUploadQueue] it drives, which hold
 * every decision: this only turns a wait into the next run's delay. Progress is in the manifest after every part, so a worker the system
 * stops — or a process that dies — resumes at the next part.
 */
internal class ClipUploadWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val jobId = inputData.getString(KEY_JOB) ?: return Result.success()
        val clips = AppServices.get(applicationContext).clips
        // Foreground for the length of a 150 MB upload. A worker started while
        // the app is in the background may not be allowed to promote itself
        // (Android 12+); it then uploads within the ordinary worker window and
        // resumes on its next run.
        runCatching { setForeground(foregroundInfo(title(clips))) }
        // One job at a time (NS-50): a session saved lap by lap has a job per
        // lap, each its own work, and they take turns here. While this one
        // runs, the one notification says every job on its way.
        val outcome = clips.oneAtATime {
            coroutineScope {
                val progress = launch {
                    combine(clips.jobs, clips.parts) { jobs, parts -> ClipUploadText.notificationTitle(jobs, parts) }
                        .distinctUntilChanged()
                        .collect { runCatching { setForeground(foregroundInfo(it)) } }
                }
                try {
                    clips.runner.run(jobId)
                } finally {
                    progress.cancel()
                }
            }
        }
        when (outcome) {
            Outcome.Done, Outcome.Skipped -> Unit
            is Outcome.Dropped -> Log.i(TAG, "clip $jobId dropped: ${outcome.reason.rawValue}")
            // The waits are the queue's, as on iOS: half a minute while the
            // session's create is still in the offline queue, and the backoff's
            // own 30 s … 1 h after a failure — never WorkManager's schedule.
            Outcome.WaitForSession -> clips.scheduleAgain(jobId, SESSION_POLL_MS)
            is Outcome.WaitUntil -> clips.scheduleAgain(jobId, outcome.ms - System.currentTimeMillis())
        }
        return Result.success()
    }

    override suspend fun getForegroundInfo(): ForegroundInfo = foregroundInfo(title(AppServices.get(applicationContext).clips))

    private fun title(clips: ClipUploads): String? = ClipUploadText.notificationTitle(clips.jobs.value, clips.parts.value)

    /** [title] null is the one-job title, the string resource. */
    private fun foregroundInfo(title: String?): ForegroundInfo {
        val notification = notification(applicationContext, title)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ForegroundInfo(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            ForegroundInfo(NOTIFICATION_ID, notification)
        }
    }

    companion object {
        const val KEY_JOB = "job"

        /** How soon a job waiting on its session's offline create looks again — iOS's 30 s wake. */
        const val SESSION_POLL_MS: Long = 30_000
        private const val TAG = "clip-upload"
        private const val CHANNEL_ID = "clip-upload"
        private const val NOTIFICATION_ID = 1002

        /** Silent and low: it says an upload is running, nothing more. */
        fun notification(context: Context, title: String? = null): Notification {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val manager = context.getSystemService(NotificationManager::class.java)
                if (manager?.getNotificationChannel(CHANNEL_ID) == null) {
                    manager?.createNotificationChannel(
                        NotificationChannel(
                            CHANNEL_ID,
                            context.getString(R.string.clip_upload_channel_name),
                            NotificationManager.IMPORTANCE_LOW,
                        ).apply {
                            description = context.getString(R.string.clip_upload_channel_description)
                            setShowBadge(false)
                        },
                    )
                }
            }
            return NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_upload)
                .setContentTitle(title ?: context.getString(R.string.clip_upload_title))
                .setOngoing(true)
                .setSilent(true)
                .setProgress(0, 0, true)
                .setCategory(NotificationCompat.CATEGORY_PROGRESS)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build()
        }
    }
}
