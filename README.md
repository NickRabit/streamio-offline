# Stremio Offline

Docker-only webový klient pro standardní Stremio doplňky. Umí pracovat s oddělenými katalogovými a zdrojovými manifesty, agregovat streamy a titulky, přehrávat HTTP zdroje přes kompatibilní HLS vrstvu a ukládat přímé streamy do perzistentní fronty.

## Spuštění

```bash
cp .env.example .env
docker compose up -d --build
```

Webové rozhraní bude na `http://localhost:8090`.

Stažené soubory se ukládají do hostitelského adresáře nastaveného proměnnou `DOWNLOAD_PATH`. Na Synology nastavte například:

```dotenv
DOWNLOAD_PATH=/volume1/video/downloads
```

## Doplňky a Real-Debrid

V části **Doplňky** vložte úplnou adresu `manifest.json`. Katalogový manifest poskytuje filmy, seriály a metadata, zdrojový manifest poskytuje streamy nebo titulky. Jeden manifest může mít obě role.

Personalizované manifesty doplňků nakonfigurovaných pro Real-Debrid jsou podporované. Citlivá část URL se po uložení v UI nezobrazuje. Pokud doplněk vrátí už rozlišenou HTTPS adresu, lze ji přehrát a stáhnout. Samostatné rozlišení nezpracovaného `infoHash` přes Real-Debrid API je plánováno pro další verzi.

## Přehrávání a fronta

Docker image obsahuje FFmpeg. Při přehrávání průběžně vytváří HLS kompatibilní s Chrome, Safari i mobilními prohlížeči; H.264 obraz se podle informací doplňku pouze kopíruje, ostatní video se převádí do H.264 a zvuk do AAC. Převod skončí při zavření přehrávače. Na slabším NAS volte raději H.264 streamy a nižší rozlišení.

Fronta přežije restart, umí navázat na `.part` soubor pomocí HTTP Range a podporuje pozastavení, pokračování, opakování chyby, změnu pořadí, odstranění a 1–8 souběžných stahování. Dokončený soubor se při odstranění z historie nemaže.

Při první inicializaci se automaticky přidají oficiální **Cinemeta** (katalog a metadata) a **OpenSubtitles v3** (titulky). Lze je vypnout nebo odstranit; po vědomém odstranění se při restartu samy nevrátí.

## Bezpečnost

Server nespouští kód doplňků, pouze čte jejich JSON API. Ve výchozím stavu blokuje manifesty a streamy směřující do privátní sítě. Pro vlastní LAN doplňky lze vědomě nastavit `ALLOW_PRIVATE_ADDONS=1`.

Používejte pouze zdroje a účty, ke kterým máte oprávněný přístup.
