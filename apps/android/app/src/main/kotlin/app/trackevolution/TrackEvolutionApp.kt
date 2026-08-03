package app.trackevolution

import android.app.Application
import app.trackevolution.data.AppServices

/**
 * Owns the process-wide singletons.
 *
 * The app went without an `Application` class until NS-22, because nothing
 * needed to outlive an activity. The offline queue does: a replay worker can run
 * with no UI on screen, and it has to reach the *same* `OfflineStore` the UI
 * writes through — see [AppServices] for why an equivalent instance is not good
 * enough.
 */
class TrackEvolutionApp : Application() {

    override fun onCreate() {
        super.onCreate()
        // Starting the scheduler here, rather than from the activity, is the
        // point: writes queued in a paddock must replay on reconnect even if
        // the app was launched by the recording notification and never showed
        // the logbook at all.
        AppServices.get(this).sync.start()
    }
}
