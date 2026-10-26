package app.trackevolution.ui.stage

import app.trackevolution.ui.FoldPosture

/**
 * Which shape the lap stage takes (NS-51's *Layouts* table), decided by
 * [choose] from plain values so every row of the table is a JVM test
 * (`StageLayoutTest`) rather than a device to rotate.
 */
enum class StageLayout {
    /** ≥ 1000 dp of pane with room for a side column: videos left, map and now-strip right, pinned. */
    Wide,

    /** 600–999 dp: videos side by side, then the map beside the now-strip; the transport pins. */
    Medium,

    /** A phone or the closed Duo: a sticky player, B as an inset, the strip and mode as rows. */
    Compact,

    /** Half-open with a horizontal hinge: the picture above the crease, the transport and charts below. */
    Tabletop,

    /** Half-open with a vertical hinge: the stage on the left page, the charts on the right. */
    Book,

    /** A phone turned sideways with a video on the stage: the master video fills the window. */
    FullBleed,
    ;

    companion object {
        /** A pane at least this wide, with a side column to give, is [Wide]. */
        const val WIDE_MIN_DP: Float = 1000f

        /** A pane at least this wide is [Medium]; anything narrower is [Compact]. */
        const val MEDIUM_MIN_DP: Float = 600f

        /**
         * A landscape window shorter than this is a phone on its side.
         *
         * **Height, not class**, because NS-34 records that a 915 dp landscape
         * Pixel is an *expanded* window on this platform — Android has no
         * equivalent of UIKit's compact horizontal size class to say "this is
         * a phone" — while every tablet and the open Duo stand taller than this
         * in landscape, and never go full-bleed.
         */
        const val FULL_BLEED_MAX_HEIGHT_DP: Int = 480

        /**
         * The layout for a pane [contentWidthDp] wide (`PaneWidth`'s, never the
         * window's class), with [sideColumn] the answer of
         * `sideColumnWidth(0.24f, 280.dp, 360.dp)` (null: no room for one), the
         * fold [posture], whether the window is [landscape] and how tall it is,
         * and whether the stage [hasVideo] to fill a window with.
         *
         * Full-bleed outranks the rest — it is the phone turned to watch — but a
         * tabletop fold is never full-bleed: half-open on a table is the posture
         * built for the crease.
         */
        fun choose(
            contentWidthDp: Float,
            sideColumn: Boolean,
            posture: FoldPosture,
            landscape: Boolean,
            screenHeightDp: Int,
            hasVideo: Boolean,
        ): StageLayout = when {
            posture == FoldPosture.Tabletop -> Tabletop
            hasVideo && landscape && screenHeightDp < FULL_BLEED_MAX_HEIGHT_DP -> FullBleed
            posture == FoldPosture.Book -> Book
            contentWidthDp >= WIDE_MIN_DP && sideColumn -> Wide
            contentWidthDp >= MEDIUM_MIN_DP -> Medium
            else -> Compact
        }
    }
}
