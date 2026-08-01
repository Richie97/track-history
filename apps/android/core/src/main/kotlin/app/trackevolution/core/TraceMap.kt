package app.trackevolution.core

/**
 * Maps a projected trace onto a view rectangle, and back again.
 *
 * The start/finish line picker needs both directions: forward to draw the trace,
 * backward to turn a tap into the trace index the user meant. Keeping the maths
 * here — pure, no Compose — is what makes it testable; the view only draws. A
 * direct port of the iOS `TraceMap`, so the two pickers place a gate in the same
 * place for the same tap.
 *
 * Note the y-flip. Trace coordinates are meters north ([GeoTrace.projectTrace]),
 * so larger y is *up*, while a view's y grows downward.
 */
public data class TraceMap(
    /** The view rectangle, in pixels. */
    public val width: Double,
    public val height: Double,
    /** Inset kept clear so the trace doesn't touch the edges. */
    public val padding: Double,
    /** Bounds of the trace in meters. */
    public val minX: Double,
    public val maxX: Double,
    public val minY: Double,
    public val maxY: Double,
    /** User zoom, 1 = fitted. */
    public val scale: Double,
    /** User pan, in pixels. */
    public val panX: Double,
    public val panY: Double,
) {
    /**
     * Meters per pixel before zoom — the same on both axes, so the track is not
     * stretched into the viewport's aspect ratio.
     */
    private val metersPerPixel: Double
        get() {
            val spanX = Math.max(maxX - minX, 1.0)
            val spanY = Math.max(maxY - minY, 1.0)
            val usableWidth = Math.max(width - padding * 2, 1.0)
            val usableHeight = Math.max(height - padding * 2, 1.0)
            return Math.max(spanX / usableWidth, spanY / usableHeight)
        }

    /** Where a trace point lands in the view. */
    public fun viewPoint(x: Double, y: Double): Point {
        val unit = metersPerPixel / scale
        val centreX = (minX + maxX) / 2
        val centreY = (minY + maxY) / 2
        return Point(
            x = width / 2 + (x - centreX) / unit + panX,
            // Flipped: north is up on screen.
            y = height / 2 - (y - centreY) / unit + panY,
        )
    }

    public fun viewPoint(point: TracePoint): Point = viewPoint(point.x, point.y)

    /** Where a view point lands in the trace's meters. */
    public fun traceCoordinate(viewX: Double, viewY: Double): Point {
        val unit = metersPerPixel / scale
        val centreX = (minX + maxX) / 2
        val centreY = (minY + maxY) / 2
        return Point(
            x = centreX + (viewX - panX - width / 2) * unit,
            y = centreY - (viewY - panY - height / 2) * unit,
        )
    }

    /**
     * The trace index nearest a tap, which is the point the user meant to pick.
     *
     * A closed circuit crosses itself, so "nearest in meters" is the honest
     * answer — there is no single correct index at a crossover, and picking
     * either branch gives the same gate geometry.
     */
    public fun nearestIndex(viewX: Double, viewY: Double, trace: List<TracePoint>): Int? {
        if (trace.isEmpty()) return null
        val target = traceCoordinate(viewX, viewY)
        var best = 0
        var bestDistance = Double.POSITIVE_INFINITY
        for (i in trace.indices) {
            val dx = trace[i].x - target.x
            val dy = trace[i].y - target.y
            val distance = dx * dx + dy * dy
            if (distance < bestDistance) {
                bestDistance = distance
                best = i
            }
        }
        return best
    }

    /** The gate as a pair of view points, for drawing the picked line. */
    public fun viewSegment(gate: Gate): Pair<Point, Point> =
        viewPoint(gate.x1, gate.y1) to viewPoint(gate.x2, gate.y2)

    public companion object {
        /**
         * Fits [trace] into a [width] × [height] rectangle, or null for an empty
         * trace or a viewport with no area — both of which are states the
         * picker legitimately passes through before its first layout.
         */
        public fun fit(
            trace: List<TracePoint>,
            width: Double,
            height: Double,
            padding: Double = 16.0,
            scale: Double = 1.0,
            panX: Double = 0.0,
            panY: Double = 0.0,
        ): TraceMap? {
            if (trace.isEmpty() || width <= 0 || height <= 0) return null
            var minX = Double.POSITIVE_INFINITY
            var maxX = Double.NEGATIVE_INFINITY
            var minY = Double.POSITIVE_INFINITY
            var maxY = Double.NEGATIVE_INFINITY
            for (p in trace) {
                if (p.x < minX) minX = p.x
                if (p.x > maxX) maxX = p.x
                if (p.y < minY) minY = p.y
                if (p.y > maxY) maxY = p.y
            }
            return TraceMap(
                width = width,
                height = height,
                padding = padding,
                minX = minX,
                maxX = maxX,
                minY = minY,
                maxY = maxY,
                scale = scale,
                panX = panX,
                panY = panY,
            )
        }
    }
}
