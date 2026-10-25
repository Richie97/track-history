package app.trackevolution.recording

import android.os.Build
import app.trackevolution.core.telemetry.LapClips

/** Which review button a notification ask was for — saveable, so plain strings. */
internal const val SAVE = "save"
internal const val SAVE_TO_NEW_EVENT = "saveToNewEvent"

/**
 * Whether the review's save asks for `POST_NOTIFICATIONS` before it saves.
 *
 * A best-lap video (NS-45) uploads after the save as a data-sync foreground
 * service, and the service's notification is the one sign it is running once
 * the app is left — which on API 33+ the system hides without the permission.
 * The recorder asks for it when recording starts; a driver who only imports
 * video never meets the recorder, so without this they would never be asked.
 *
 * Asked only when a clip will actually be handed to the uploader: the row is
 * on (`ClipOffer.ON`, the Pro, storage-available state) and its switch is on.
 * A denial changes nothing but the notification — the save and the upload go
 * ahead either way — and after two denials the system answers for the user
 * without showing a dialog, so asking again on a later save costs nothing.
 *
 * Split out from the composable so the decision is plain-JUnit tested.
 */
internal object ClipNotificationAsk {
    fun shouldAsk(offer: LapClips.ClipOffer, saveClips: Boolean, sdkInt: Int, granted: Boolean): Boolean =
        offer == LapClips.ClipOffer.ON &&
            saveClips &&
            sdkInt >= Build.VERSION_CODES.TIRAMISU &&
            !granted
}
