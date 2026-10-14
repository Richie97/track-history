package app.trackevolution.core.clips

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import java.io.File

/**
 * The upload jobs, as one JSON file beside the clips they describe (NS-45):
 * `clips/manifest.json` in the app's private files. Plain `java.io`, so it
 * unit-tests against a real temp directory with no emulator — the same
 * arrangement as `RecordingJournal`.
 *
 * **Not a Room table, on purpose**: the offline database has no destructive
 * fallback and owes every schema change a real migration, and a handful of
 * jobs that are already allowed to fail (a clip never costs its session) is
 * not worth one. Every write replaces the file through a temp file and a
 * rename, so a crash mid-write leaves the previous manifest rather than half
 * of one.
 *
 * The directory is excluded from cloud backup and device transfer in both
 * backup XMLs: a restored manifest pointing at a clip that wasn't restored
 * with it is a dead job, and the clips themselves are hundreds of MB.
 *
 * One instance per process (`AppServices`): [jobs] is the in-memory copy the
 * lap page observes, and two instances over one file would each overwrite the
 * other's changes.
 */
public class ClipManifest(public val dir: File) {
    private val file = File(dir, "manifest.json")
    private val lock = Any()
    private val state = MutableStateFlow(load())

    /** Every job, observed by the lap page for its pending and failed states. */
    public val jobs: StateFlow<List<ClipJob>> = state.asStateFlow()

    public fun all(): List<ClipJob> = state.value

    public fun get(id: String): ClipJob? = state.value.firstOrNull { it.id == id }

    /** Inserts or replaces [job] by id. */
    public fun put(job: ClipJob) {
        mutate { list -> list.filterNot { it.id == job.id } + job }
    }

    /** Applies [change] to the job with [id], if it is still there; answers the result. */
    public fun update(id: String, change: (ClipJob) -> ClipJob): ClipJob? {
        var result: ClipJob? = null
        mutate { list ->
            list.map { if (it.id == id) change(it).also { next -> result = next } else it }
        }
        return result
    }

    /** Forgets the job and deletes its clip file — after a `complete`, or when it is dropped. */
    public fun remove(id: String) {
        val job = get(id)
        mutate { list -> list.filterNot { it.id == id } }
        job?.file?.let { File(it).delete() }
    }

    /**
     * Gives up on job [id] for [reason] (a `DropReason`'s raw value): its clip
     * file is deleted, and the job stays as [ClipJob.State.DROPPED] so its lap
     * can say so once ([acknowledge]).
     */
    public fun drop(id: String, reason: String, nowMs: Long) {
        val job = get(id) ?: return
        update(id) { it.copy(state = ClipJob.State.DROPPED, dropReason = reason, failedAt = nowMs, file = null) }
        job.file?.let { File(it).delete() }
    }

    /** The lap page has said this failure: forget it. A job still on its way is left alone. */
    public fun acknowledge(id: String) {
        if (get(id)?.failed == true) remove(id)
    }

    /**
     * Ends the backoff of job [id], or of every pending job when [id] is null —
     * not its failure count, so a server that really is down still backs off
     * after the next failure. Answers the pending jobs it covers.
     */
    public fun clearBackoff(id: String? = null): List<ClipJob> {
        mutate { list ->
            list.map {
                if (it.state == ClipJob.State.PENDING && (id == null || it.id == id) && it.notBeforeMs != null) {
                    it.copy(notBeforeMs = null)
                } else {
                    it
                }
            }
        }
        return all().filter { it.state == ClipJob.State.PENDING && (id == null || it.id == id) }
    }

    /**
     * At process start: a job still [ClipJob.State.CUTTING] was interrupted —
     * the cut runs in-process and the source video's grant died with it — so
     * it becomes a failed cut, said once on its lap. Also deletes any clip file
     * in the directory no job names (a cut that finished as the process died).
     */
    public fun recoverInterrupted(nowMs: Long = System.currentTimeMillis()) {
        mutate { list ->
            list.map {
                if (it.state == ClipJob.State.CUTTING) it.copy(state = ClipJob.State.CUT_FAILED, file = null, failedAt = nowMs) else it
            }
        }
        val named = state.value.mapNotNull { it.file?.let(::File)?.name }.toSet()
        dir.listFiles()?.forEach { f ->
            if (f.isFile && f.extension == "mp4" && f.name !in named) f.delete()
        }
    }

    /**
     * Drops failures — failed cuts and dropped uploads — older than
     * [maxAgeMs] that no lap page has said yet: a week is long enough for the
     * driver to have opened the lap if they were going to.
     */
    public fun prune(nowMs: Long, maxAgeMs: Long = FAILED_KEPT_MS) {
        mutate { list ->
            list.filterNot { it.failed && nowMs - (it.failedAt ?: it.createdAt) > maxAgeMs }
        }
    }

    /** Sign-out: every job and every clip goes, as the offline queue does. */
    public fun clear() {
        mutate { emptyList() }
        dir.listFiles()?.forEach { if (it.isFile && it.extension == "mp4") it.delete() }
    }

    private fun mutate(change: (List<ClipJob>) -> List<ClipJob>) {
        synchronized(lock) {
            val next = change(state.value)
            write(next)
            state.value = next
        }
    }

    private fun load(): List<ClipJob> {
        if (!file.isFile) return emptyList()
        return runCatching { json.decodeFromString(serializer, file.readText()) }.getOrDefault(emptyList())
    }

    private fun write(jobs: List<ClipJob>) {
        dir.mkdirs()
        val tmp = File(dir, "manifest.json.tmp")
        tmp.writeText(json.encodeToString(serializer, jobs))
        if (!tmp.renameTo(file)) {
            file.delete()
            tmp.renameTo(file)
        }
    }

    public companion object {
        /** How long an unsaid failure is kept for its lap to say: a week. */
        public const val FAILED_KEPT_MS: Long = 7L * 24 * 60 * 60 * 1000

        private val json = Json { ignoreUnknownKeys = true }
        private val serializer = ListSerializer(ClipJob.serializer())
    }
}
