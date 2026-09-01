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

## Přehrávání

Docker image obsahuje FFmpeg a přehrávač volí vždy nejlevnější možnou cestu. Prohlížeč při startu ohlásí, jaké kodeky umí, a server se podle toho rozhodne:

| Zdroj | Režim | Zátěž NASu |
| --- | --- | --- |
| MP4/WebM, který prohlížeč zvládne sám | přímé přehrání, FFmpeg se vůbec nespustí | žádná |
| MKV s H.264 nebo HEVC | přebalení do fMP4, video i zvuk se kopírují | zanedbatelná |
| Zvuk AC3, DTS nebo TrueHD | přebalení, převede se jen zvuk do AAC | malá |
| MPEG-4 ASP, VC-1 a podobné | skutečné překódování do H.264 | vysoká |

Aktuální režim ukazuje popisek nad obrazem, vedle ovládání jsou vidět skutečné kodeky zdroje.

### Posun po časové ose

Uvnitř už převedeného úseku se skáče okamžitě. Při skoku dál se převod restartuje od nové pozice pomocí `-ss`, což díky HTTP Range nestahuje nic před ní; skok na libovolné místo filmu trvá řádově sekundu. Titulky se o stejnou hodnotu automaticky posunou. V režimu přímého přehrání jde seek nativně přes prohlížeč. Klávesy: mezerník přehrát a pozastavit, šipky ±10 s, `f` celá obrazovka.

Protože se video při přebalení jen kopíruje, začíná přehrávání od nejbližšího klíčového snímku před požadovaným časem — odchylka bývá několik sekund. Stejně se chová i Emby nebo Jellyfin.

### Zvukové stopy a titulky

Přehrávač nabízí výběr zvukové stopy a titulků včetně vypnutí. Titulky se berou ze dvou zdrojů:

- **vestavěné v souboru** — vypadnou jako samostatná WebVTT stopa ze stejného průchodu FFmpegem, takže se soubor nestahuje podruhé,
- **z titulkových doplňků** (například OpenSubtitles) — připojí se přímo v prohlížeči.

Přepnutí stopy znamená nové mapování pro FFmpeg, takže se převod restartuje na aktuální pozici, stejně jako u posunu. Obrázkové titulky (PGS, VobSub) se nenabízejí — do WebVTT je převést nelze.

V **Nastavení** se volí preferovaný jazyk zvuku a titulků, ve výchozím stavu čeština se záložní angličtinou. Přehrávač podle toho vybere stopu sám při startu.

V seznamu zdrojů se jazyk odhaduje z názvu, který poslal doplněk. U vybraného zdroje se navíc zobrazí skutečné jazyky zjištěné rozborem souboru.

### Hardwarová akcelerace

Na Synology s Intel iGPU lze poslední řádek tabulky odbavit přes QuickSync. V `compose.yml` odkomentujte `devices` a `group_add` (správné GID zjistíte příkazem `stat -c "%g" /dev/dri/renderD128`) a v `.env` nastavte `VAAPI_DEVICE=/dev/dri/renderD128`. Pokud se hardwarový převod nepodaří spustit, server se sám vrátí k softwarovému. Ovladače QuickSync se instalují jen do amd64 image.

## Fronta stahování

Fronta přežije restart, umí navázat na `.part` soubor pomocí HTTP Range a podporuje pozastavení, pokračování, opakování chyby, změnu pořadí, odstranění a 1–8 souběžných stahování. Dokončený soubor se při odstranění z historie nemaže.

V části **Doplňky** lze pro každý zdroj zvlášť nastavit ukládání filmů a seriálů. Prázdná podsložka znamená základní `DOWNLOAD_PATH`; lze použít i více úrovní, například `Webshare/Filmy`. Strukturovaný režim vytváří pro film složku podle názvu a pro seriál složky seriálu a série. Plochý režim ukládá přímo do zvolené podsložky, například `Film.mkv` nebo `Seriál - S01E07 - Název dílu.mkv`. Změna se projeví u nově přidaných položek ve frontě.

Při první inicializaci se automaticky přidají oficiální **Cinemeta** (katalog a metadata) a **OpenSubtitles v3** (titulky). Lze je vypnout nebo odstranit; po vědomém odstranění se při restartu samy nevrátí.

## Bezpečnost

Server nespouští kód doplňků, pouze čte jejich JSON API. Ve výchozím stavu blokuje manifesty a streamy směřující do privátní sítě. Pro vlastní LAN doplňky lze vědomě nastavit `ALLOW_PRIVATE_ADDONS=1`.

Používejte pouze zdroje a účty, ke kterým máte oprávněný přístup.
