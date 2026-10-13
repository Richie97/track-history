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
import app.trackevolution.core.clips.ClipUploadQueue.Outcome
import app.trackevolution.data.AppServices

/**
 * Uploads one best-lap clip (NS-45): unique work per job, constrained to an
 * unmetered network unless Settings allows cellular, long-running in the
 * foreground with an *Uploading lap video* notification
 * (`foregroundServiceType="dataSync"`, declared on WorkManager's
 * `SystemForegroundService` in the manifest).
 *
 * The shell around `:core`'s [app.trackevolution.core.clips.ClipUploadQueue],
 * which holds every decision: this only turns its outcome into a WorkManager
 * result. Progress is in the manifest after every part, so a worker the system
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
        runCatching { setForeground(foregroundInfo()) }
        return when (val outcome = clips.queue.run(jobId)) {
            Outcome.Done, Outcome.Skipped -> Result.success()
            is Outcome.Dropped -> {
                Log.i(TAG, "clip $jobId dropped: ${outcome.reason}")
                Result.success()
            }
            // Waiting on the session's offline create, or a failure worth
            // another go: WorkManager's backoff decides when.
            Outcome.Waiting, is Outcome.Retry -> Result.retry()
        }
    }

    override suspend fun getForegroundInfo(): ForegroundInfo = foregroundInfo()

    private fun foregroundInfo(): ForegroundInfo {
        val notification = notification(applicationContext)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ForegroundInfo(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            ForegroundInfo(NOTIFICATION_ID, notification)
        }
    }

    companion object {
        const val KEY_JOB = "job"
        private const val TAG = "clip-upload"
        private const val CHANNEL_ID = "clip-upload"
        private const val NOTIFICATION_ID = 1002

        /** Silent and low: it says an upload is running, nothing more. */
        fun notification(context: Context): Notification {
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
                .setContentTitle(context.getString(R.string.clip_upload_title))
                .setOngoing(true)
                .setSilent(true)
                .setProgress(0, 0, true)
                .setCategory(NotificationCompat.CATEGORY_PROGRESS)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build()
        }
    }
}
