# Stremio Offline

Self-hosted web client for standard [Stremio](https://www.stremio.com/) addons.
It talks to catalog and stream manifests, aggregates streams and subtitles,
plays HTTP sources through a compatible HLS layer, and saves direct streams
into a persistent download queue and a local library.

Unofficial. Not affiliated with Stremio or Smart Code Ltd.

## Quick start

```bash
cp .env.example .env
docker compose up -d --build
```

The UI is at `http://localhost:8090`. Downloaded files land in the host
directory set by `DOWNLOAD_PATH`. On Synology, for example:

```dotenv
DOWNLOAD_PATH=/volume1/video/downloads
DATA_PATH=/volume1/docker/stremio-offline/data
```

A first-run screen creates the only account. There is no default password.

## Addons and Real-Debrid

In **Addons**, paste a full `manifest.json` URL. A catalog manifest supplies
movies, series, and metadata. A source manifest supplies streams or subtitles.
One manifest can do both.

Personalized addon URLs configured for Real-Debrid work. The sensitive part of
the URL is hidden after you save it. If the addon already returns a resolved
HTTPS address, it can be played and downloaded. Resolving a raw `infoHash`
through the Real-Debrid API is not built in.

## Playback

The Docker image includes FFmpeg. The player always picks the cheapest path.
The browser reports which codecs it can handle, and the server decides:

| Source | Mode | NAS load |
| --- | --- | --- |
| MP4/WebM the browser can play | direct play, FFmpeg never starts | none |
| MKV with H.264 or HEVC | remux to fMP4, video and audio copied | negligible |
| AC3, DTS, or TrueHD audio | remux, audio only converted to AAC | low |
| MPEG-4 ASP, VC-1, and similar | real transcode to H.264 | high |

The current mode is shown above the picture; the real source codecs sit next to
the controls.

Quality other than **Original** forces a real transcode, because shrinking the
picture cannot be done by copying. On a NAS without QuickSync, stay on original
quality — the label then reads `PŘEBALENO` (remuxed) and the CPU stays idle.

When playback stalls repeatedly, the player offers a lower quality. A smaller
bitrate helps network drop-outs. The offer appears only when the server has
hardware acceleration; software transcode on a weak CPU would make stalling
worse.

### Seeking

Inside an already converted stretch, seeking is instant. A jump further ahead
restarts conversion from the new position with `-ss`. HTTP Range means nothing
before that point is downloaded; a jump anywhere in a film takes about a
second. Subtitles shift by the same amount. Direct play seeks natively in the
browser. Keys: space play/pause, arrows ±10 s, `f` fullscreen, `c` hide/show
subtitles.

Because remux copies video, playback starts at the nearest keyframe before the
requested time — usually a few seconds off. Emby and Jellyfin do the same.

### Audio tracks and subtitles

The player lists audio tracks and subtitles, including off. Subtitles come from
two places:

- **embedded in the file** — extracted as a WebVTT track from the same FFmpeg
  pass, so the file is not downloaded twice,
- **subtitle addons** (for example OpenSubtitles) — attached in the browser.

Switching a track remaps FFmpeg, so conversion restarts at the current
position, same as a seek. Bitmap subtitles (PGS, VobSub) are not offered;
they cannot be turned into WebVTT.

The subtitle icon in the controls (or `c`) does not change the track: it only
stops drawing the text. Playback and conversion keep going, and turning
subtitles back on is instant, even mid-line. **Off** in the list really drops
the track from the conversion, so that *does* restart it.

**Settings** pick preferred audio and subtitle languages, Czech then English by
default. The player selects a track on start from that list.

The same page can export configuration to JSON and import it later. The backup
holds app settings, installed addon order and state, and their save rules. It
does not hold the account, the library, or watch history. Personalized addon
URLs may contain access tokens — treat the file as a password. Import replaces
the current configuration and re-checks every manifest before saving.

In the source list, language is guessed from the title the addon sent. The
selected source also shows the real languages found by probing the file.

## Deploy on Synology

The container can run as your user, so shared-folder permissions do not have to
be rewritten. The steps work with or without SSH.

### Without SSH, through Container Manager

1. On GitHub, **Code → Download ZIP** from
   `https://github.com/NickRabit/streamio-offline`.
2. In **File Station**, upload the ZIP to `/volume1/docker/` (or similar) and
   extract it (right-click → Extract).
3. In File Station, create a `.env` file in that folder (Create → Text file)
   and put this in it:

```dotenv
DOWNLOAD_PATH=/volume1/video/downloads
DATA_PATH=/volume1/docker/stremio-offline/data
ALLOW_ADDON_HOSTS=192.168.1.205
PUID=1000
PGID=100
```

4. In **Container Manager → Project → Create**, pick that folder and set
   `compose.yml` as the compose source.

   **Container Manager accepts only one compose file**, so the
   `compose.synology.yml` override is ignored there. Hardware acceleration is
   turned on by hand, see [Hardware acceleration](#hardware-acceleration).
5. After the first start, open the container **Terminal** in Container Manager
   and see who owns the folder:

```bash
ls -n /downloads
```

   The first two numbers are uid and gid. Write them into `.env` as `PUID` and
   `PGID` and restart the project. The Container Manager terminal is a full
   substitute for SSH for this.

6. Open `http://NAS:8090`. A fresh install has no account and asks you to
   choose a name and password; until then the server serves nothing else.

### With SSH

```bash
cd /volume1/docker
git clone https://github.com/NickRabit/streamio-offline.git
cd streamio-offline
cp .env.example .env
# set DOWNLOAD_PATH, ALLOW_ADDON_HOSTS, and PUID/PGID from:
stat -c '%u %g' /volume1/video/downloads
docker compose -f compose.yml -f compose.synology.yml up -d --build
```

### When writes fail

The server logs at start if it cannot write to `/downloads`. Three options,
gentlest first:

- **`PUID` and `PGID`** matching the real folder owner. Nothing is rewritten.
- **In File Station**, grant read and write on the folder and apply that to
  subfolders.
- **`FIX_PERMISSIONS=1`** in `.env`. On start, once, it chowns the whole
  download folder. On a large library that takes a while, so it is not the
  default.

### Access from outside

On the home network, the steps above are enough. **Do not publish the app
directly to the internet.** Login exists, but over HTTP the session cookie
travels in the clear. Use DSM's reverse proxy with an HTTPS certificate; once
the server sees `X-Forwarded-Proto: https`, it marks the cookie `Secure` itself.

### Hardware acceleration

On Synology with an Intel iGPU (Celeron with QuickSync, for example DS220+ /
DS920+) the container needs two things: access to `/dev/dri` and membership in
the group that owns the render node. Without that group, the process cannot
open the device after switching to `PUID`/`PGID` and the server silently falls
back to software conversion.

**In Container Manager** (no SSH), uncomment this block in `compose.yml`:

```yaml
    devices:
      - /dev/dri:/dev/dri
```

and add `VAAPI_DEVICE=/dev/dri/renderD128` and `RENDER_GID` to `.env`. The
right GID is in the container **Terminal**:

```bash
ls -n /dev/dri
```

The second number on `renderD128` is the group; on DSM 7 it is usually 937
(`videodriver`). Then stop the project and build it again.

**Over SSH** the override sets both for you:

```bash
docker compose -f compose.yml -f compose.synology.yml up -d --build
```

Override `RENDER_GID` in `.env` if needed; on the NAS, `stat -c "%g" /dev/dri/renderD128`.

The encoder is ready when the log says `VAAPI is available`. At start the
server actually encodes a test frame and separately checks hardware scaling
and bitrate control. Limited Synology drivers can correctly report
`gpuScaling:false` or `bitrateControl:false`; that is not a bug. The app then
decodes and shrinks on CPU, uploads to the GPU, and hardware-encodes in
constant-quality mode. Real GPU work is confirmed by `hardware:true` on the
start, track-change, or seek log line.

For CQP, set `VAAPI_QP=23` in `.env`. Lower means higher quality and more
bitrate. `FFMPEG_CRF` and `FFMPEG_PRESET` apply only to the software fallback.
Hardware conversion always transcodes audio to AAC for a reliable fMP4/HLS
output; a plain remux leaves audio untouched.

`unknown libva error` means the device opens but the driver did not start. See
what is available in the container terminal:

```bash
vainfo --display drm --device /dev/dri/renderD128
```

If libva does not pick a driver, force it in `.env` with `LIBVA_DRIVER_NAME` —
`iHD` for Gemini Lake and newer, `i965` especially for older Braswell. If
VAAPI never comes up, direct play and remux still work and real transcode
falls back to `libx264`.

### When the NAS stalls

Playing a large file can freeze Synology for minutes. Two causes, both
fixable.

**Write burst.** During remux, FFmpeg runs faster than real time so seeking
stays snappy, and it dumps segments into `/data`. At the old 8× rate that was
over 300 MB in twenty seconds; a weaker NAS chokes pushing dirty pages to
disk. The default is therefore `FFMPEG_READRATE_REMUX=3` — seeking stays as
fast, because that is decided by the initial burst, but writes drop to a
third. If that is not enough, set it to `2`. Session segments are cleaned up
when it ends; an idle session stops after five minutes.

**Saturated CPU.** Without acceleration, software transcode takes every core
and DSM stops responding. `compose.yml` has a commented `cpus` limit so you
can leave one core for the system. The lasting fix is QuickSync, see
[Hardware acceleration](#hardware-acceleration). If the log says
`gpuScaling:false`, a slice of the scaling work stays on CPU; that is
expected.

## Download queue

The queue survives a restart, resumes a `.part` file with HTTP Range, and
supports pause, resume, retry, reorder, remove, and 1–8 concurrent downloads.
Removing a finished job from history does not delete the file.

The selected source and the player offer two destinations: **To library**
(`Do knihovny`) adds the file to the server queue, while **To device**
(`Do zařízení`) starts a native download in the current browser. Individual
library files can also be downloaded from their context menu. External streams
always pass through the server proxy: the browser talks only to Stremio
Offline, and the debrid URL is never placed in the download link. Filenames
follow the same rules as library downloads.

**Settings** choose how many files download at once overall and how many from
one source. Providers usually cap concurrent connections and kill or starve
the extras; one transfer per source is the safest default. A dropped
connection is resumed, and once the transfer is moving again the retry budget
is restored.

In **Addons**, each stream addon can set where movies and series are saved.
The host directory is `DOWNLOAD_PATH`; the addon card takes only a relative
subdirectory inside it. An empty subdirectory means `DOWNLOAD_PATH` itself;
nested paths such as `Webshare/Movies` work. Structured mode creates a folder
named after the movie, or show and season folders for a series. Flat mode
writes straight into the chosen subdirectory, for example `Movie.mkv` or
`Show - S01E07 - Episode title.mkv`. The change applies to newly queued items.

On first start the official **Cinemeta** (catalog and metadata) and
**OpenSubtitles v3** (subtitles) addons are installed. They can be disabled or
removed; after a deliberate removal they are not restored on restart.

## Building the image

Building on the NAS is a poor use of time, and Container Manager uses the
classic builder, where an empty `ARG TARGETARCH` silently drops VAAPI drivers.
The image is built elsewhere and the NAS only pulls it.

**Locally**, one command typechecks, runs tests, builds for the chosen
architecture, prints what is in the image, and packs it:

```bash
./scripts/build-image.sh
```

That produces `dist/stremio-offline-amd64-<date>.tar.gz`. Upload it to the NAS
and add it in Container Manager via **Image → Add → Add from file**. `--arch`,
`--tag`, and `--out` change architecture, tag, and output directory.

**On GitHub**, the `Build image` workflow does the same. Run it by hand
(**Actions → Build image → Run workflow**) or by publishing a version. It
runs tests, builds `linux/amd64` and `linux/arm64` separately (the repository
is public, so both architectures get a free native runner — no emulation),
merges them into one list, and pushes to GHCR as
`ghcr.io/nickrabit/streamio-offline:latest` (and under the commit SHA). It then
checks that the amd64 image actually contains VAAPI drivers — otherwise the
job fails. arm64 is not checked; QuickSync does not run there.

The same image works on an **Apple Silicon Mac**: `docker pull` or
`docker compose up` pick the architecture that matches the machine, so an
M1/M2/M3 Mac downloads a ready arm64 image instead of building for eight
minutes under emulation.

The NAS then only pulls. Use `compose.pull.yml` instead of `compose.yml`:

```bash
docker compose -f compose.pull.yml pull
docker compose -f compose.pull.yml up -d
```

One catch: Container Manager downloads an image only when it does not have it
yet. A project that already pulled `:latest` will start the old one again
after a stop/start. Ask for a new image explicitly — delete the local one
under **Image** and start the project, or run `scripts/nas-update.sh`, which
pulls and restarts:

```bash
./scripts/nas-update.sh /volume2/docker/streamio-offline
```

Without SSH, hang it on **Control Panel → Task Scheduler → Create →
User-defined script**, run as `root`. That also works on a schedule.

The GHCR package inherits repository visibility, so a private repo means the
NAS must log in with a token (Container Manager → Registry → Settings). If you
do not mind anyone seeing the image, make the package public — the repository
can stay private and the login goes away. The image holds the app, not your
data.

Images are not built on every push: that would waste a run on every commit.
Once work lands on `main` through pull requests, adding
`on: push: branches: [main]` to the workflow is reasonable.

A manual run can also attach a downloadable amd64 tarball if you do not want
to push to GHCR.

### Releasing versions

`:latest` does not say what is in the image. The commit SHA does, but nobody
remembers it. For a readable history, tag a commit on `main`:

```bash
git tag v0.4.0
git push origin v0.4.0
```

That starts `Release`. It calls `Build image`, so the published version is
built and tested from the tagged commit. Beside `:latest` and the commit SHA
you get `:0.4.0` and `:0.4`. Only after a successful build does a GitHub
Release appear, with notes generated from commit messages. Pin a version on
the NAS or a Mac instead of `:latest`:

```yaml
image: ghcr.io/nickrabit/streamio-offline:0.4.0
```

### Windows

The image is the Linux one — Docker Desktop on Windows runs Linux containers
through WSL2, so the image itself needs no Windows variant. Two host-side
changes: comment out the `devices:` block in `compose.yml` (`/dev/dri` does
not exist on Windows and the container would refuse to start), and point
`DATA_PATH` / `DOWNLOAD_PATH` in `.env` into WSL, not `/mnt/c/...`. Crossing
the filesystem boundary is slow enough to notice on downloads and artwork.
QuickSync does not work on Windows, so transcode runs on the CPU; a desktop
PC minds that less than a Celeron in a NAS.

## Diagnostics

When something fails, start at **Settings → Diagnostics**. The top is server
status (version, uptime, FFmpeg and hardware acceleration, running playback,
queue, free space). Below that, **Recent problems**: identical messages are
grouped with a count, so repeats stand out. Expanding a group shows the last
occurrences with detail. The full log is behind a button; it can be filtered
by level, downloaded, or copied.

The player reports its own failures to the server, so the log includes what
playback actually died on (hls.js error type, video-element code, repeated
stalling) — not only the message shown on screen.

The panel starts collapsed. The header shows a “No errors” badge, or a count.
Once expanded, filter by period (hour, day, week, all) and by text in the
message; the filter applies to grouped problems and to the detailed log.

The log lives in `/data/app.log`. Past `LOG_MAX_BYTES` (default 5 MB) it is
renamed to `app.log.1`. Records older than `LOG_RETENTION_DAYS` (default 7)
are dropped at start and then every six hours; `LOG_RETENTION_DAYS=0` turns
cleanup off. The Diagnostics page can wipe the log. The same lines go to
standard output, so `docker compose logs` sees them. Stream addresses are
logged as scheme and host only; tokens and passwords are not logged at all.

`LOG_LEVEL=DEBUG` in `.env` adds request and conversion detail.

### When an addon stops answering

Addon requests (catalog, metadata, streams, subtitles, artwork) go through a
guard that watches each host on its own. At most `ADDON_MAX_CONCURRENT`
requests (default 8) reach one host at a time. The cap is there only to bound
a runaway pile-up, not to slow an ordinary fan-out: a single addon routinely
serves a dozen catalogs from one address. Spacing requests apart
(`ADDON_MIN_INTERVAL_MS`) is off by default and worth setting only when a
provider says it is getting too many.

After `ADDON_BREAKER_FAILURES` consecutive failures (default 5) the host is
taken out of service for `ADDON_BREAKER_COOLDOWN_MS` (30 s): further requests
fail immediately instead of waiting for a timeout, so a dead source stops
holding up search. One request then probes the host once the pause expires —
on success the addon is back in service, on another failure the pause doubles
up to `ADDON_BREAKER_MAX_COOLDOWN_MS` (5 minutes). Only connection errors,
timeouts, HTTP 5xx and 429 count as failures; a plain 404 never takes an addon
out. When the source sends `Retry-After`, that decides the pause instead.

The state is visible in `/api/diagnostics` under `outbound` and in the
Diagnostics panel; every change is logged. `ADDON_GUARD=0` turns the whole
guard off. Downloads and video playback do not go through it — a long
transfer would hold a slot, and stopping playback would look like an outage.

## Where data lives

Beside downloaded films, the server keeps its own data: the account, addon
list, library artwork, stats, and the download queue. That lives in `/data`,
and `DATA_PATH` points at it — by default a `data` folder next to
`compose.yml`.

It is an ordinary folder, not a hidden Docker volume. Copy it to back it up;
delete it to return the server to a fresh install (you lose the account and
addons, downloaded files stay). On Synology, put it in a shared folder so it
shows up in File Station.

Older installs kept data in a named volume `stremio-offline-data`. Move it
over SSH with one command — `docker volume ls` shows the volume name:

```bash
docker run --rm -v stremio-offline_stremio-offline-data:/from -v /volume1/docker/stremio-offline/data:/to alpine sh -c 'cp -a /from/. /to/'
```

Without SSH it is simpler to start over: addons are re-added, downloaded files
stay because they sit outside this folder.

## Security

The server never runs addon code; it only reads their JSON APIs. By default it
blocks manifests and streams aimed at a private network. For your own LAN
addons, set `ALLOW_PRIVATE_ADDONS=1` or list hosts in `ALLOW_ADDON_HOSTS`.

You create the login on first open; no default account is created. The
password is stored only as a scrypt hash and the session carries a signed
ticket. Signing out of all devices rotates the signing secret, so previously
issued tickets stop working at once.

A forgotten password can be bypassed with environment fallbacks: set
`ADMIN_USERNAME` and `ADMIN_PASSWORD`, sign in with those, and change the
password in Settings. The other option is to delete the `auth` key from
`state.json` in the data folder — the server then offers account creation
again, and addons and the library stay.

Use only sources and accounts you have the right to access.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## License

[MIT](LICENSE). Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
This project is not affiliated with Stremio.
