package app.trackevolution.clips

import app.trackevolution.core.clips.ClipJob
import app.trackevolution.core.clips.ClipUploadQueue
import kotlin.math.floor

/**
 * The upload notification's one line over every clip on its way (NS-50). A
 * session saved lap by lap has a job per lap, and one notification per job
 * would be a dozen; they are said together, as the web says a session's jobs:
 * *"Saving 6 lap videos · 40%"* — the jobs still running, weighted by bytes.
 * A single job keeps NS-45's *"Uploading lap video"* — null here, so the
 * notification keeps its string resource. Pure, so it is tested without a
 * notification manager.
 */
internal object ClipUploadText {
    fun notificationTitle(jobs: List<ClipJob>, parts: Map<String, Long>): String? {
        val active = jobs.filter { it.state == ClipJob.State.CUTTING || it.state == ClipJob.State.PENDING }
        val n = active.size
        if (n <= 1) return null
        if (active.all { it.state == ClipJob.State.CUTTING }) return "Saving $n lap videos…"
        val bytes = active.sumOf { it.sizeBytes.coerceAtLeast(0) }
        val done = active.sumOf { it.sizeBytes.coerceAtLeast(0) * fraction(it, parts[it.id] ?: 0) }
        val pct = if (bytes > 0) " · ${floor(done / bytes * 100).toInt()}%" else ""
        return "Saving $n lap videos$pct"
    }

    /** The share of [job]'s bytes the server holds, plus [sending] of the part in flight. */
    fun fraction(job: ClipJob, sending: Long): Double {
        val partBytes = job.partBytes
        val parts = job.parts
        if (job.sizeBytes <= 0 || partBytes == null || parts == null) return 0.0
        val held = job.uploaded.sumOf { ClipUploadQueue.partRange(job.sizeBytes, partBytes, parts, it).second }
        return minOf(1.0, (held + sending).toDouble() / job.sizeBytes)
    }
}
