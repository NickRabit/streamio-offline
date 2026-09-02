#!/bin/sh
set -e

# Na NASu patří sdílené složky jinému uživateli než uid 1000 z image. Místo přepisování
# práv celé knihovny se proces spustí přímo pod tím, komu složka patří.
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if [ "$(id -u)" = "0" ]; then
  # Stav aplikace je malý, ten přepsat můžeme vždy.
  chown -R "$PUID:$PGID" /data 2>/dev/null || true

  if [ "${FIX_PERMISSIONS:-0}" = "1" ]; then
    echo "FIX_PERMISSIONS=1: přepisuji vlastníka /downloads na $PUID:$PGID (u velké knihovny to chvíli trvá)"
    chown -R "$PUID:$PGID" /downloads 2>/dev/null || true
  fi

  CHECK_GROUPS="$PGID"
  if [ -n "${RENDER_GID:-}" ] && [ "$RENDER_GID" != "$PGID" ]; then
    CHECK_GROUPS="$PGID,$RENDER_GID"
  fi
  if ! setpriv --reuid="$PUID" --regid="$PGID" --groups="$CHECK_GROUPS" -- test -w /downloads 2>/dev/null; then
    echo "VAROVÁNÍ: uživatel $PUID:$PGID nemá právo zápisu do /downloads."
    echo "          Nastavte PUID a PGID podle vlastníka složky, nebo spusťte s FIX_PERMISSIONS=1."
  fi

  # gosu při přepnutí uživatele zahodí group_add z Docker Compose. Render skupinu
  # proto předáme setpriv výslovně, jinak by /dev/dri na Synology nebylo přístupné.
  exec setpriv --reuid="$PUID" --regid="$PGID" --groups="$CHECK_GROUPS" -- "$@"
fi

exec "$@"
