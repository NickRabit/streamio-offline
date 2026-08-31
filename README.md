# Stremio Offline

Docker-only webový klient pro standardní Stremio doplňky. Umí pracovat s oddělenými katalogovými a zdrojovými manifesty, agregovat streamy a titulky, přehrávat podporované HTTP/HLS zdroje a ukládat přímé streamy do perzistentní fronty.

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

Při první inicializaci se automaticky přidají oficiální **Cinemeta** (katalog a metadata) a **OpenSubtitles v3** (titulky). Lze je vypnout nebo odstranit; po vědomém odstranění se při restartu samy nevrátí.

## Bezpečnost

Server nespouští kód doplňků, pouze čte jejich JSON API. Ve výchozím stavu blokuje manifesty a streamy směřující do privátní sítě. Pro vlastní LAN doplňky lze vědomě nastavit `ALLOW_PRIVATE_ADDONS=1`.

Používejte pouze zdroje a účty, ke kterým máte oprávněný přístup.
