package app.trackevolution.ui

import androidx.compose.runtime.staticCompositionLocalOf
import app.trackevolution.core.Units
import app.trackevolution.core.model.UnitSystem

/**
 * The unit system every display site reads: the account's choice from
 * `GET /api/me` (`User.effectiveUnits`), published once by `MainActivity` off
 * the auth state — the same shape as the web's `currentUnits()`, minus the
 * cache, since here every screen composes under the signed-in user and a
 * second copy of one value is how two screens come to disagree.
 *
 * `static` for the reason [LocalLayoutMetrics] is: it changes rarely (a tap in
 * Settings) and every chart reads it, so invalidating the whole subtree on the
 * few occasions it moves is the cheaper of the two.
 *
 * Defaults to imperial — what the app always showed — so a signed-out screen,
 * a preview and a test that never provides one read exactly as before.
 */
val LocalUnitSystem = staticCompositionLocalOf<UnitSystem> { Units.DEFAULT_UNITS }
