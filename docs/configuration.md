# Configuration reference

Every setting is an environment variable, read from `.env` next to
`compose.yml`. Start from [`.env.example`](../.env.example), which carries the
same list with short comments.

## Paths and identity

| Variable | Default | Meaning |
| --- | --- | --- |
| `STREMIO_OFFLINE_PORT` | `8090` | Host port the UI is published on. |
| `DOWNLOAD_PATH` | `./downloads` | Host directory for downloaded media. |
| `DATA_PATH` | `./data` | Server data: account, addons, artwork, stats, queue. An ordinary folder — copy it to back it up. |
| `TZ` | `Europe/Prague` | Container timezone; affects log timestamps. |
| `PUID` / `PGID` | `1000` / `1000` | User the process runs as. Match the owner of `DOWNLOAD_PATH`. |
| `FIX_PERMISSIONS` | `0` | `1` chowns the whole download folder once at start. Slow on a large library. |

## Logging

| Variable | Default | Meaning |
| --- | --- | --- |
| `LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARN`, `ERROR`. `DEBUG` adds request and conversion detail. |
| `LOG_MAX_BYTES` | `5242880` | Size of one log file before it rotates to `app.log.1`. |
| `LOG_RETENTION_DAYS` | `7` | Age at which records are dropped. `0` disables cleanup. |

## Addon access

| Variable | Default | Meaning |
| --- | --- | --- |
| `ALLOW_ADDON_HOSTS` | *(empty)* | Comma-separated hosts on the LAN that may be used as addons. |
| `ALLOW_PRIVATE_ADDONS` | `0` | `1` opens the whole private network. Prefer `ALLOW_ADDON_HOSTS`. |

## Addon guard

Details in [Troubleshooting](troubleshooting.md#when-an-addon-stops-answering).

| Variable | Default | Meaning |
| --- | --- | --- |
| `ADDON_GUARD` | `1` | `0` turns concurrency limiting and the circuit breaker off. |
| `ADDON_MAX_CONCURRENT` | `8` | Concurrent requests allowed to one host. |
| `ADDON_MAX_QUEUE` | `256` | Requests waiting for a slot on one host. |
| `ADDON_MIN_INTERVAL_MS` | `0` | Minimum gap between requests to one host. |
| `ADDON_BREAKER_FAILURES` | `5` | Consecutive failures before a host is taken out of service. |
| `ADDON_BREAKER_COOLDOWN_MS` | `30000` | First cooldown; each further outage doubles it. |
| `ADDON_BREAKER_MAX_COOLDOWN_MS` | `300000` | Ceiling for that doubling. |

## Conversion

Details in [Playback](playback.md) and
[Hardware acceleration](hardware-acceleration.md).

| Variable | Default | Meaning |
| --- | --- | --- |
| `FFMPEG_READRATE` | `1.5` | How far ahead of real time conversion may run. |
| `FFMPEG_READRATE_REMUX` | `3` | The same for remux only. Lower it to `2` if the NAS chokes on write bursts. |
| `FFMPEG_PRESET` | `veryfast` | `libx264` preset. Software fallback only. |
| `FFMPEG_CRF` | `23` | `libx264` quality. Lower means better and heavier. Software fallback only. |
| `VAAPI_QP` | `23` | Hardware CQP quality. Lower means better and more bitrate. |
| `VAAPI_DEVICE` | *(unset)* | Render node, usually `/dev/dri/renderD128`. |
| `RENDER_GID` | *(unset)* | GID owning the render node. Without it the process cannot open the device. |
| `LIBVA_DRIVER_NAME` | *(auto)* | Force `iHD` (Gemini Lake and newer) or `i965` (older Braswell). |

## Account fallback

| Variable | Default | Meaning |
| --- | --- | --- |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | *(unset)* | Emergency sign-in when the password is lost. Change the real password afterwards and unset these. |
