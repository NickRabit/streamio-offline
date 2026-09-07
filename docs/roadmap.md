# Roadmap

A living backlog, not a sprint commitment. Update this file when something ships
or when a new pain shows up in daily use.

The target platform remains a Synology NAS with an Intel Celeron (QuickSync on a
DS220+ or DS920+). Direct play and remux are the common path; a real transcode
needs VAAPI. See [Hardware acceleration](hardware-acceleration.md) for the setup.

## Done

These used to be open notes. They are in `main` now.

- Local library: browse and play downloaded files from disk.
- Continue watching and My list, including cleanup when a title is deleted from the library.
- Image workflow is manual (`workflow_dispatch`) plus version tags. It does not build on every commit. Building on merge to `main` can wait until the branch workflow settles.
- Settings export/import, including installed addons and their save rules. Tokens in addon URLs mean the file is a secret.
- Subtitle cue background no longer fights the player chrome when the timeline shows or hides.
- Fullscreen keeps HTML subtitles visible on Windows Chrome/Brave (the video is no longer promoted over the cue layer).
- Hide/show subtitles from the player icon or `c`/`t` without restarting FFmpeg.
- Clicking the current sidebar section resets it (filters, path, scroll). Clicking it from another section restores the last filters and position.
- Jump from a finished download job to the file in the library.
- Mobile item / stream / play / download flow (catalog detail, landscape, control sizing).
- Save to the current device from the stream picker, the player, and the library, always through the server proxy.
- Diagnostics panel: levels, rotation, retention, redaction, client playback errors, grouped issues.
- Per-host guard on outbound addon calls: concurrency cap, queue, and a circuit breaker.
- English documentation, MIT license, and the GitHub community files (contributing, security, code of conduct, issue and pull request templates).
- GHCR image plus manual and tag-driven build workflows (`ghcr.io/nickrabit/streamio-offline`).
- Download queue: classify failures (network vs source vs disk), Range resume after a clean drop, halt the queue on ENOSPC and resume when space returns.
- Mobile player scrubber: press anywhere on the bar, including the unplayed part, and drag the current position forward or back without first jumping to the press point.

Shipped debrid path: addons that already return HTTPS (Torrentio configured
with Real-Debrid, and similar) play and download as any other HTTP stream.
There is still no built-in Real-Debrid client; a raw `infoHash` is unusable.

## Next (daily friction)

### Player and mobile chrome

- iPhone landscape: the left menu sits under the notch. It needs a safe-area layout, not just smaller buttons.
- Catalog actions **To library** / **To device** are clipped at the bottom of the sheet.
- Download queue page is still broken on a phone. Treat it as its own layout pass.

### Stats

Stats currently follow finished library downloads and ignore catalog playback. Local library playback is LAN traffic and should not be mixed into the same counter.

Pick one:

- stop counting playback at all, or
- split the page into **Downloads** vs **Playback** (catalog / remote vs library / local).

Do not keep a single number that pretends to be watch time.

### Queue robustness

- Optional later: night-only window, speed limit, notify when the queue drains, delete watched files. In-app notify (toast + Stahování badge) is shared with the debrid waiting state below; push out of the browser is later.

### Torrents and Real-Debrid

The app does not download torrents. It never runs a torrent engine on the NAS.
A source is either HTTP(S) already, or it is a magnet/`infoHash` that Real-Debrid
must fetch on its servers first. After that, the existing HTTP pipeline
(proxy, Range resume, FFmpeg, library) takes over.

**Today.** Cached `[RD+]` streams from a debrid-configured addon already have a
URL and work. Uncached `[RD download]` streams often have a Torrentio resolve
URL too, but the first request hangs until Real-Debrid finishes — the proxy
can kill that. A raw `infoHash` with no URL shows up as **EXT**, looks
pickable, and is not. Hide or separate those, and if every source is a torrent
say so and point at Settings.

**Planned client.** One Real-Debrid API token in **Settings**, verified with
`GET /user`, stored and backed up as a secret — the same rule as tokens in
addon URLs. Do not scrape the token out of a Torrentio manifest. Day one is
Real-Debrid only.

The download queue is the source of truth. **To library** on an `infoHash`
creates a job in a new waiting state (`čeká na debrid`): `addMagnet` →
`selectFiles` → poll `torrents/info` until `downloaded` → `unrestrict` → the
job becomes a normal HTTP download. Waiting jobs must not occupy an HTTP
concurrency slot; they only poll. Dedupe by `infoHash` + `fileIdx`. Map RD
errors in the job (`509` slots full → retry, `503` infringing → fail, premium
required → fail). When RD reports downloaded, the app starts the HTTP
transfer itself — no second click.

**Play** only when an HTTPS URL exists *now*. Cached: unrestrict and play
through the proxy, same as today. Uncached: do not open the player; the
action is **To library**. After RD has the file, play-from-RD is allowed
without waiting for the NAS copy. Once the file is in the library, play that.
The player itself does not change.

**Notify.** In-app first: toast plus the Stahování badge, two events that
must not be collapsed — “ready on Real-Debrid” (HTTP download starting) and
“in the library” (the offline copy). Web Push / ntfy / Telegram wait until
that is boring.

Follow-show can later enqueue torrent sources the same way. Not in this slice.

## Later

### Library and discovery

- **Follow show**: daily check for new episodes, enqueue as lazy jobs. The lazy-job plumbing exists; the watch list and scheduler do not.
- Search: live input (~400 ms debounce), recent queries, suggestions from already loaded catalogs, optional rank-by-title-match.

### Access and multi-instance

- Profiles: addons, settings, history and favorites per profile; user management; lockable profiles; kids profiles that honour age metadata when the catalog provides it.
- Configurable LAN IP/host for the running container. The web client should try that address first so playback on the home network does not hairpin through Cloudflare Tunnel. Fail closed: never treat an unauthenticated LAN probe as an open door.
- Remote client mode: another instance (Docker or native) can use this one as the download/playback server, including an instance published behind a Cloudflare Tunnel with explicit auth.

Do not expose the app directly to the internet. HTTPS reverse proxy or a VPN remains the rule; the cookie is only `Secure` when the server sees HTTPS.

### Packaging

- One-compose install path for people who will not read the Synology chapter.

### Tests

Stream sorting and filtering is still checked by hand against real addon
payloads. See [testing.md](testing.md) for the layers that do exist.

## Out of scope unless revisited

- A local torrent engine on the NAS.
- Playing an uncached torrent in the player while Real-Debrid is still leeching.
- AllDebrid, Premiumize, or a second debrid provider before Real-Debrid is in daily use.
- Parsing the API token out of a Torrentio (or other addon) manifest URL.
- Building the image on every push. Revisit after features land through pull requests instead of bursts on `main`.
