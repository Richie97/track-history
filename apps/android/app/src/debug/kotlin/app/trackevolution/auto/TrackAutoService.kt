package app.trackevolution.auto

import android.content.Intent
import androidx.car.app.CarAppService
import androidx.car.app.Screen
import androidx.car.app.Session
import androidx.car.app.SessionInfo
import androidx.car.app.validation.HostValidator
import app.trackevolution.BuildConfig

/**
 * The Android Auto entry point (NS-20).
 *
 * **This is in the `debug` source set and is not in a release build at all.**
 * Play rejected the app over it — see the category note below. It is kept
 * because it works and is tested; it is kept *here* because a release APK must
 * not merely fail to reach this code, it must not contain it.
 *
 * **This lives in `:app`, not the separate `:auto` module the spec asks for.**
 * The reason is structural rather than a preference: requirement 3 says talk to
 * the recorder *directly*, with no bridge layer, and `Recorder` and
 * `RecordingService` live here. A Gradle library module cannot depend on an
 * application module, so an `:auto` module could only reach them through exactly
 * the bridge the spec forbids — or by first extracting the whole foreground
 * service into a third module, which is a large refactor of shipped, working
 * code bought with no functional gain. Same call NS-15 and NS-16 made about
 * their own spec deviations, documented in the same place.
 *
 * **On the app category — this was reviewed, and it failed.** Android Auto has
 * no category for a driving-task app; the supported set is navigation, POI, IoT,
 * weather, media and communication. NS-20 shipped **POI** as the least-bad fit,
 * on the reasoning that the category is only *reviewed* once the app opts in to
 * the Android Auto form factor in the Play Console. The opt-in happened, the
 * review fired, and Play rejected the submission against car app quality `PF-1`
 * — "meaningful functionality relevant to driving" **in the declared category**.
 * A lap timer has no POI functionality and cannot acquire any, so this is not a
 * fixable finding; re-declaring under NAVIGATION would fail the same criterion.
 *
 * Two things about that are worth keeping in view. The review fires on any
 * submission carrying a car-compatible artifact while the form factor is opted
 * in — a `CarAppService` plus the `com.google.android.gms.car.application`
 * meta-data is what makes an artifact car-compatible. And a failure in the
 * production track rejects the **entire** submission, so this blocks ordinary
 * phone updates, which is why it is off the release classpath rather than just
 * unregistered.
 *
 * The fallback NS-20 documented is what ships instead, and it already exists:
 * the recording notification's Stop action (`RecordingNotification`) plus the
 * driving-sized `RecordScreen` on the phone.
 */
class TrackAutoService : CarAppService() {

    /**
     * Who is allowed to drive this app.
     *
     * The library's own allowlist in release — it pins the Google-signed Android
     * Auto and Automotive hosts, and a car app that trusts *any* host hands a
     * malicious one a UI that can start GPS recording. `ALLOW_ALL` only in debug,
     * because the Desktop Head Unit is not on that list and this would otherwise
     * be untestable.
     *
     * The release branch is unreachable while this class is debug-only, and is
     * kept rather than collapsed to ALLOW_ALL: if a driving-task category ever
     * exists and this is promoted back to src/main, the allowlist is the half
     * that must not have been quietly lost in the meantime.
     */
    override fun createHostValidator(): HostValidator =
        if (BuildConfig.DEBUG) {
            HostValidator.ALLOW_ALL_HOSTS_VALIDATOR
        } else {
            HostValidator.Builder(applicationContext)
                .addAllowedHosts(androidx.car.app.R.array.hosts_allowlist_sample)
                .build()
        }

    override fun onCreateSession(sessionInfo: SessionInfo): Session = TrackAutoSession()
}

/**
 * One session, one screen.
 *
 * The session is created when the car connects and destroyed when it
 * disconnects — which is precisely why nothing about the recording lives in it.
 * A recording started here survives the driver unplugging the phone, because it
 * was never this object's to own.
 */
class TrackAutoSession : Session() {
    override fun onCreateScreen(intent: Intent): Screen = RecordingScreen(carContext)
}
