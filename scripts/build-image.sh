#!/usr/bin/env sh
# Build the image for a NAS and save it as a tarball to upload in Container Manager.
#
#   ./scripts/build-image.sh              # amd64, tarball in ./dist
#   ./scripts/build-image.sh --arch arm64 # a different architecture
#   ./scripts/build-image.sh --tag stremio-offline:local --out /tmp
#
# Why a script: the image must match the NAS architecture (on a Mac that means
# buildx), must carry VAAPI drivers, and must have the tag compose expects.
# Any of those is easy to miss by hand.
set -eu

ARCH=amd64
TAG=stremio-offline:local
OUT=dist

while [ $# -gt 0 ]; do
  case "$1" in
    --arch) ARCH="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."
mkdir -p "$OUT"
FILE="$OUT/stremio-offline-$ARCH-$(date +%Y-%m-%d).tar.gz"

echo "==> Tests and typecheck"
docker build --target build -t stremio-offline:build . >/dev/null
docker run --rm stremio-offline:build sh -lc 'npx tsc --noEmit -p server && npx tsc --noEmit -p web && npm test' \
  | grep -E '^# (tests|pass|fail)'

echo "==> Building image for linux/$ARCH"
docker buildx build --platform "linux/$ARCH" -t "$TAG" --load \
  --build-arg BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --build-arg GIT_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)" .

echo "==> Checking contents"
docker run --rm --platform "linux/$ARCH" "$TAG" sh -lc '
  printf "    architecture: %s\n" "$(dpkg --print-architecture 2>/dev/null)"
  printf "    ffmpeg:       %s\n" "$(ffmpeg -version 2>/dev/null | head -1 | cut -d" " -f1-3)"
  drivers=$(ls /usr/lib/*/dri/ 2>/dev/null | grep drv_video | tr "\n" " ")
  printf "    VA drivers:   %s\n" "${drivers:-none (not installed on arm64)}"
'

echo "==> Packing into $FILE"
docker save "$TAG" | gzip -1 > "$FILE"
printf "    size: %s\n" "$(du -h "$FILE" | cut -f1)"

echo
echo "Done. Upload $FILE to the NAS and in Container Manager choose"
echo "Image -> Add -> Add from file. The image imports as $TAG."
