# Reddit launch teaser — Track Evolution

Draft copy for a launch post on r/trackdays / r/HPDE / r/cars / marque subs.
Written to read like a person, not a press release — Reddit's tolerance for
marketing is roughly zero, so the post leads with the itch and buries the
"free" until it's earned.

Everything claimed below is checked against what actually ships (see the
"Deliberately not mentioned" list at the bottom — don't add those back in).

---

## Title options

1. `I got tired of tracking my lap times in a spreadsheet, so I spent a year building a proper track-day logbook. It's free.`
2. `Made a track-day logbook that pulls your lap times straight out of PDR / GoPro / VBO footage — in the browser, nothing uploaded`
3. `Free HPDE logbook: lap times, progress charts, and it tells you your pads are done before the weekend instead of after`

Option 1 is the safest general-audience opener. Option 2 is the better title
for marque subs (r/Corvette, r/GoPro-adjacent, data nerds). Option 3 works
where the audience is people who wrench on their own car.

---

## Main post

**Track Evolution — your track days, remembered lap by lap**

I've been doing HPDE weekends for a few years and my whole record of it was a
spreadsheet with a "best time" column, plus a shoebox of GoPro footage I never
watched again. I could tell you I was faster than last year. I couldn't tell
you *where*, or by how much, or what I'd changed on the car.

So I built the thing I wanted. It's live at **https://trackevolution.app**,
it's free, and there's no ads and no upsell.

**What it does**

- **Logs the weekend the way the weekend actually works** — tracks → events →
  sessions → laps. Layouts are separate (VIR Full and VIR Patriot are not the
  same track), so your bests never get mixed together.
- **Charts progress over time.** Best lap per event, per track, season over
  season. Lower is faster, so getting quicker trends downward — which is a
  weirdly satisfying line to watch.
- **Pulls laps out of footage you already have.** Drop in a Corvette PDR video,
  a GoPro (Hero 5+), or a Racelogic VBO file (RaceChrono / TrackAddict /
  Harry's LapTimer exports work too) and you get a session with real lap times,
  the racing line, and per-lap speed graphs. **The video never leaves your
  computer** — it reads a few MB of telemetry out of a multi-GB file by byte
  range, entirely in the browser. Nothing gets uploaded.
- **No transponder? No problem.** If your source has no lap markers, it shows
  you the track map you actually drove and you click where start/finish is.
  Laps get timed on every pass across it, interpolated between GPS fixes —
  good to about a tenth or two, and marked with a `~` so you know it's derived.
- **Overlays laps against each other.** Speed (plus RPM and lateral G for PDR)
  resampled onto a driven-distance axis, so laps line up corner-for-corner
  instead of by time. Pick up to three laps to highlight; the rest sit behind
  them as a dim envelope.
- **Stats that mean something.** Consistency as an actual coefficient of
  variation, best-N averages, pace trend across a session, and how long your
  warmup really takes. Not vibes.
- **A garage that does the arithmetic you keep forgetting.** Log a set of pads
  or tires once and it accrues hours from the events you already logged —
  you never log usage. It projects remaining life from your wear measurements
  and tells you "front pads: about two days left" *before* you load the
  trailer. Tires additionally count heat cycles. Retired parts keep their
  cost-per-hour history, which is either useful or horrifying.
- **Setup notebook per event day** — pressures cold and hot per corner, camber,
  toe, damper clicks, sway, fuel. Each new day copies forward from the last, so
  you only type what changed. Then the track page puts every setup sheet next
  to the lap times it produced, with the changes called out. That table is the
  reason I built the garage half at all.
- **Works with no signal.** Every paddock I've been in has terrible service, so
  the whole logbook is readable offline and anything you type at the track
  queues up and syncs when you get bars back.
- **Share a link** to an event or a track if you want to — it shows times and
  stats, and strips your notes, your email, your setup sheets and your spend.

**What it isn't**

It's not a data-analysis suite. There's no video overlay renderer, no delta
bar against a reference lap, no track-map sector splits. It's a logbook that
happens to read your telemetry — if you live in AiM Race Studio or Motec, this
isn't replacing that.

It also only knows the tracks people have entered, and lap detection on
GPS-only sources is derived rather than beacon-accurate. I flag every derived
time with a `~` rather than pretending.

**The boring but important part**

Free, no ads, and I'm not doing anything with your data. It's open source
(Apache 2.0) if you want to read exactly what it does or run your own copy:
https://github.com/richie97/track-history

I'd genuinely like to know what's missing before I build the wrong next thing.
If you log your track days some other way, I want to hear what your way does
better.

---

## Short version (crosspost, or a comment in someone else's thread)

> I built a free track-day logbook — https://trackevolution.app. Events,
> sessions and lap times per track, with progress charts across seasons. It can
> pull lap times, racing lines and speed/RPM traces straight out of Corvette
> PDR, GoPro or VBO files, parsed in your browser so the video never gets
> uploaded, and if the source has no lap markers you just click start/finish on
> the track map you drove. It also tracks pad/tire wear against your logged
> track hours and keeps setup sheets next to the lap times they produced.
> Free, no ads, open source. Feedback very welcome.

---

## One-liner (for a sub's "what are you working on" thread or a flair-limited sub)

> A free track-day logbook that reads lap times out of your PDR/GoPro/VBO
> footage in-browser, charts you getting faster, and warns you about your pads
> before the weekend — https://trackevolution.app

---

## Posting notes

- **Lead with a screenshot** of the best-lap-over-time chart on a real track
  with real event names. It's the single most legible thing in the app and it
  explains the name in one glance. Second-best image: the channel overlay with
  three laps highlighted.
- **Check each sub's self-promo rule before posting.** Several car subs require
  an approved-creator flair or a "no links in the title" format; a removed post
  burns the launch. Post to one sub, see what lands, then adapt.
- **Answer the "why not just use ___" comments straight.** Somebody will name
  RaceChrono, Harry's LapTimer, TrackAddict or Apex Pro in the first ten
  comments. The honest answer is that this doesn't replace a lap timer — it
  imports from them, and it's the season-long record they don't keep.
- **"Is my data safe" will come up.** The real answers: parsing is local, the
  video never uploads, share pages strip personal data, and the source is
  public. Say it plainly, don't get defensive.
- Post Tuesday–Thursday morning US Eastern; track subs are quiet on weekends
  because everyone is at a track.

## Deliberately not mentioned (keep it that way)

- **CarPlay.** The scene ships inert and stays dormant until Apple grants the
  driving-task entitlement. Don't advertise it until a CarPlay-enabled build is
  actually in users' hands.
- **App store availability.** The post above describes phone GPS lap recording
  only in the "what it does" list via the web app's terms; if the iOS/Android
  builds aren't live in the stores yet, do **not** add "download it on the App
  Store" — swap in the phone-recording bullet below only once there's a link:
  > **Record laps with just your phone.** The app times laps off the phone's
  > GPS with the screen locked — start it on grid, stow the phone, pick your
  > start/finish line back in the paddock. No camera, no lap timer, no
  > hardware.
- **Cloudflare, Workers, D1, the stack in general.** Nobody on r/trackdays
  cares, and it makes a logbook sound like a side project instead of a tool.
  (Same policy as the docs site.)
