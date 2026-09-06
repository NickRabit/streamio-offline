# Player improvements taken from stremio-web

Technical specification. Compares the upstream Stremio web client
(`Stremio/stremio-web`, v5.0.0-beta.39) with the player in this project and
describes what is worth adopting, how, and in what order.

## 0. Binding constraint: source addresses never reach the client

Everything below is subject to one rule: **the browser must never see a source
address, and never see the headers that authorise it.** All traffic goes through
`/api/proxy`, so the provider only ever sees the server. A URL or token that
leaks into the page can be copied out of devtools, an extension, history or a
screenshot and replayed from another address, which is what gets an account or a
debrid token banned.

### 0.1 Where we break that rule today

| Leak | What the browser gets |
| --- | --- |
| `GET /api/streams/:type/:id` | the addon's `Stream` objects verbatim, including `url` and `behaviorHints.proxyHeaders` |
| Direct play descriptor | `describe()` returns `proxyPath(stream)`, i.e. `/api/proxy?url=<source>&headers=<base64 of the auth headers>`, and that string becomes the `<video>` source |
| Proxied HLS playlists | `/api/proxy` rewrites every playlist line to `/api/proxy?url=…`, so in direct mode the source address is repeated per segment |
| `GET /api/subtitle?url=…` | the addon's subtitle address |
| `GET /api/library/file?path=…` | the absolute path inside the container |

The bytes already flow through us, so the provider sees one address. The exposure
is that the credential itself is handed to the client, and its reuse from
elsewhere is not something we can detect or revoke.

### 0.2 P0 — opaque handles

Ship this before any of the player work below; the seek work in P1 touches the
same descriptors.

1. **Mint a handle instead of a URL.** Sealed token, not a stored map: the
   handle is `base64url(AES-256-GCM(JSON{url, proxyHeaders, addonKey, addonName,
   title, exp}))` under a key kept in the data directory (generated on first
   boot, never in a backup export). Stateless, so it survives a server restart
   mid-playback, and expiry is inside the sealed payload.
2. **`/api/streams` returns `handle` in place of `url`,** plus the booleans the
   UI actually uses (`playable`, `p2p`, `external`). The client already treats
   `stream.url` only as "is this playable" plus `file://` bookkeeping, so this is
   a narrow change on the client.
3. **`/api/inspect`, `/api/playback`, `/api/downloads` and the device download
   accept `handle`** instead of a whole `Stream`. The server resolves it; nothing
   about the source crosses back.
4. **`/api/proxy` stops accepting `?url=` from the browser.** It takes `?h=`
   only. The raw form stays for internal callers — FFmpeg and the download queue
   go through localhost with `INTERNAL_TOKEN` — and is rejected on any request
   that is not internal. Playlist rewriting emits `?h=` handles derived from the
   same sealed key.
5. **`/api/subtitle` and `/api/library/file` take handles too** (a library
   handle seals the relative path, so the container layout stays private).
6. Handles are bound to the logged-in session and expire (a few hours is enough
   to cover one playback with restarts). An expired handle returns 410 and the
   client re-fetches the stream list, which is what it already does when a
   session disappears.

**Tests:** an e2e assertion that no response body served to the browser matches
the fake addon's source host, and a unit test that `/api/proxy?url=…` without the
internal token is refused.

**Effect on the rest of this document:** all session URLs (`/api/playback/<id>/
<generation>/master.m3u8`) are already opaque, so P1-B and P1-C are unaffected.
P1-A is client-only. The one place to watch is direct play — it is the mode that
puts a proxy address straight into the `<video>` element, so it must be the first
consumer of handles.


## 1. Why the upstream player feels faster

The two clients solve a different problem, and most of the perceived difference
comes from three decisions rather than from better code.

### 1.1 Different transport

| | stremio-web | stremio-offline |
| --- | --- | --- |
| Playback source | `@stremio/stremio-video` picks an implementation per stream: `HTMLVideo` against the streaming server (plain HTTP with byte ranges), `HlsVideo` only when the browser cannot take the file | always our own server: direct play for MP4/WebM with playable codecs, otherwise an FFmpeg HLS session |
| Seek | `video.currentTime = t` — the browser issues an HTTP range request | inside the produced playlist: native; outside it: HTTP call to the server, FFmpeg is killed and respawned with a new `-ss` |
| Track switching | handled inside one session | FFmpeg restart |

The upstream client rarely pays for a seek because the streaming server hands it
a file the browser can seek in. Our server converts, so every seek outside the
produced range costs a process restart. That gap cannot be closed by the UI
alone, but most of the *felt* latency can be: today a single arrow key press
already commits a restart.

### 1.2 The UI never waits for the transport

`useVideo.js` dispatches `setProp` and returns immediately; state arrives back
through `propChanged` events. Our `seekTo()`
([Player.tsx:435](web/src/Player.tsx:435)) `await`s a REST round trip that
internally contains an FFmpeg spawn plus the wait for the first segment
([playback.ts:600](server/src/playback.ts:600), up to 40 s). Any UI element bound
to that promise is blocked for as long as the conversion takes.

### 1.3 Seeks are debounced and previewed

`useKeyboardSeek.ts` is the single most valuable thing to copy:

* a key press only moves a *preview* target and marks `seeking`;
* the real seek is committed by a 300 ms debounce, so a burst of presses
  produces **one** commit;
* holding a key accelerates the step by 1.05× per repeat, capped at 10 % of the
  duration, so crossing an episode takes a few presses instead of dozens;
* the preview target is cleared 1500 ms after the last commit, so the timeline
  never snaps back mid-gesture.

Our arrow keys call `seekTo()` directly ([Player.tsx:736](web/src/Player.tsx:736)).
Five presses can mean up to five FFmpeg restarts; the client-side
`pendingSeekRef` loop coalesces only the ones that arrive while a restart is
already in flight.

## 2. Proposed work

Priorities: **P0** (section 0.2) blocks everything else, **P1** is the
perceived-speed work, **P2** is feature parity that users notice, **P3** is
structural.

---

### P1-A — Debounced, optimistic seeking (client)

**New module** `web/src/player-seek.ts`, pure and unit-tested like
`player-hls.ts`:

```ts
export const SEEK_COMMIT_MS = 300;      // debounce before the request goes out
export const SEEK_PREVIEW_MS = 1500;    // how long the preview target survives
export const HOLD_ACCELERATION = 1.05;  // per repeat while a key is held
export const MAX_HOLD_FRACTION = 0.1;   // cap of one step, of the duration

export function nextHoldStep(current: number | null, offset: number, duration: number): number | null;
export function clampTarget(target: number, duration: number): number;
```

`nextHoldStep` returns `null` when the direction flips (upstream ignores the
press instead of reversing an accelerated run).

**Player integration** (`web/src/Player.tsx`):

1. Add `seekTargetRef` / `seekTarget` state. Arrow keys, the −10/+10 buttons and
   `TimelineBar` scrubbing write into it and call `revealControls()`.
2. Render `seekTarget ?? scrub ?? time` in the timeline and the time label, so
   the position moves at input speed regardless of the transport.
3. Commit through a debounce; a commit calls the existing `seekTo()`.
4. `cancel()` on unload, source change and `escalate`; `flush()` on
   `pointerup`/`keyup` so a deliberate release is not delayed by the full 300 ms.
5. Keep the buffering spinner suppressed while a preview target is pending —
   upstream shows the target instead of a spinner, which reads as instant.

**Tests** (`web/src/player-seek.test.ts`): step acceleration, cap, direction
flip, clamping against `duration`, and that N presses inside the debounce window
produce one commit.

**Expected effect:** holding ← for two seconds turns from "up to ~10 FFmpeg
restarts" into one, and the timeline responds within a frame.

---

### P1-B — Reuse already produced output instead of restarting

The HLS playlist is `EVENT` with `-hls_list_size 0`
([playback.ts:718](server/src/playback.ts:718)), so **every segment a generation
ever produced is still on disk** until the generation is purged. Two
consequences we do not exploit:

1. **Backward seeks inside the current generation already work natively** —
   `planSeek` returns `native` for anything `>= 0` relative and inside the
   playlist, which is correct. Verify with a test that a seek from 30:00 back to
   02:00 in a session started at 00:00 does *not* hit the server.
2. **Backward seeks into a retired generation currently restart.** After a seek
   to 40:00, seeking back to 05:00 respawns FFmpeg even though the old
   generation still has that range on disk for `RETIRED_MS`.

**Change (server):** track per generation the range it produced
(`{ generation, directory, from, until, playlistEnd }`) and keep a bounded list
of them (say the last three) instead of a single `retired` slot. In
`PlaybackManager.seek()`, before restarting, look for a generation whose
`[from, playlistEnd]` covers the target; if one exists, return a descriptor
pointing at that generation's `master.m3u8` with its `offset` and no FFmpeg work
at all. Extend that generation's lifetime while it is the active one.

The client already handles a descriptor with a different `offset` and URL
(`applySession`, [Player.tsx:363](web/src/Player.tsx:363)), so this is a
server-side change plus one client guard: do not tear down the running
generation when the server hands back an older one that is still being written.

**Cost:** disk. Bound it by purging generations beyond the newest three, or
beyond a total segment budget.

---

### P1-C — Cut the restart's time to first frame

* `-hls_init_time 1` (FFmpeg hls muxer) makes the *first* segment one second
  instead of two, so `hlsCanStart` succeeds roughly twice as early. Verify the
  flag against the FFmpeg build in the image before shipping; keep `hls_time` at
  2 for the rest.
* Make the encoder preset for the **first** restart configurable and default to
  something faster than `veryfast` for transcode sessions
  ([playback.ts:702](server/src/playback.ts:702)); the first two seconds decide
  the felt latency, the steady state can be slower.
* **Abort a superseded spawn.** `SerialOperations` serialises restarts, but a
  queued restart still waits for the previous `run()` to finish its up-to-40 s
  polling loop ([playback.ts:600](server/src/playback.ts:600)). Give the session
  a `restartToken`; when a newer restart is enqueued, bump the token, and let the
  polling loop bail out and `SIGKILL` its child as soon as its token is stale.
  With P1-A this is rare, but it removes the worst case entirely.
* Log the time from request to first segment per restart so the effect is
  measurable in `/api/stats` and in the diagnostics log.

---

### P2-A — Next episode and binge watching

Upstream: `NextVideoPopup` opens when `duration - time <=
settings.nextVideoNotificationDuration`, is dismissible, and on `ended`
navigates to the next episode when `bingeWatching` is on
(`src/routes/Player/Player.js`).

Ours ends playback and closes. Add:

* a `nextVideo` prop on the player, filled by `App.tsx` from the selected
  series' episode list (the data is already there — `selected.videos`);
* a popup in the last N seconds (setting, default 30, 0 = off) with a countdown
  and "Play now" / "Dismiss";
* on `ended`: autoplay the next episode when the setting is on, otherwise close;
* progress bookkeeping for the finished episode before switching.

### P2-B — Media Session API

`useMediaSession.ts` sets `navigator.mediaSession.metadata`, `playbackState` and
action handlers. Cheap, and it makes hardware keys, the macOS Now Playing panel
and phone lock screens work. Reuse the poster we already pass as
`progressPoster`.

### P2-C — Player controls we are missing

| Feature | Upstream | Notes for us |
| --- | --- | --- |
| Playback speed | `SpeedMenu` | `video.playbackRate`; works in every mode, including HLS |
| Video scale | `contain` / `cover` / `fill` cycling | pure CSS `object-fit` on the `<video>` |
| Subtitle delay / size / position | `subtitleDelay.ts`, `useSubtitles.ts` | delay matters most for addon subtitles; applies to our VTT cues |
| Statistics overlay | `StatisticsMenu` | we have a Stats *page*; an in-player overlay with mode, hardware flag, buffer length, dropped frames and restart count would shorten every playback bug report |
| Volume | 0–200 % with a boost indicator | ours is a plain 0–100 range that is not persisted; persist it and remember mute |
| Immersion | 3 s debounce, cancelled over the control bar, cleared on mouse leave | ours reveals on any pointer event; adopt the "control bar prevents immersion" rule |
| Click / double click | click toggles play through a 200 ms debounce so a double click only toggles fullscreen | we have no click-to-pause at all |
| Seek durations | `seekTimeDuration` and `seekShortTimeDuration`, Shift picks the short one | ours is hardcoded to 10 s |

### P2-D — Non-fatal errors

Upstream splits `error.critical`: critical replaces the player, everything else
becomes a toast (`src/routes/Player/Player.js`).
Our `setError` is terminal for the session. Classify: source/permission and
"conversion could not start" stay fatal; a recovered decode error, a subtitle
that failed to load, or a track switch that failed should be a toast over
continuing playback.

---

### P3 — A transport facade

Upstream's real structural advantage is that `Player.js` talks to a `Video`
object with `props` and events, never to `hls.js`. Ours mixes UI state,
`hls.js` wiring, session lifecycle and error recovery in one 843-line component,
which is why the HLS refs (`seekEpochRef`, `seekInFlightRef`,
`pendingSeekRef`, `abandonedRef`, …) leak into rendering code.

Proposal, only after P1: extract `web/src/player/transport.ts` exposing

```ts
interface Transport {
  load(session: PlaybackSession, opts: { autoplay: boolean }): void;
  setTime(time: number): void;      // fire and forget
  setPaused(paused: boolean): void;
  destroy(): void;
  on(event: 'time' | 'buffering' | 'error' | 'ended' | 'session', cb): void;
}
```

with two implementations (`DirectTransport`, `HlsTransport`) behind one
interface. `Player.tsx` then holds view state only, and the seek state machine
from P1-A becomes testable without a DOM `<video>`.

---

## 3. What is deliberately *not* adopted

* **`stremio-core-web` / WASM core** — upstream keeps library, addons and player
  state in a Rust core. We have an Express server for that; adopting it would
  mean giving up the offline/download model.
* **Chromecast, Discord presence, gamepad, shell integration** — no audience in
  a self-hosted browser client.
* **`@stremio/stremio-video`** as a dependency — it is built around the Stremio
  streaming server's endpoints (`/hlsv2`, `/probe`) and its own settings model;
  the useful parts are behavioural, not code we can import.
* **Spatial navigation polyfill** — only worth it if TV-browser support becomes
  a goal.

## 4. Suggested order

0. P0 — opaque handles, before anything that touches playback descriptors
1. P1-A (client only, no server risk, biggest felt win)
2. P1-C (small, measurable)
3. P1-B (real work, removes the last common restart)
4. P2-A, P2-B, P2-C in that order
5. P2-D alongside whichever of the above touches error handling
6. P3 once the seek state machine is settled

Each step keeps `npm test` green and is verifiable through the existing
Playwright journeys; P1-B needs a new e2e case that seeks forward and then back
and asserts no second FFmpeg start in the log.
