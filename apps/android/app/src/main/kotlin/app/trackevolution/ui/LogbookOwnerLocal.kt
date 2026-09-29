package app.trackevolution.ui

import androidx.compose.runtime.staticCompositionLocalOf
import app.trackevolution.core.api.LogbookOwner

/**
 * Whose logbook the composition below is showing (NS-38), for the leaf
 * decisions no screen should have to thread a parameter through — today, what
 * the channel panel says where a student's channels stop at the free half. The
 * screens' own decisions (read-only, the tier) are explicit parameters; this is
 * only for wording. Published by `LogbookOwnerScope` for a student's pages.
 */
val LocalLogbookOwner = staticCompositionLocalOf<LogbookOwner> { LogbookOwner.Me }

/**
 * What a coach is told where a free student's channels stop — in place of the
 * paywall, which is the student's to answer, not theirs. `studentFreeNote` in
 * `public/app.js`.
 */
fun studentFreeNote(name: String?): String =
    "${name ?: "This driver"} is on the free plan, so you see their lap times, racing lines and the " +
        "speed, throttle and brake traces. Steering, RPM, lateral G, sector splits, the friction circle and the " +
        "rest of the analysis show here once they have Pro."
