#!/usr/bin/env sh
# Sestaví obraz pro NAS a uloží ho jako balík k nahrání do Container Manageru.
#
#   ./scripts/build-image.sh              # amd64, balík do ./dist
#   ./scripts/build-image.sh --arch arm64 # jiná architektura
#   ./scripts/build-image.sh --tag stremio-offline:local --out /tmp
#
# Proč skript: obraz musí být pro architekturu NASu (na Macu jde jen přes buildx),
# musí nést ovladače VAAPI a musí mít značku, kterou čeká compose. Ručně se na
# některý z těch kroků snadno zapomene.
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
    *) echo "Neznámý přepínač: $1" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."
mkdir -p "$OUT"
FILE="$OUT/stremio-offline-$ARCH-$(date +%Y-%m-%d).tar.gz"

echo "==> Testy a překlad"
docker build --target build -t stremio-offline:build . >/dev/null
docker run --rm stremio-offline:build sh -lc 'npx tsc --noEmit -p server && npx tsc --noEmit -p web && npm test' \
  | grep -E '^# (tests|pass|fail)'

echo "==> Sestavení obrazu pro linux/$ARCH"
docker buildx build --platform "linux/$ARCH" -t "$TAG" --load .

echo "==> Kontrola obsahu"
docker run --rm --platform "linux/$ARCH" "$TAG" sh -lc '
  printf "    architektura: %s\n" "$(dpkg --print-architecture 2>/dev/null)"
  printf "    ffmpeg:       %s\n" "$(ffmpeg -version 2>/dev/null | head -1 | cut -d" " -f1-3)"
  drivers=$(ls /usr/lib/*/dri/ 2>/dev/null | grep drv_video | tr "\n" " ")
  printf "    VA ovladače:  %s\n" "${drivers:-žádné (u arm64 se neinstalují)}"
'

echo "==> Balení do $FILE"
docker save "$TAG" | gzip -1 > "$FILE"
printf "    velikost: %s\n" "$(du -h "$FILE" | cut -f1)"

echo
echo "Hotovo. Nahrajte $FILE na NAS a v Container Manageru zvolte"
echo "Image -> Přidat -> Přidat ze souboru. Obraz se naimportuje jako $TAG."
