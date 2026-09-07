# Hardware acceleration (Intel QuickSync / VAAPI)

Hardware acceleration matters only for a **real transcode**. Direct play and
remux — the common path — never touch the GPU. See
[Playback](playback.md) for which source lands in which mode.

On Synology with an Intel iGPU (a Celeron with QuickSync, for example DS220+ or
DS920+) the container needs two things: access to `/dev/dri`, and membership in
the group that owns the render node. Without that group the process cannot open
the device after switching to `PUID`/`PGID`, and the server silently falls back
to software conversion.

## Turning it on

**Over SSH**, the override file sets both for you:

```bash
docker compose -f compose.yml -f compose.synology.yml up -d --build
```

**In Container Manager** (no SSH, single compose file only), uncomment this
block in `compose.yml`:

```yaml
    devices:
      - /dev/dri:/dev/dri
```

and add `VAAPI_DEVICE=/dev/dri/renderD128` and `RENDER_GID` to `.env`. The right
GID is in the container **Terminal**:

```bash
ls -n /dev/dri
```

The second number on `renderD128` is the group; on DSM 7 it is usually 937
(`videodriver`). On the NAS itself, `stat -c "%g" /dev/dri/renderD128` says the
same. Then stop the project and build it again.

## Verifying it works

The encoder is ready when the log says `VAAPI is available`. At start the server
actually encodes a test frame and separately checks hardware scaling and
bitrate control.

Limited Synology drivers can correctly report `gpuScaling:false` or
`bitrateControl:false`; that is not a bug. The app then decodes and shrinks on
CPU, uploads to the GPU, and hardware-encodes in constant-quality mode. Real GPU
work is confirmed by `hardware:true` on the start, track-change, or seek log
line.

## Quality settings

| Variable | Applies to | Meaning |
| --- | --- | --- |
| `VAAPI_QP` | hardware | CQP quality, default 23. Lower means higher quality and more bitrate. |
| `FFMPEG_CRF` | software fallback only | Same idea for `libx264`. |
| `FFMPEG_PRESET` | software fallback only | `libx264` speed/quality trade-off. |

Hardware conversion always transcodes audio to AAC for a reliable fMP4/HLS
output. A plain remux leaves audio untouched.

## When the driver does not start

`unknown libva error` means the device opens but the driver did not load. See
what is available in the container terminal:

```bash
vainfo --display drm --device /dev/dri/renderD128
```

If libva does not pick a driver, force it in `.env` with `LIBVA_DRIVER_NAME` —
`iHD` for Gemini Lake and newer, `i965` especially for older Braswell.

If VAAPI never comes up, nothing breaks: direct play and remux still work, and a
real transcode falls back to `libx264` on the CPU.
