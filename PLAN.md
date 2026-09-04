# Plan

A living backlog. Not a sprint commitment. Update this file when something ships or when a new pain shows up in daily use.

Target platform remains a Synology NAS with an Intel Celeron (QuickSync on DS220+/DS920+). Direct play and remux are the common path; real transcode needs VAAPI. See README for the hardware setup.

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
- Mobile player scrubber: press anywhere on the bar, including the unplayed part, and drag the current position forward or back without first jumping to the press point.

Debrid stays per addon. The app plays and downloads resolved HTTPS URLs. There is no built-in Real-Debrid client and there should not be one unless a stream arrives as a raw `infoHash`.

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

- Detect a dead source mid-transfer and fail the job with a retry instead of hanging.
- Stop cleanly when the disk is full; surface the error in the queue and in diagnostics.
- Optional later: night-only window, speed limit, notify when the queue drains, delete watched files.

### Torrents

Addons that return only an `infoHash` are unusable today. Either resolve them (only if a debrid addon already did the work) or hide/disable raw torrent streams so they do not look playable.

Do not add a local torrent engine on the NAS unless that becomes an explicit product decision.

## Later

### Library and discovery

- **Follow show**: daily check for new episodes, enqueue as lazy jobs. The lazy-job plumbing exists; the watch list and scheduler do not.
- Search: live input (~400 ms debounce), recent queries, suggestions from already loaded catalogs, optional rank-by-title-match.

### Access and multi-instance

- Rate-limit outbound calls to foreign addon/API hosts.
- Profiles: addons, settings, history and favorites per profile; user management; lockable profiles; kids profiles that honour age metadata when the catalog provides it.
- Configurable LAN IP/host for the running container. The web client should try that address first so playback on the home network does not hairpin through Cloudflare Tunnel. Fail closed: never treat an unauthenticated LAN probe as an open door.
- Remote client mode: another instance (Docker or native) can use this one as the download/playback server, including an instance published behind a Cloudflare Tunnel with explicit auth.

Do not expose the app directly to the internet. HTTPS reverse proxy or a VPN remains the rule; the cookie is only `Secure` when the server sees HTTPS.

### Packaging

- GHCR image already exists (`ghcr.io/nickrabit/streamio-offline`). Tag a `v0.x` when the current `main` feels like a snapshot worth pinning.
- One-compose install path for people who will not read the Synology chapter.
- English README, MIT license, and GitHub community files (contributing, security, code of conduct, issue and pull request templates).

### Tests

Server tests exist. `web` has none. Stream sorting/filtering was checked by hand against real addon payloads.

## Out of scope unless revisited

- Built-in debrid account settings. Configure that in the addon manifest URL.
- Building the image on every push. Revisit after features land through pull requests instead of bursts on `main`.
