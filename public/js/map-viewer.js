// The racing line on a real map (NS-53 ticket 4): the web's map viewer.
//
// A session's best-lap trace is local metres; its `trace_geo` says where those
// metres are measured from (public/js/import/geo.js). This draws the line over
// Apple's maps with MapKit JS — satellite imagery by default — where the
// driver can pan, pinch and rotate, and tap the line to read the speed there.
//
// Three rules shape it:
//
//   - **Nothing loads from Apple until the viewer is opened.** The script is
//     injected by loadMapKit on first use, never from index.html, and the page
//     authorises through GET /api/map-token, which the Worker signs.
//   - **The line never depends on the map.** No anchor, no key on this
//     deployment, no connection — each leaves the viewer open on the drawn
//     line (renderTrackMap) with one sentence saying why.
//   - **The device's own position is never asked for or shown.**
//
// The pure half is exported for unit tests; the DOM half is bindMapViewer.
// Web-only: the phones draw their platform's own maps.

import { KX, KY, nearestOnTrace, speedRuns, traceGeoBounds, unprojectTrace } from "./import/geo.js";
import { renderTrackMap } from "./trackmap.js";
import { esc } from "./format.js";
import { fmtDist, fmtSpeedKph } from "./units.js";

export const MAPKIT_SRC = "https://cdn.apple-mapkit.com/mk/5.x.x/mapkit.js";
export const MAP_TOKEN_PATH = "/api/map-token";

export const MAP_TYPES = ["satellite", "standard", "line"];
export const MAP_TYPE_LABELS = { satellite: "Satellite", standard: "Map", line: "Line" };
export const DEFAULT_MAP_TYPE = "satellite";
export const MAP_TYPE_KEY = "th-map-type";

// How close a tap has to land to the line to read it, in screen points.
export const TAP_RADIUS_PX = 24;
export const SPEED_BUCKETS = 16;
export const FIT_PADDING_PX = 48;

export const NOTE_NO_ANCHOR =
  "This session was saved before its position was kept, so there is no map to lay it on yet. " +
  "Import or record another session at this track and it will borrow that one's place.";
export const NOTE_NOT_SET_UP = "Map imagery isn't available here, so this is the line on its own.";
export const NOTE_OFFLINE = "Map imagery needs a connection.";
export const NOTE_APPROX = "Position estimated from another session here.";

// What the viewer can offer: the map types that work and the sentence that
// explains a missing one. `loadFailed` is MapKit's script or token not
// arriving — offline, or blocked.
export function viewerPlan({ geo, mapsOn, loadFailed = false }) {
  if (!geo) return { types: ["line"], note: NOTE_NO_ANCHOR };
  if (!mapsOn) return { types: ["line"], note: NOTE_NOT_SET_UP };
  if (loadFailed) return { types: ["line"], note: NOTE_OFFLINE };
  return { types: MAP_TYPES, note: geo.approx ? NOTE_APPROX : null };
}

// The type to open on: the remembered one when the plan still offers it.
export function startType(plan, remembered) {
  return plan.types.includes(remembered) ? remembered : plan.types[0];
}

export function currentMapType(storage = globalThis.localStorage) {
  try {
    const v = storage?.getItem(MAP_TYPE_KEY);
    return MAP_TYPES.includes(v) ? v : DEFAULT_MAP_TYPE;
  } catch {
    return DEFAULT_MAP_TYPE;
  }
}
export function setMapType(type, storage = globalThis.localStorage) {
  try {
    if (MAP_TYPES.includes(type)) storage?.setItem(MAP_TYPE_KEY, type);
  } catch {
    // private mode: the choice just isn't remembered
  }
}

const hex2rgb = (h) => {
  let s = String(h).trim().replace("#", "");
  if (s.length === 3) s = s.replace(/./g, (c) => c + c);
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
};

// A speed bucket's colour on the --map-slow → --map-fast ramp, at the
// bucket's midpoint, as the drawn track map colours a segment.
export function rampColor(bucket, buckets, slowHex, fastHex) {
  const slow = hex2rgb(slowHex);
  const fast = hex2rgb(fastHex);
  const t = (bucket + 0.5) / buckets;
  const c = slow.map((s, k) => Math.round(s + (fast[k] - s) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// A coordinate back into the trace's metres — projectTrace, for one point.
export function traceMetres(lat, lon, geo) {
  return [(lon - geo.lon) * KX(geo.lat), (lat - geo.lat) * KY];
}

// The direction of travel at a trace point, degrees clockwise from north.
export function headingDeg(trace, idx) {
  const a = trace[Math.max(0, idx - 1)];
  const b = trace[Math.min(trace.length - 1, idx + 1)];
  return ((Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI + 360) % 360;
}

// A tap at (lat, lon) with the map showing `metresPerPx`: the place on the
// line it reads, or null when it landed too far off it.
export function tapHit(trace, geo, lat, lon, metresPerPx) {
  const [x, y] = traceMetres(lat, lon, geo);
  return nearestOnTrace(trace, x, y, TAP_RADIUS_PX * metresPerPx);
}

// The lap's own channel reading at a fraction of its distance: speed in
// stored km/h and metres from the line. The trace's third value is not used —
// its unit depends on the source — so with no channel entry the read-out is
// the distance along the drawn line alone.
export function placeAt(hit, entry, dStepM) {
  const speed = entry?.speed;
  if (!Array.isArray(speed) || speed.length < 2 || !(dStepM > 0)) return { kph: null, distM: hit.alongM };
  const k = hit.frac * (speed.length - 1);
  const i = Math.min(speed.length - 2, Math.floor(k));
  const f = k - i;
  return { kph: speed[i] + (speed[i + 1] - speed[i]) * f, distM: k * dStepM };
}

export function readoutText(place, units) {
  const dist = fmtDist(Math.round(place.distM), units);
  return place.kph == null ? dist : `${fmtSpeedKph(place.kph, units)} · ${dist}`;
}

export function mapViewerHtml({ title, sub, closeHref }) {
  return `<div class="map-viewer" data-map-viewer>
    <div class="mv-top">
      <a class="backlink" href="${esc(closeHref)}" data-mv-close>← Back</a>
      <div class="mv-title"><strong>${esc(title)}</strong>${sub ? `<span>${esc(sub)}</span>` : ""}</div>
    </div>
    <p class="mv-note" data-mv-note hidden></p>
    <div class="mv-stage">
      <div class="mv-map" data-mv-map role="application" aria-label="Map of the racing line"></div>
      <div class="mv-line" data-mv-line hidden><canvas data-mv-canvas role="img" aria-label="Racing line of the best lap, colored by speed"></canvas></div>
      <p class="mv-readout" data-mv-readout aria-live="polite" hidden></p>
    </div>
    <div class="mv-bar">
      <div class="ch-axis" role="group" aria-label="Map type" data-mv-types></div>
      <button type="button" class="btn small" data-mv-fit>Fit</button>
    </div>
  </div>`;
}

// --- MapKit JS -----------------------------------------------------------------

let mapkitReady = null;

// Injects MapKit JS once and authorises it through the Worker's token route.
// Rejects — and forgets the attempt, so the next open tries again — when the
// script doesn't arrive.
export function loadMapKit(win = window) {
  if (win.mapkit?.Map && mapkitReady) return mapkitReady;
  mapkitReady = new Promise((resolve, reject) => {
    const init = () => {
      try {
        win.mapkit.init({
          authorizationCallback: (done) => {
            win
              .fetch(MAP_TOKEN_PATH, { credentials: "same-origin", cache: "no-store" })
              .then((r) => (r.ok ? r.json() : Promise.reject(new Error("token"))))
              .then((j) => done(j.token))
              .catch(() => done(""));
          },
        });
        resolve(win.mapkit);
      } catch (err) {
        mapkitReady = null;
        reject(err);
      }
    };
    if (win.mapkit?.Map) return init();
    const s = win.document.createElement("script");
    s.src = MAPKIT_SRC;
    s.crossOrigin = "anonymous";
    s.async = true;
    s.onload = init;
    s.onerror = () => {
      mapkitReady = null;
      s.remove();
      reject(new Error("MapKit JS did not load"));
    };
    win.document.head.appendChild(s);
  });
  return mapkitReady;
}

// A marker element whose *centre* sits on its coordinate: MapKit anchors a
// custom annotation at its element's bottom centre, and a zero-size wrapper's
// bottom centre is the point itself.
function pin(doc, html, cls) {
  const wrap = doc.createElement("div");
  wrap.className = "mv-pin";
  wrap.innerHTML = `<div class="mv-pin-in ${cls}">${html}</div>`;
  return wrap;
}

let current = null;

export function destroyMapViewer() {
  current?.destroy();
  current = null;
}

// Draws the viewer into `root` (mapViewerHtml's element).
//   trace, geo        the session's stored trace and its anchor (or null)
//   markers           [{ idx, label, glyphHtml }] — limit marks on the line
//   entry, dStepM     the traced lap's channel entry, for the tap's read-out
//   units, mapsOn     the driver's unit system; whether this deployment has a key
export function bindMapViewer(root, { trace, geo, markers = [], lineMarkers = [], entry = null, dStepM = null, units, mapsOn }) {
  destroyMapViewer();
  const win = root.ownerDocument.defaultView;
  const doc = root.ownerDocument;
  const $ = (sel) => root.querySelector(sel);
  const mapEl = $("[data-mv-map]");
  const lineEl = $("[data-mv-line]");
  const noteEl = $("[data-mv-note]");
  const readoutEl = $("[data-mv-readout]");
  const typesEl = $("[data-mv-types]");
  const fitBtn = $("[data-mv-fit]");

  let plan = viewerPlan({ geo, mapsOn });
  let type = startType(plan, currentMapType(win.localStorage));
  let map = null;
  let mk = null;
  let tapDot = null;
  let arrow = null;
  let dead = false;

  const cssVar = (name) => win.getComputedStyle(doc.documentElement).getPropertyValue(name).trim();
  const isDark = () => doc.documentElement.dataset.theme !== "light" &&
    (doc.documentElement.dataset.theme === "dark" || win.matchMedia("(prefers-color-scheme: dark)").matches);

  function drawControls() {
    typesEl.innerHTML = MAP_TYPES.map((t) => {
      const on = plan.types.includes(t);
      return `<button type="button" data-mv-type="${t}" aria-pressed="${t === type}"${on ? "" : " disabled"}>${MAP_TYPE_LABELS[t]}</button>`;
    }).join("");
    noteEl.textContent = plan.note ?? "";
    noteEl.hidden = !plan.note;
    fitBtn.hidden = type === "line";
  }

  function showLine() {
    mapEl.hidden = true;
    lineEl.hidden = false;
    readoutEl.hidden = true;
    const w = Math.max(320, Math.min(1100, lineEl.clientWidth || 760));
    renderTrackMap($("[data-mv-canvas]"), trace, { markers: lineMarkers, width: w });
  }

  function region() {
    const b = traceGeoBounds(trace, geo);
    return new mk.BoundingRegion(b.north, b.east, b.south, b.west).toCoordinateRegion();
  }

  function turnArrow() {
    if (arrow) arrow.el.style.transform = `translate(-50%, -50%) rotate(${arrow.deg - (map.rotation || 0)}deg)`;
  }

  function buildMap() {
    const pts = unprojectTrace(trace, geo).map((p) => new mk.Coordinate(p.lat, p.lon));
    map = new mk.Map(mapEl, {
      mapType: type === "standard" ? mk.Map.MapTypes.Standard : mk.Map.MapTypes.Satellite,
      colorScheme: isDark() ? mk.Map.ColorSchemes.Dark : mk.Map.ColorSchemes.Light,
      showsMapTypeControl: false,
      showsUserLocationControl: false,
      showsUserLocation: false,
      tracksUserLocation: false,
      showsZoomControl: true,
      isRotationEnabled: true,
      showsCompass: mk.FeatureVisibility.Adaptive,
      showsScale: mk.FeatureVisibility.Adaptive,
      padding: new mk.Padding(FIT_PADDING_PX, FIT_PADDING_PX, FIT_PADDING_PX, FIT_PADDING_PX),
    });
    map.region = region();

    // The casing first, so the speed colours read on pale concrete and dark
    // trees alike; then one overlay per run of one colour.
    const overlays = [
      new mk.PolylineOverlay(pts, {
        style: new mk.Style({ lineWidth: 8, strokeColor: "#0a0a0b", strokeOpacity: 0.6, lineCap: "round", lineJoin: "round" }),
      }),
    ];
    const slow = cssVar("--map-slow");
    const fast = cssVar("--map-fast");
    for (const run of speedRuns(trace, SPEED_BUCKETS)) {
      overlays.push(
        new mk.PolylineOverlay(pts.slice(run.from, run.to + 1), {
          style: new mk.Style({
            lineWidth: 5,
            strokeColor: rampColor(run.bucket, SPEED_BUCKETS, slow, fast),
            strokeOpacity: 1,
            lineCap: "round",
            lineJoin: "round",
          }),
        })
      );
    }
    map.addOverlays(overlays);

    const note = (coord, el, title) => new mk.Annotation(coord, () => el, { title, calloutEnabled: false, enabled: false });
    const annotations = [note(pts[0], pin(doc, "S/F", "mv-sf"), "Start/finish")];
    // The way round, a little past the line.
    const ai = Math.min(trace.length - 2, Math.max(1, Math.round(trace.length * 0.04)));
    const arrowWrap = pin(doc, "▲", "mv-arrow");
    arrow = { el: arrowWrap.firstElementChild, deg: headingDeg(trace, ai) };
    annotations.push(note(pts[ai], arrowWrap, "Direction of travel"));
    for (const m of markers) {
      if (pts[m.idx]) annotations.push(note(pts[m.idx], pin(doc, m.glyphHtml, "mv-limit"), m.label));
    }
    map.addAnnotations(annotations);
    turnArrow();
    map.addEventListener("rotation-end", turnArrow);
    map.addEventListener("region-change-end", turnArrow);

    map.addEventListener("single-tap", (e) => {
      const c = map.convertPointOnPageToCoordinate(e.pointOnPage);
      const metresPerPx = (map.region.span.latitudeDelta * KY) / Math.max(1, mapEl.clientHeight);
      const hit = tapHit(trace, geo, c.latitude, c.longitude, metresPerPx);
      if (tapDot) map.removeAnnotation(tapDot);
      tapDot = null;
      if (!hit) {
        readoutEl.hidden = true;
        return;
      }
      // The point on the line, not the vertex: between two fixes on a
      // straight the nearer vertex can be tens of metres off.
      const p = pointAlong(trace, hit.alongM);
      const at = unprojectTrace([[p[0], p[1], 0]], geo)[0];
      tapDot = note(new mk.Coordinate(at.lat, at.lon), pin(doc, "", "mv-tap"), "Selected point");
      map.addAnnotation(tapDot);
      readoutEl.textContent = readoutText(placeAt(hit, entry, dStepM), units);
      readoutEl.hidden = false;
    });
  }

  function showMap() {
    lineEl.hidden = true;
    mapEl.hidden = false;
    if (!map) buildMap();
    else map.mapType = type === "standard" ? mk.Map.MapTypes.Standard : mk.Map.MapTypes.Satellite;
  }

  async function show() {
    drawControls();
    if (type === "line") return showLine();
    if (!mk) {
      // The line while the map loads, so the page is never blank.
      showLine();
      try {
        mk = await loadMapKit(win);
      } catch {
        if (dead) return;
        plan = viewerPlan({ geo, mapsOn, loadFailed: true });
        type = "line";
        drawControls();
        return;
      }
      if (dead) return;
    }
    try {
      showMap();
    } catch {
      plan = viewerPlan({ geo, mapsOn, loadFailed: true });
      type = "line";
      drawControls();
      showLine();
    }
  }

  const onClick = (e) => {
    const t = e.target.closest("[data-mv-type]");
    if (t && !t.disabled) {
      type = t.dataset.mvType;
      setMapType(type, win.localStorage);
      show();
      return;
    }
    if (e.target.closest("[data-mv-fit]") && map) {
      const reduce = win.matchMedia("(prefers-reduced-motion: reduce)").matches;
      map.rotation = 0;
      map.setRegionAnimated(region(), !reduce);
    }
  };
  root.addEventListener("click", onClick);

  current = {
    root,
    destroy() {
      dead = true;
      root.removeEventListener("click", onClick);
      try {
        map?.destroy();
      } catch {
        // already gone with the page
      }
      map = null;
    },
  };
  show();
  return current;
}

// The point `alongM` metres down the line, in the trace's metres.
export function pointAlong(trace, alongM) {
  let cum = 0;
  for (let i = 0; i < trace.length - 1; i++) {
    const len = Math.hypot(trace[i + 1][0] - trace[i][0], trace[i + 1][1] - trace[i][1]);
    if (cum + len >= alongM && len > 0) {
      const t = (alongM - cum) / len;
      return [trace[i][0] + (trace[i + 1][0] - trace[i][0]) * t, trace[i][1] + (trace[i + 1][1] - trace[i][1]) * t];
    }
    cum += len;
  }
  const last = trace[trace.length - 1];
  return [last[0], last[1]];
}

// Escape leaves the viewer, bound once: shell() re-renders per route, so a
// per-render listener would accumulate.
if (typeof document !== "undefined") {
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !current?.root.isConnected) return;
    current.root.querySelector("[data-mv-close]")?.click();
  });
}
