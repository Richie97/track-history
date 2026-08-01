package app.trackevolution.recording

import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

/**
 * Confirmation you can feel.
 *
 * Not decoration: with gloves on, in a helmet, in a loud car, a phone on a mount
 * is unreadable and inaudible. A buzz is the only reliable channel for "the
 * recording actually started" and "that was a personal best", which is why the
 * web app has `platform.hapticPB` at all.
 */
object Haptics {

    /** Start or stop confirmed — one firm tap. */
    fun confirm(context: Context) = vibrate(context, longArrayOf(0, 45))

    /**
     * A personal best — two quick taps, deliberately distinct from [confirm] so
     * the two are told apart through a glove without looking.
     */
    fun personalBest(context: Context) = vibrate(context, longArrayOf(0, 35, 90, 55))

    /** Something went wrong — a longer, duller buzz. */
    fun warn(context: Context) = vibrate(context, longArrayOf(0, 140))

    private fun vibrate(context: Context, pattern: LongArray) {
        val vibrator = vibrator(context) ?: return
        if (!vibrator.hasVibrator()) return
        // Amplitudes left at default: a track-day phone is in a mount or a
        // pocket, and the strongest available is the right one either way.
        runCatching {
            vibrator.vibrate(VibrationEffect.createWaveform(pattern, -1))
        }
    }

    private fun vibrator(context: Context): Vibrator? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)
                ?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
}
