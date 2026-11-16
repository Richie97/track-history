package app.trackevolution.ui.map

import android.graphics.Point
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import app.trackevolution.core.GeoPoint
import app.trackevolution.core.GeoTrace
import app.trackevolution.core.Limits
import app.trackevolution.core.MapViewer
import app.trackevolution.core.model.TraceGeo
import app.trackevolution.core.model.TracePoint
import app.trackevolution.ui.charts.limitColor
import app.trackevolution.ui.theme.TrackTheme
import com.google.android.gms.maps.CameraUpdateFactory
import com.google.android.gms.maps.model.CameraPosition
import com.google.android.gms.maps.model.JointType
import com.google.android.gms.maps.model.LatLng
import com.google.android.gms.maps.model.LatLngBounds
import com.google.android.gms.maps.model.RoundCap
import com.google.android.gms.maps.model.StrokeStyle
import com.google.android.gms.maps.model.StyleSpan
import com.google.maps.android.compose.ComposeMapColorScheme
import com.google.maps.android.compose.GoogleMap
import com.google.maps.android.compose.MapProperties
import com.google.maps.android.compose.MapType
import com.google.maps.android.compose.MapUiSettings
import com.google.maps.android.compose.MarkerComposable
import com.google.maps.android.compose.MarkerState
import com.google.maps.android.compose.Polyline
import com.google.maps.android.compose.rememberCameraPositionState
import kotlin.math.hypot

/**
 * What the map half of the viewer is asked to draw (NS-53). Plain values and
 * two callbacks, so a test's [MapSupport.drawMap] can stand in for Google's.
 */
data class MapDraw(
    val trace: List<TracePoint>,
    val geo: TraceGeo,
    /** [MapViewer.MapType.SATELLITE] or [MapViewer.MapType.STANDARD]; never LINE. */
    val type: MapViewer.MapType,
    val markers: List<Limits.Marker>,
    /** The tapped place on the line, in degrees, or null. */
    val selected: GeoPoint?,
    /** Bumped by *Fit*: each new value re-fits the camera to the line, north up. */
    val fitKey: Int,
    /** A tap at a coordinate, with the map's current scale in metres per dp. */
    val onTap: (lat: Double, lon: Double, metresPerDp: Double) -> Unit,
)

/**
 * The line on Google's map (NS-53): satellite by default, the standard style
 * following the app's theme, the speed ramp as one solid-coloured span per
 * [GeoTrace.speedRuns] run — the same metres the same colour as the web's
 * overlays and the drawn card — over a near-black casing so it reads on pale
 * concrete and dark trees alike.
 *
 * No tilt (a pitched camera bends the colours away from the reader), no
 * my-location layer or button (the viewer never asks for the device's
 * position), no toolbar. Google's logo and legal link are the SDK's own and
 * left where it puts them.
 */
@Composable
fun GoogleTrackMap(d: MapDraw) {
    val colors = TrackTheme.colors
    val dark = TrackTheme.isDark
    val density = LocalDensity.current
    val context = LocalContext.current

    val points = remember(d.trace, d.geo) { GeoTrace.unprojectTrace(d.trace, d.geo).map { LatLng(it.lat, it.lon) } }
    val bounds = remember(d.trace, d.geo) {
        val b = GeoTrace.traceGeoBounds(d.trace, d.geo)!!
        LatLngBounds(LatLng(b.south, b.west), LatLng(b.north, b.east))
    }
    val slow = colors.mapSlow.toArgb() and 0xFFFFFF
    val fast = colors.mapFast.toArgb() and 0xFFFFFF
    val spans = remember(d.trace, slow, fast) {
        GeoTrace.speedRuns(d.trace, MapViewer.SPEED_BUCKETS).map { run ->
            StyleSpan(
                StrokeStyle.colorBuilder(MapViewer.rampColor(run.bucket, MapViewer.SPEED_BUCKETS, slow, fast)).build(),
                (run.to - run.from).toDouble(),
            )
        }
    }
    val reduceMotion = remember(context) {
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    }

    val camera = rememberCameraPositionState {
        position = CameraPosition.fromLatLngZoom(bounds.center, 15f)
    }
    var loaded by remember { mutableStateOf(false) }
    // Out to twice the fitted span — one zoom level — and no further.
    var minZoom by remember { mutableStateOf<Float?>(null) }
    val padPx = with(density) { MapViewer.FIT_PADDING_PX.dp.roundToPx() }

    LaunchedEffect(loaded, d.fitKey) {
        if (!loaded) return@LaunchedEffect
        val fit = CameraUpdateFactory.newLatLngBounds(bounds, padPx)
        if (d.fitKey == 0 || reduceMotion) camera.move(fit) else camera.animate(fit)
        if (minZoom == null) minZoom = camera.position.zoom - 1f
    }

    val casingWidth = with(density) { 7.dp.toPx() }
    val lineWidth = with(density) { 5.dp.toPx() }

    GoogleMap(
        modifier = Modifier.fillMaxSize(),
        cameraPositionState = camera,
        properties = MapProperties(
            mapType = if (d.type == MapViewer.MapType.STANDARD) MapType.NORMAL else MapType.SATELLITE,
            isMyLocationEnabled = false,
            minZoomPreference = minZoom ?: 3f,
            isIndoorEnabled = false,
            isBuildingEnabled = false,
        ),
        uiSettings = MapUiSettings(
            compassEnabled = true,
            myLocationButtonEnabled = false,
            mapToolbarEnabled = false,
            tiltGesturesEnabled = false,
            zoomControlsEnabled = false,
            indoorLevelPickerEnabled = false,
            rotationGesturesEnabled = true,
            scrollGesturesEnabled = true,
            zoomGesturesEnabled = true,
        ),
        mapColorScheme = if (dark) ComposeMapColorScheme.DARK else ComposeMapColorScheme.LIGHT,
        onMapLoaded = { loaded = true },
        onMapClick = { at ->
            // The map's scale where it is, from two screen points a known
            // distance apart, in the trace's own metres (rotation-proof).
            val metresPerDp = camera.projection?.let { p ->
                val a = p.fromScreenLocation(Point(0, 0))
                val b = p.fromScreenLocation(Point(0, 100))
                val ma = MapViewer.traceMetres(a.latitude, a.longitude, d.geo)
                val mb = MapViewer.traceMetres(b.latitude, b.longitude, d.geo)
                hypot(mb.x - ma.x, mb.y - ma.y) / 100.0 * density.density
            } ?: 1.0
            d.onTap(at.latitude, at.longitude, metresPerDp)
        },
    ) {
        Polyline(
            points = points,
            color = Color(0xFF0A0A0B).copy(alpha = 0.6f),
            width = casingWidth,
            jointType = JointType.ROUND,
            startCap = RoundCap(),
            endCap = RoundCap(),
            zIndex = 0f,
        )
        Polyline(
            points = points,
            spans = spans,
            width = lineWidth,
            jointType = JointType.ROUND,
            startCap = RoundCap(),
            endCap = RoundCap(),
            zIndex = 1f,
        )

        // Start/finish, and the way round a little past it.
        MarkerComposable(
            keys = arrayOf("sf"),
            state = remember(points) { MarkerState(points.first()) },
            anchor = Offset(0.5f, 0.5f),
            title = "Start/finish",
            zIndex = 2f,
        ) {
            Text(
                "S/F",
                style = TrackTheme.typography.xxs,
                color = Color.White,
                modifier = Modifier
                    .background(Color(0xE60A0A0B), RoundedCornerShape(4.dp))
                    .padding(horizontal = 4.dp, vertical = 1.dp),
            )
        }
        val ai = remember(d.trace) { (d.trace.size * 0.04).toInt().coerceIn(1, d.trace.size - 2) }
        MarkerComposable(
            keys = arrayOf("arrow", ai),
            state = remember(points, ai) { MarkerState(points[ai]) },
            anchor = Offset(0.5f, 0.5f),
            // Flat, so it turns with the map and keeps pointing along the line.
            flat = true,
            rotation = MapViewer.headingDeg(d.trace, ai).toFloat(),
            title = "Direction of travel",
            zIndex = 2f,
        ) {
            Text("▲", style = TrackTheme.typography.sm, color = Color.White)
        }

        for (m in d.markers) {
            val kind = Limits.kindDef(m.kind) ?: continue
            val at = points.getOrNull(m.idx) ?: continue
            MarkerComposable(
                keys = arrayOf("limit", m.kind, m.idx),
                state = remember(at) { MarkerState(at) },
                anchor = Offset(0.5f, 0.5f),
                title = kind.label,
                zIndex = 3f,
            ) {
                val c = limitColor(kind.side, colors)
                Box(
                    Modifier
                        .size(12.dp)
                        .background(if (kind.filled) c else colors.surfaceCard, CircleShape)
                        .border(2.dp, if (kind.filled) colors.surfaceCard else c, CircleShape),
                )
            }
        }

        d.selected?.let { sel ->
            val at = LatLng(sel.lat, sel.lon)
            MarkerComposable(
                keys = arrayOf("tap", sel.lat, sel.lon),
                state = remember(at) { MarkerState(at) },
                anchor = Offset(0.5f, 0.5f),
                title = "Selected point",
                zIndex = 4f,
            ) {
                Box(
                    Modifier
                        .size(16.dp)
                        .background(colors.accent, CircleShape)
                        .border(3.dp, Color.White, CircleShape),
                    contentAlignment = Alignment.Center,
                ) {}
            }
        }
    }
}
