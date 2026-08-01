package app.trackevolution.core

import java.io.File

/**
 * Locates the repository root by walking up from the Gradle working directory.
 *
 * The contract fixtures (`contracts/golden/`) are read from the repo rather than
 * copied into the module's test resources: a copy would go stale exactly when it
 * mattered, which is the opposite of what those fixtures are for. The iOS kit
 * does the same thing in its own `RepoRoot`.
 */
object RepoRoot {
    val dir: File = run {
        var candidate: File? = File(System.getProperty("user.dir")).absoluteFile
        while (candidate != null) {
            if (File(candidate, "package.json").isFile) return@run candidate
            candidate = candidate.parentFile
        }
        error("repository root not found above ${System.getProperty("user.dir")}")
    }

    fun path(relative: String): File = File(dir, relative)
}
