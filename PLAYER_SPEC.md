# Proxy-safe playback and player improvements

Status: proposed technical specification; no runtime changes implemented.
Reviewed on 2026-09-06. This document revises the proposals in
[PR #29](https://github.com/NickRabit/streamio-offline/pull/29), including its
binding proxy requirement. It is intended to replace that PR's specification,
not to become a second, conflicting implementation plan.

## 1. Evidence and scope

The comparison is based on source inspection, not a playback benchmark:

| Source | Revision | Relevant implementation |
| --- | --- | --- |
| stremio-offline | `fa85b8ae13cd64448c4e58b3b5b3278dd494df2c`, v0.3.12 | `web/src/Player.tsx`, `player-hls.ts`, `capabilities.ts`, `api.ts`; `server/src/playback.ts`, `probe.ts`, `index.ts`, `security.ts`, `downloads.ts`, `auth.ts` |
| Local stremio-web checkout | `07553095e1c2f46f677e4ad341faa1dcb90fa760`, v5.0.0-beta.39 | `src/routes/Player/useKeyboardSeek.ts`, `useVideo.js`, `Player.js`, `useMediaSession.ts`, `subtitleDelay.ts`, `ControlBar/SeekBar/SeekBar.js` |
| Existing proposal | PR #29, `d0af368` | `PLAYER_SPEC.md` |

Pinned upstream references:
[keyboard seeking](https://github.com/Stremio/stremio-web/blob/07553095e1c2f46f677e4ad341faa1dcb90fa760/src/routes/Player/useKeyboardSeek.ts),
[video adapter](https://github.com/Stremio/stremio-web/blob/07553095e1c2f46f677e4ad341faa1dcb90fa760/src/routes/Player/useVideo.js),
[player interaction and next episode](https://github.com/Stremio/stremio-web/blob/07553095e1c2f46f677e4ad341faa1dcb90fa760/src/routes/Player/Player.js),
[Media Session](https://github.com/Stremio/stremio-web/blob/07553095e1c2f46f677e4ad341faa1dcb90fa760/src/routes/Player/useMediaSession.ts),
[subtitle delay](https://github.com/Stremio/stremio-web/blob/07553095e1c2f46f677e4ad341faa1dcb90fa760/src/routes/Player/subtitleDelay.ts).

Upstream delegates playback to `@stremio/stremio-video` 0.0.96. The inspected
wrapper does not prove which transport a particular upstream playback uses,
how often it transcodes, or that its streaming server seeks faster. Record the
actual implementation in any benchmark. A synchronous dispatch also does not
prove lower media latency; awaiting a promise does not block the JavaScript
thread. Our player already previews time with `showTime(bounded)` before waiting.

### Confirmed opportunities and existing strengths

| Area | Observed behavior | Implication |
| --- | --- | --- |
| Initial playback | `start()` awaits `inspect()` before choosing a mode; probing can take a 20 s fast pass and a 45 s deep pass | Measure probing separately from conversion and browser startup |
| Existing probe reuse | `App.tsx` inspects the selected source; `PlaybackManager.inspect()` caches for 10 minutes and shares in-flight work by URL | Preserve this; simply adding a cache or an eager inspection is not new work |
| Direct playback | Compatible MP4/WebM uses our HTTP proxy; local files use the library route; embedded subtitles can use a sidecar | Preserve this fast path and its decode-error escalation |
| HLS seeking | `planSeek()` uses native seeking within the produced interval, waits up to 8 s when at most 20 s ahead, otherwise restarts | Repeated keys do not necessarily cause a restart each; distinguish native, wait and restart outcomes |
| Seek concurrency | Client retains the latest pending target while a request is active; server serializes operations | Improve supersession without removing existing race protection |
| Keyboard UX | Upstream has an accumulated preview target, hold acceleration and release/flush behavior | Adapt its interaction model; do not copy timing behavior without gesture tests |
| HLS startup | Server already waits for one usable segment; debug logs already include segment-ready timing | Extend observability rather than claim these mechanisms are absent |
| Resource control | MSE buffer limits, upstream abort on client disconnect, hardware fallback and bounded decode recovery already exist | Keep these invariants during optimization |

## 2. P0: mandatory proxy boundary

**Clients must never receive original Real-Debrid media URLs, source authorization
headers or provider credentials. Every provider media request must originate
from the server, including direct play, probing, downloads, subtitles, HLS keys
and segments. No error or fallback may redirect a client to the provider.**

Here, `direct` means no FFmpeg conversion, not browser-to-provider access.
This requirement applies to mobile browsers and any future external player or
casting receiver. A proxy does not itself guarantee protection from provider
account restrictions: operations must also use the intended stable server egress,
including IPv4/IPv6 and any VPN configuration. This is an architectural
constraint, not a claim about a verified provider ban policy.

### 2.1 Confirmed exposure and audit boundary

| Surface | Current state | Required change |
| --- | --- | --- |
| `/api/streams/:type/:id` | Returns addon stream objects, including `url`, nested subtitles and `behaviorHints.proxyHeaders` | Explicit public DTO with opaque source IDs |
| Direct descriptor / `/api/proxy` | `proxyPath()` includes URL-encoded source and base64url headers | Same-origin opaque resource route; encoding is not secrecy |
| Proxied HLS | Rewrites segment lines and `URI` attributes into raw `?url=` proxy addresses | Rewrite the complete supported playlist resource graph to opaque resources |
| `/api/subtitles` and `/api/subtitle` | Subtitle list contains upstream addresses; browser sends `?url=` | Subtitle IDs and server-side resolution |
| External-source UI | `App.tsx` renders `externalUrl` as a browser link | No provider links or client-side fallback; unsupported protected streams show a reason |
| Library playback | `file://` source becomes `/api/library/file?path=` | Opaque library item IDs; local path exposure is distinct from an RD credential leak |
| Device download | Returned download URL already uses a random ticket, but preparation accepts a raw stream | Reuse the ticket pattern; change preparation input and add owner binding |
| Download list | `publicJob()` already removes `stream` and `source` | Preserve this; audit error strings, titles and all other public fields |

Audit metadata, addon manifests, stream labels, artwork, progress, diagnostics,
stats, logs, subtitle text and settings/addon exports as additional response
surfaces. Do not claim each currently leaks a media URL without a reproducer.
The logger already redacts ordinary HTTP URLs and sensitive keys, but that is
not a guarantee for relative, percent-encoded or base64-encoded payloads.
Generic error handlers must never return raw upstream exceptions or FFmpeg args.

Public serializers must allowlist fields and sanitize provider-controlled text,
including nested URLs and credential-bearing strings. Drop unknown fields.
Structured normalization is the primary defense; regex redaction is a secondary
defense. Security fixtures must cover credentials inserted into otherwise
allowed labels. Credential-bearing addon configuration must remain server-side:
review settings exports and show a redacted configuration summary instead of
returning stored provider secrets. Initial user-supplied configuration is input,
not permission to echo its credentials back later.

### 2.2 Proposed API and resource ownership

Prefer random 256-bit IDs referencing a bounded server-side resource registry
for the first implementation. The existing device-download ticket map is a
useful starting pattern. Unlike the sealed-token proposal in PR #29, this makes
revocation, ownership and resource scope explicit and keeps URLs short.

```ts
interface PublicStream {
  sourceId: string;
  kind: "remote" | "library" | "unsupported";
  playable: boolean;
  name?: string;
  title?: string;
  addonKey?: string;
  size?: number;
  languages?: string[];
  subtitles: Array<{ subtitleId: string; lang?: string; label?: string }>;
}
```

Internal records contain the normalized URL/path, permitted request headers,
source identity, owner auth `sid`, scope, expiry, addon attribution and revision.
They never become public DTOs. Update `web/src/types.ts`, `server/src/types.ts`,
stream filtering/ranking, library resume and download actions together.

| Operation | Proposed client contract |
| --- | --- |
| Inspect | `POST /api/inspect { sourceId }` |
| Start | `POST /api/playback { sourceId, capabilities, time, requestId }` |
| Save to library / device | Existing POST routes accept `sourceId` or `libraryItemId`, never a raw stream |
| Subtitle | `GET /api/subtitle/:subtitleId?offset=...` |
| Remote bytes / nested HLS resource | `GET /api/media/:resourceId` with normal session authentication |
| Local file | `GET /api/library/file/:libraryItemId` with authorization and containment checks |
| Converted playback | Existing opaque playback/generation routes, with explicit owner checks |

Reject old public `url`, `headers`, `stream`, and arbitrary `path` input shapes
after coordinated server/client deployment; never silently keep the unsafe API
for compatibility. Administrative file-management APIs need their own
containment checks and ID migration; renaming the playback route alone does not
hide paths throughout the application.

Resource lifecycle:

1. Unclaimed source IDs expire after 30 minutes. Bound inactive entries by count
   and estimated bytes, deduplicate within an owner/source revision, and rate-limit
   creation. Initial limits: 2,000 entries and 16 MiB per server; tune from metrics.
2. Playback claims a source into its session. Renew media access through the
   authorized active playback lifecycle, so a long movie does not stop because
   its stream-list ID expired. No renewal past authentication expiry/revocation.
3. Each resource has a scope: source selection, playback media, subtitle,
   library or device download. A segment ID cannot be used to create a download
   job or resolve an unrelated URL. Child resources inherit the owner and parent
   lifecycle. Deduplicate playlist children; budget overflow fails safely.
4. Check owner, scope and current authorization on every access, including HLS
   init, segment, key and sidecar routes. Unknown or foreign IDs return 404;
   known expired IDs return 410; unauthenticated requests return 401.
5. Logout revokes access and stops owned playback work. Saved server download
   jobs retain their internal source independently of browser handle expiry.
   Device tickets remain bounded and expire after the existing 24-hour maximum.
6. In-memory handles and playback sessions do not survive a server restart.
   Return a structured expiration code; client re-fetches sources and recovers
   once at saved absolute time with tracks/preferences where still available.
   Existing missing-session recovery does not already implement handle renewal.
   Require reselection if the same source cannot be identified safely.

If persistent sealed tokens are later needed, specify authenticated encryption
with a version, key ID, unique nonce, authentication tag, owner, purpose and
expiry, plus key rotation and revocation. Persistent tokens alone do not preserve
FFmpeg processes or generated playlists; current `PlaybackManager.load()` clears
its playback directory. Do not introduce custom cryptography just for caching.

### 2.3 Proxy transport requirements

- Remove raw public proxy URL resolution. Prefer an internal registry ID for
  FFmpeg too; narrow internal authorization to required media routes. A valid
  login cookie or spoofed forwarded header must not grant internal privileges.
  Never include `INTERNAL_TOKEN` in browser-visible URLs or diagnostics.
- Resolve redirects on the server, validate every target and enforce the
  configured outbound policy. Preserve the current redirect count limit; cancel
  intermediate bodies. Do not forward client cookies, Authorization or
  `X-Forwarded-For` to the provider. Provider headers come only from the record;
  strip sensitive headers across origins unless explicitly approved for that
  source's redirect/CDN relationship.
- Parse and rewrite supported HLS master/media playlists, variants, audio,
  subtitles, initialization maps, keys and URI-bearing extensions. Resolve
  relative links against the final upstream URL. Remove nonessential upstream
  metadata; reject unsupported URI-bearing constructs or protocols rather than
  returning them unchanged. DASH needs its own manifest rewriter before support.
- Preserve byte-range behavior (200, 206, 416, `Content-Range`, `Accept-Ranges`,
  correct length and HEAD semantics). Never buffer a whole movie in memory.
  Preserve backpressure and cancellation on seek, stop and disconnected clients.
- Allowlist response headers. Never relay upstream `Location`, `Set-Cookie`,
  `Link`, authentication challenges or diagnostic bodies. Use sanitized errors.
  Use `private, no-store` for sensitive DTOs/manifests/keys; authenticated media
  caches must never be shared publicly. Review the current `public` segment cache
  headers; allow private segment caching only with deliberate revocation behavior.
- Validate destination DNS/address policy at connection time, not solely before
  a separate DNS lookup by fetch. Keep explicit private-addon allowances scoped;
  handles do not remove SSRF risk from malicious addon responses.
- Test one stable provider-facing egress for probe, playback and downloads.
  Add shared per-provider media admission control if measurements show contention;
  the current short-request addon guard intentionally excludes media transfers.
  Do not solve startup latency by unlimited parallel ranges or probing all sources.

### 2.4 Release gate: no-leak tests

Use an isolated fake addon/provider with unique host, URL path, query secret and
header secret canaries. No real RD credentials or account traffic is needed.

1. Capture browser request URLs, response bodies/headers, console, DOM, storage,
   and worker traffic for source selection, playback, seek, recovery, subtitles,
   downloads, diagnostics and exports. Assert no source address or credential
   appears in plaintext, percent encoding or base64/base64url. Inject secrets
   into nested metadata as well as the normal URL/header fields.
2. Assert the browser/receiver makes zero provider-origin requests, including
   redirects, artwork/metadata injection and failure fallbacks. Assert the fake
   provider only observes the server's configured network egress.
3. Exercise nested HLS variants, alternate audio, subtitles, encryption keys,
   init maps, redirects and unsupported URI constructs. Every supported resource
   must resolve through an owned opaque route; unsupported cases fail closed.
4. Exercise forged/foreign/expired IDs, logout, server restart and cross-scope
   reuse; old raw routes and forged internal access must fail.
5. Verify seek/range correctness, disconnect abort and slow-consumer memory use.
   Test errors at every upstream stage without exposing canaries in public logs.

## 3. Measure before claiming faster playback

Add a safe correlation ID and structured stage timings: source selection,
probe cache hit/miss and fast/deep duration, mode choice, spawn, first finalized
segment, descriptor response, manifest/init load and first rendered frame.
Measure frame presentation with `requestVideoFrameCallback` where available;
use a documented weaker fallback elsewhere. `playing` alone is not proof of a
rendered frame. Measure seek input-to-preview, commit-to-frame, absolute target
error, stalls, restart count, canceled work, CPU, memory, disk and provider bytes.

Run at least 20 trials per scenario with cold and warm caches separately. Use
the same legal test media, network path and device: MP4/H.264/AAC, compatible
WebM, MKV copy/remux, HEVC Main10, incompatible audio, software and available
hardware transcode, local library and remote proxy. Cover desktop Chromium,
Firefox, macOS Safari and a real iPhone/iPad; mark unavailable hardware untested.
Test first play, resume far into the file, a two-second key hold, five taps,
forward seek, backward seek and track/quality change. Report median and p95.

Compare upstream only with synthetic/non-secret sources. Record its actual
transport and backend. An upstream browser fetching RD directly is forbidden
even as a benchmark, and results using different transport paths must be labeled.

Proposed acceptance budgets, to be confirmed on baseline hardware: preview p95
under 50 ms, one commit for a continuous key hold, no FFmpeg start for a covered
native seek, and at least 20% lower p95 in the stage targeted by a performance
change without more than 10% regression in other playback modes. These are
targets, not measured results or universal latency promises.

## 4. P1: perceived speed and startup

### P1-A: gesture-aware seeking

Extract a tested seek controller with states `idle`, `previewing`, `committing`,
`waiting-for-media`, `failed`. Keep absolute desired time separate from confirmed
media time and generation-relative time. All user seek inputs use it.

- Arrow hold accumulates a preview; commit once on release. A 300 ms inactivity
  debounce handles discrete button/tap bursts and missing-release recovery.
  Do not flush on every discrete keyup while claiming five taps always coalesce;
  specify and test hold and tap semantics separately. Blur/unmount cancels holds.
- Pointer scrubbing previews during drag and commits on pointerup. A click or
  accessibility absolute seek commits once. Native direct seeking need not pay
  the remote-restart debounce after a completed gesture.
- Optional hold acceleration starts at the configured step, grows by 1.05 per
  repeat and caps at 10% of known duration. A direction change resets acceleration
  and moves in the new direction; this deliberately differs from upstream's
  ignored reverse press. Handle unknown duration and non-finite input explicitly.
- Retain the desired target until the corresponding media frame is reached or
  the operation fails; a fixed 1,500 ms timer must not snap the UI back during a
  slow server seek. Preserve paused state and the last frame; show truthful
  buffering after a short grace interval instead of hiding it indefinitely.
- Cancel obsolete work on source change, close and decode escalation. Ignore
  stale responses by request revision and session identity. Save confirmed
  playback progress, not an uncommitted preview target.

Tests: fake-clock gesture sequences, target clamping, reverse direction, pause,
blur, stale responses and a new target during an existing seek. Preserve native
and ahead-wait behavior from `player-hls.ts` and existing decode-loop tests.

### P1-B: latest request wins, including on the server

Client-side coalescing alone cannot cancel the active server restart: currently
the client waits before sending another one. Add a monotonically increasing
operation revision to seek/track/escalation requests, with a way to submit a
newer desired operation while the older request is pending. The server records
supersession before the serialized work queue, drops obsolete queued operations
and aborts their startup polling/processes. Browser fetch abort alone is not a
server cancellation protocol. Closing a player also cancels probe/start work.

Maintain at most one intended producer per session. Terminate the old process
gracefully, then force-kill after a bounded timeout; await exit before reclaiming
resources. Child callbacks may update only their own generation/revision.
Cancellation is not a conversion failure and must not trigger retries, software
fallback or the VAAPI failure counter. New seeks retain the latest desired
track/quality and `copyRejected` state; they must not undo decode escalation.

Tests: a deliberately stalled spawn superseded by a seek, seek concurrent with
track change, close during probe, late child exit, and a 100-input burst with
bounded processes/directories. Target cancellation acknowledgement below 1 s;
forced process cleanup may use the existing 3 s grace period.

### P1-C: shorten startup based on stage data

Preserve the existing probe cache/in-flight sharing. Key cached results by
internal source identity plus header/credential revision, and local file
size/mtime, rather than URL alone. Cache failures briefly so a transient failure
does not remain authoritative for 10 minutes. Probe only the selected source.
Consider making deep track discovery lazy only when enough trusted information
already exists for a safe playback decision; filename hints alone are insufficient.

Keep compatible media on the same-origin direct path. Measure byte-range/HEAD
handling and tail metadata reads before expanding format support. Do not force
MKV into native playback or weaken iOS AC-3/E-AC-3 restrictions to raise the
direct-play percentage. HLS capability support and native container support are
different questions; retain observed decode-failure escalation.

Treat shorter segments as an experiment. `hls_init_time=1` is a target tied to
playlist initialization and keyframes; it does not guarantee exactly one short
segment or twice-as-fast startup. Validate interaction with our EVENT playlist
and `hls_list_size=0` in the exact Docker FFmpeg build. Copy/remux cannot invent
keyframes, and current transcoding forces keyframes at two-second intervals.
Test matching GOP/first-keyframe settings, actual segment durations, decoder
startup and steady-state stalls together. See the
[FFmpeg HLS muxer documentation](https://ffmpeg.org/ffmpeg-formats.html#hls-2).

`FFMPEG_PRESET` is already configurable. Benchmark `veryfast` against faster
presets on software-only hardware, including bitrate/quality and NAS load.
A process uses its selected preset throughout; switching to a slower steady
state needs a separate architecture and is not part of this change. Keep a
feature switch for measured startup experiments, never for bypassing the proxy.

## 5. P2: reusable HLS output, with continuation semantics

Demote PR #29's retired-generation reuse until the simpler changes are measured.
Current retired output belongs to a stopped producer and is retained briefly
for in-flight requests. Returning its playlist may speed a backward jump but
will eventually reach the end of that partial output. It is not equivalent to
resuming an ongoing full movie.

Prototype generation metadata: immutable ID, source revision, absolute start,
finalized seekable intervals, init/codec identity, audio/subtitle selection,
quality, copy-rejection state, producer state, bytes, expiry and reader leases.
Reuse only a compatible generation with enough playable coverage; never use
copy output after a decode escalation or the wrong audio/quality after a switch.

For a first safe increment, reuse only a compatible generation proven complete
through source EOF. Partial-generation reuse requires explicit continuation:
start a new producer before cached coverage ends, preserve absolute timestamps
and subtitles across the handoff, and never interpret partial `ENDLIST` as the
episode ending. If that handoff is not proven, fall back to a normal restart.
The client must load at `target - generation.offset`, not at playlist zero.

Bound retained output by bytes as well as count (initial experiment: three
retained generations, 512 MiB per session, 2 GiB global, excluding active output).
Use LRU eviction with reader leases; cancel/reschedule cleanup instead of letting
an old purge timer delete a newly selected generation. Active output needs a
separate disk admission/free-space policy; these retention limits do not bound
an entire long EVENT recording. Under pressure, decline reuse safely.

Tests must play beyond the cached interval, not only assert no process start at
the moment of the backward seek. Cover gaps, EOF, expiry, concurrent requests,
disk pressure, wrong track/quality, subtitle offset and stale cleanup timers.

## 6. P2: useful upstream interactions

| Feature | Proposed behavior | Acceptance and limits |
| --- | --- | --- |
| Next episode | Dismissible prompt in last 30 s; opt-in autoplay; use `selected.videos` and season/episode ordering | Save finished progress once; exclude unavailable episodes; prevent double navigation; source selection and resolution stay server-side; no speculative provider downloads |
| Media Session | Metadata, play/pause, seek and next-track through the same controller | Feature-detect each action; clean up handlers on close; use safe artwork; native lock-screen behavior needs real-device checks |
| Playback speed | 0.5–2x selector; restore chosen rate after source attachment | Check A/V sync and buffer behavior; a slow transcode may not sustain 2x |
| Subtitle adjustment | Delay in 100 ms increments, size and position; retain preference | Define positive delay as later display; use `cue time = original time + delay - generation offset`; regenerate from original cues to avoid cumulative shifts; test native iOS and custom rendering |
| Player diagnostics | Mode, codecs, hardware, buffered seconds, dropped frames, stage timings and restarts | Copy a sanitized report; no source URL, token or raw FFmpeg command |
| Controls | Click-to-pause with double-click fullscreen arbitration; persisted volume/mute; configurable seek step; contain/cover | Do not intercept control clicks or editable fields; support keyboard/focus and mobile safe areas; keep native volume 0–100%, defer Web Audio amplification |
| Error UX | Nonfatal subtitle/recovered media errors show a dismissible notification | Track-switch failure is nonfatal only when the old transport still works; current restart may already have killed it. Otherwise offer recovery/source selection |

Outside the player, improve the existing Continue Watching flow with reliable
resume/source recovery, and preserve detail/source selection on navigation.
Expose measured preparation stages (source, inspection, playback) and distinguish
estimated codec/language hints from probed data. These fit our local library and
download workflows; they do not require replacing the application state engine.

## 7. P3: transport separation

After the seek/recovery contract settles, extract direct and HLS transports from
`Player.tsx`. Expose typed load/seek/pause/dispose operations with cancellation,
operation revision and acknowledged events for time, buffering, recoverable/fatal
errors and session changes. Keep absolute time conversion in one place. Avoid a
fire-and-forget facade that hides failures or obsolete requests.

Retain React/Express and hls.js. Upstream WASM/core, shell integrations, gamepad
and casting are outside this iteration because of cost and scope, not because
self-hosted users could never need them. Do not import or copy upstream GPL code
into this MIT project as part of the specification; independently implement the
described behavior. A future dependency adoption needs a separate review.

## 8. Delivery sequence and definition of done

| Increment | Scope | Relative size | Required gate |
| --- | --- | --- | --- |
| 1 | P0 DTOs, registry, ownership, proxy graph and migrations | Large | Complete no-leak suite and direct/HLS/download compatibility |
| 2 | Safe stage instrumentation and baseline | Medium | Reproducible cold/warm report with explicit untested platforms |
| 3 | P1-A seeking UX | Medium | Gesture tests and device checks; no extra native-seek restarts |
| 4 | P1-B cancellation | Large | Supersession/race tests and bounded process/resource use |
| 5 | P1-C selected measured experiments | Medium per experiment | Demonstrated stage improvement without safety or playback regression |
| 6 | Player features from section 6 | Small–medium each | Feature-specific tests, accessibility and proxy assertions |
| 7 | Retained HLS reuse prototype, then P3 | Large each | Continuation/disk proof; stable transport contract |

P0 is a release prerequisite for subsequent playback changes. Instrumentation
may be developed earlier if it is sanitized and does not delay P0. No percentage
speedup should be advertised before measurement. Keep every implementation in a
dedicated PR; patch-bump all workspace versions for shipping changes. Performance
flags may roll back tuning, but must never re-enable raw provider URL exposure.

For each implementation, run appropriate unit/integration tests and Playwright
journeys, build, then perform the repository's Docker deployment checks:

```sh
docker compose up -d --build
docker compose ps
docker compose logs --tail=50 stremio-offline
curl --fail "http://localhost:${STREMIO_OFFLINE_PORT:-8090}/api/status"
```

This specification-only PR does not bump package versions or claim that any
security or performance change is deployed. Its verification is source/contract
review and document checks; the implementation gates above remain outstanding.
