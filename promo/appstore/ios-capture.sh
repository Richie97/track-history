#!/usr/bin/env bash
# Record the app preview's footage: the native iOS app in the Simulator,
# signed in to the demo logbook, one clip per scene into out/ios/<scene>.mov.
# macOS with Xcode only. With `node appstore/serve.mjs` running in another
# terminal:
#
#   appstore/ios-capture.sh                       every scene, on an iPhone 17 Pro Max
#   appstore/ios-capture.sh "iPhone 17 Pro Max" garage   re-record one scene
#
# It builds and installs a Debug build if the Simulator has none (the
# -server.url / -authToken launch arguments are DEBUG-only), sets dark mode and
# Apple's 9:41 status bar, grants location, and for each scene prints what to
# do, records between two presses of Return, and moves on. For the recorder it
# also drives the COTA racing line through the simulated GPS, a lap at a time
# at slightly different speeds. Trim the clips afterwards in out/ios/trims.json
# ({ "<scene>": seconds into the clip where the scene starts }) and render with
# `node appstore/render-preview.mjs`.
set -euo pipefail
cd "$(dirname "$0")/.."

DEVICE="${1:-iPhone 17 Pro Max}"
ONLY="${2:-}"
BUNDLE=app.trackevolution
IOS=out/ios
[ -f "$IOS/session.env" ] || { echo "no $IOS/session.env — start \`node appstore/serve.mjs\` first" >&2; exit 1; }
# shellcheck disable=SC1091
source "$IOS/session.env"
curl -fsS -o /dev/null -H "Authorization: Bearer $TE_TOKEN" "$TE_SERVER/api/me" \
  || { echo "the demo server at $TE_SERVER isn't answering — is \`node appstore/serve.mjs\` running?" >&2; exit 1; }

UDID=$(xcrun simctl list devices available -j | node -e '
  const name = process.argv[1];
  const all = Object.values(JSON.parse(require("fs").readFileSync(0, "utf8")).devices).flat();
  const d = all.find((x) => x.name === name);
  if (!d) { console.error(`no available simulator named "${name}"`); process.exit(1); }
  console.log(d.udid);' "$DEVICE")
echo "simulator: $DEVICE ($UDID)"
xcrun simctl boot "$UDID" 2>/dev/null || true
open -a Simulator --args -CurrentDeviceUDID "$UDID"
xcrun simctl bootstatus "$UDID" -b >/dev/null

if ! xcrun simctl get_app_container "$UDID" "$BUNDLE" >/dev/null 2>&1; then
  echo "building a Debug build for the simulator…"
  xcodebuild -project ../apps/ios/TrackEvolution.xcodeproj -scheme TrackEvolution -configuration Debug \
    -destination "id=$UDID" -derivedDataPath "$IOS/DerivedData" build -quiet
  xcrun simctl install "$UDID" "$IOS/DerivedData/Build/Products/Debug-iphonesimulator/TrackEvolution.app"
fi

xcrun simctl ui "$UDID" appearance dark
xcrun simctl status_bar "$UDID" override --time 9:41 --dataNetwork wifi --wifiMode active --wifiBars 3 \
  --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100
xcrun simctl privacy "$UDID" grant location-always "$BUNDLE" 2>/dev/null \
  || xcrun simctl privacy "$UDID" grant location "$BUNDLE"

launch() {
  xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
  xcrun simctl launch "$UDID" "$BUNDLE" -server.url "$TE_SERVER" -resetAuth -resetRecording -authToken "$TE_TOKEN" >/dev/null
}

# The simulated drive: one lap of waypoints per `simctl location start`, each
# lap a little quicker or slower, so lap times — and the delta — differ.
DRIVE_PID=""
drive() {
  # (macOS's bash is 3.2: no mapfile; the lines hold no spaces)
  local speeds=(38 40.5 39 41.5 40 42)
  local waypoints
  # shellcheck disable=SC2207
  waypoints=($(cat "$IOS/cota-lap.txt"))
  (
    while :; do
      for v in "${speeds[@]}"; do
        xcrun simctl location "$UDID" start --speed="$v" "${waypoints[@]}" >/dev/null 2>&1 &
        sleep "$(node -e "console.log(($TE_LAP_M / $v).toFixed(1))")"
      done
    done
  ) &
  DRIVE_PID=$!
}
park() {
  [ -n "$DRIVE_PID" ] && kill "$DRIVE_PID" 2>/dev/null || true
  DRIVE_PID=""
  xcrun simctl location "$UDID" clear >/dev/null 2>&1 || true
}
trap park EXIT

record() {
  local id=$1 secs=$2 caption=$3 how=$4
  echo
  echo "── $id ── \"$caption\" (${secs} s in the cut — give it a few more)"
  echo "   $how"
  read -r -p "   Get to the starting screen, then press Return to start recording… " _
  xcrun simctl io "$UDID" recordVideo --codec=h264 --force "$IOS/$id.mov" >/dev/null 2>&1 &
  local rec=$!
  sleep 1
  read -r -p "   Recording. Do the move, then press Return to stop… " _
  kill -INT "$rec"
  wait "$rec" 2>/dev/null || true
  echo "   wrote $IOS/$id.mov"
}

launch
while IFS=$'\t' read -r id secs caption how; do
  [ -n "$ONLY" ] && [ "$ONLY" != "$id" ] && continue
  if [ "$id" = "record" ]; then
    drive
    echo
    echo "   The simulated drive is running round COTA (~2¼ min a lap). Tap Record laps → Start now;"
    echo "   the predictive delta appears once a lap is done — record after the second."
  fi
  record "$id" "$secs" "$caption" "$how"
  [ "$id" = "record" ] && park
done < <(node appstore/shots.mjs --tsv)

xcrun simctl status_bar "$UDID" clear
echo
echo "done — set the trims in $IOS/trims.json, then: node appstore/render-preview.mjs"
