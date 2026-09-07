# Install on a Synology NAS

The container can run as your own user, so shared-folder permissions do not have
to be rewritten. The steps work with or without SSH.

## Without SSH, through Container Manager

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
   `compose.synology.yml` override is ignored there. Hardware acceleration then
   has to be turned on by hand — see
   [Hardware acceleration](hardware-acceleration.md).

5. After the first start, open the container **Terminal** in Container Manager
   and see who owns the download folder:

   ```bash
   ls -n /downloads
   ```

   The first two numbers are uid and gid. Write them into `.env` as `PUID` and
   `PGID` and restart the project. For this purpose the Container Manager
   terminal is a full substitute for SSH.

6. Open `http://NAS:8090`. A fresh install has no account and asks you to choose
   a name and password; until then the server serves nothing else.

## With SSH

```bash
cd /volume1/docker
git clone https://github.com/NickRabit/streamio-offline.git
cd streamio-offline
cp .env.example .env
# set DOWNLOAD_PATH, ALLOW_ADDON_HOSTS, and PUID/PGID from:
stat -c '%u %g' /volume1/video/downloads
docker compose -f compose.yml -f compose.synology.yml up -d --build
```

The `compose.synology.yml` override adds the `/dev/dri` device and the render
group, so hardware acceleration works without further edits.

## When writes fail

The server logs at start if it cannot write to `/downloads`. Three options,
gentlest first:

- **`PUID` and `PGID`** matching the real folder owner. Nothing is rewritten.
- **In File Station**, grant read and write on the folder and apply that to
  subfolders.
- **`FIX_PERMISSIONS=1`** in `.env`. On start, once, it chowns the whole
  download folder. On a large library that takes a while, so it is not the
  default.

## Access from outside

On the home network the steps above are enough.

**Do not publish the app directly to the internet.** Login exists, but over
plain HTTP the session cookie travels in the clear. Use DSM's reverse proxy with
an HTTPS certificate; once the server sees `X-Forwarded-Proto: https`, it marks
the cookie `Secure` itself.

## Keeping the NAS responsive

Playing a large file can freeze Synology for minutes. Two causes, both fixable.

**Write burst.** During remux, FFmpeg runs faster than real time so seeking
stays snappy, and it dumps segments into `/data`. At the old 8× rate that was
over 300 MB in twenty seconds; a weaker NAS chokes pushing dirty pages to disk.
The default is therefore `FFMPEG_READRATE_REMUX=3` — seeking stays as fast,
because that is decided by the initial burst, but writes drop to a third. If
that is not enough, set it to `2`. Session segments are cleaned up when the
session ends; an idle session stops after five minutes.

**Saturated CPU.** Without acceleration, software transcode takes every core and
DSM stops responding. `compose.yml` has a commented `cpus` limit so you can
leave one core for the system. The lasting fix is QuickSync — see
[Hardware acceleration](hardware-acceleration.md). If the log says
`gpuScaling:false`, a slice of the scaling work stays on CPU; that is expected.

## Where data lives

Beside downloaded films, the server keeps its own data: the account, addon list,
library artwork, stats, and the download queue. That lives in `/data`, and
`DATA_PATH` points at it — by default a `data` folder next to `compose.yml`.

It is an ordinary folder, not a hidden Docker volume. Copy it to back it up;
delete it to return the server to a fresh install (you lose the account and
addons, downloaded files stay). On Synology, put it in a shared folder so it
shows up in File Station.

Older installs kept data in a named volume `stremio-offline-data`. Move it over
SSH with one command — `docker volume ls` shows the volume name:

```bash
docker run --rm -v stremio-offline_stremio-offline-data:/from -v /volume1/docker/stremio-offline/data:/to alpine sh -c 'cp -a /from/. /to/'
```

Without SSH it is simpler to start over: addons are re-added, and downloaded
files stay because they sit outside this folder.
