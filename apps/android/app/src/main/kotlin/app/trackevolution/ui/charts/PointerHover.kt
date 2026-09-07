package app.trackevolution.ui.charts

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.PointerInputScope
import androidx.compose.ui.input.pointer.PointerType
import androidx.compose.ui.input.pointer.pointerInput

/**
 * Where the panel is pointing, and how firmly (NS-34 ticket 5).
 *
 * A tap **parks** a mark; a pointer only **borrows** one. Two fields rather than
 * one because hover is *additive to tap, never a replacement*: a tablet with a
 * mouse is still a tablet, and the same panel is touched a moment later. A
 * pointer crossing a plot marks as it goes and hands the tapped mark back the
 * moment it leaves, so a mark someone committed survives a mouse passing over
 * it — without the pair, moving the mouse would silently throw away the place
 * they had chosen.
 *
 * iOS keeps the same rule in `LapChannelChart.swift`'s `Mark` pair, under the
 * same two words.
 */
@Stable
class PanelPointer {
    /** What a tap committed, if anything. */
    var parked by mutableStateOf<ChannelHit?>(null)
        private set

    /** What a pointer is borrowing right now, if anything. */
    var hovered by mutableStateOf<ChannelHit?>(null)
        private set

    /** What everything drawn beside the panel should answer to. */
    val current: ChannelHit?
        get() = hovered ?: parked

    fun park(hit: ChannelHit?) {
        parked = hit
    }

    /** Null is the pointer leaving, which hands back whatever a tap had parked. */
    fun hover(hit: ChannelHit?) {
        hovered = hit
    }
}

/**
 * Report where a **mouse** is over this element, and when it leaves.
 *
 * Touch is filtered out at the source ([PointerType.Mouse]), which is the whole
 * trick: a finger dragging across a plot also produces move events, and treating
 * those as hover would make every scroll mark something and then unmark it. A
 * device with no mouse attached therefore behaves exactly as it did before —
 * which is the requirement, since this runs on phones too.
 *
 * The callback is given the [PointerInputScope] so it can read `size` and the
 * density, the same things the tap handler beside it hit-tests against.
 */
fun Modifier.pointerHover(
    vararg keys: Any?,
    onHover: PointerInputScope.(Offset?) -> Unit,
): Modifier =
    this.pointerInput(*keys) {
        val scope = this
        awaitPointerEventScope {
            while (true) {
                val event = awaitPointerEvent()
                val change = event.changes.firstOrNull() ?: continue
                if (change.type != PointerType.Mouse) continue
                when (event.type) {
                    PointerEventType.Enter, PointerEventType.Move -> scope.onHover(change.position)
                    PointerEventType.Exit -> scope.onHover(null)
                    else -> Unit
                }
            }
        }
    }
