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

Volba kvality do téhle úvahy zasahuje: cokoli jiného než **Původní** znamená skutečné překódování, protože zmenšit obraz kopírováním nejde. Na NASu bez QuickSync se proto vyplatí zůstat na původní kvalitě — popisek pak ukazuje `PŘEBALENO` a procesor je prakticky nevytížený.

Když se přehrávání opakovaně zadrhává, přehrávač nabídne snížení kvality: menší datový tok spraví výpadky způsobené sítí. Nabídne ho ale jen tam, kde server má hardwarovou akceleraci — jinak by softwarové překódování slabý procesor zavalilo a zadrhávání by se ještě zhoršilo.

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

## Nasazení na Synology

Kontejner se umí spustit pod vaším uživatelem, takže není nutné přepisovat práva
sdílených složek. Postup existuje s SSH i bez něj.

### Bez SSH, přes Container Manager

1. Na GitHubu **Code → Download ZIP** z `https://github.com/NickRabit/streamio-offline`.
2. Ve **File Station** nahrajte ZIP například do `/volume1/docker/` a rozbalte ho
   (pravým tlačítkem → Extrahovat).
3. Ve File Station vytvořte v té složce soubor `.env` (Vytvořit → Textový soubor)
   a vložte do něj:

```dotenv
DOWNLOAD_PATH=/volume1/video/downloads
ALLOW_ADDON_HOSTS=192.168.1.205
PUID=1000
PGID=100
```

4. V **Container Manageru → Projekt → Vytvořit** vyberte tu složku a jako zdroj
   `docker-compose.yml` zvolte `compose.yml`.

   **Container Manager umí jen jeden compose soubor**, takže se v něm override
   `compose.synology.yml` neuplatní. Hardwarová akcelerace se tam zapíná ručně,
   viz [Hardwarová akcelerace](#hardwarová-akcelerace).
5. Po prvním startu otevřete v Container Manageru **Terminál** kontejneru a
   zjistěte, komu složka patří:

```bash
ls -n /downloads
```

   První dvě čísla jsou uid a gid. Zapište je do `.env` jako `PUID` a `PGID`
   a projekt restartujte. Terminál Container Manageru je plnohodnotná náhrada
   SSH pro tenhle účel.

6. Otevřete `http://NAS:8090`. Čerstvá instalace žádný účet nemá a rovnou vás
   nechá zvolit jméno a heslo; do té doby server nepustí nic jiného. Žádné
   výchozí heslo neexistuje, takže není co zapomenout změnit.

### S SSH

```bash
cd /volume1/docker
git clone https://github.com/NickRabit/streamio-offline.git
cd streamio-offline
cp .env.example .env
# doplnit DOWNLOAD_PATH, ALLOW_ADDON_HOSTS a PUID/PGID podle:
stat -c '%u %g' /volume1/video/downloads
docker compose -f compose.yml -f compose.synology.yml up -d --build
```

### Když se nedaří zapisovat

Server při startu ohlásí, pokud do `/downloads` zapisovat nemůže. Máte tři možnosti,
seřazené od nejšetrnější:

- **`PUID` a `PGID`** podle skutečného vlastníka složky. Nic se nepřepisuje.
- **Ve File Station** přidat složce oprávnění pro čtení a zápis a použít je i na
  podsložky.
- **`FIX_PERMISSIONS=1`** v `.env`. Při startu jednorázově přepíše vlastníka celé
  složky se stahováním. U velké knihovny to chvíli trvá, proto to není výchozí.

### Přístup zvenčí

Na domácí síti stačí, co je popsané výše. **Ven aplikaci nevystavujte přímo.**
Přihlášení sice existuje, ale po HTTP jde relační cookie po síti nechráněná a
kdokoli na cestě ji může odposlechnout. Použijte reverzní proxy DSM s HTTPS
certifikátem; jakmile server uvidí `X-Forwarded-Proto: https`, začne cookie
označovat jako `Secure` sám.

### Hardwarová akcelerace

Na Synology s Intel iGPU (Celeron s QuickSync, např. DS220+/DS920+) potřebuje kontejner dvě věci: přístup k zařízení `/dev/dri` a členství ve skupině, která render node vlastní. Bez té skupiny proces po přepnutí na `PUID`/`PGID` zařízení neotevře a server se tiše vrátí k softwarovému převodu.

**V Container Manageru** (bez SSH) odkomentujte v `compose.yml` blok

```yaml
    devices:
      - /dev/dri:/dev/dri
```

a do `.env` doplňte `VAAPI_DEVICE=/dev/dri/renderD128` a `RENDER_GID`. Správný GID zjistíte v **Terminálu** kontejneru:

```bash
ls -n /dev/dri
```

Druhé číslo u `renderD128` je hledaná skupina; na DSM 7 to bývá 937 (`videodriver`). Pak projekt zastavte a znovu sestavte.

**Přes SSH** je jednodušší override, který obojí nastaví sám:

```bash
docker compose -f compose.yml -f compose.synology.yml up -d --build
```

GID si tam případně přepíšete v `.env` jako `RENDER_GID`; na NASu ho zjistíte příkazem `stat -c "%g" /dev/dri/renderD128`.

Že akcelerace běží, poznáte v logu podle `VAAPI je k dispozici` a v přehrávači podle štítku `VAAPI`. Dokud tam svítí `VAAPI_DEVICE není dostupné`, akcelerace vypnutá je. Pokud se hardwarový převod nepodaří spustit, server se sám vrátí k softwarovému. Ovladače QuickSync se instalují jen do amd64 image. Bez akcelerace jede přímé přehrávání i přebalení naplno, softwarové překódování 1080p ale Celeron v reálném čase nestíhá.

### Když se NAS zadrhává

Přehrávání velkého souboru umí Synology na několik minut položit. Stojí za tím dvě věci a obě se dají srovnat.

**Zápisový nával.** Při přebalení běží FFmpeg rychleji než reálný čas, aby byl posun po časové ose svižný, a segmenty sype do `/data`. Při původní osminásobné rychlosti to bylo přes 300 MB za dvacet sekund; slabší NAS se zadusí protlačováním špinavých stránek na disk. Výchozí hodnota je proto `FFMPEG_READRATE_REMUX=3` — posun zůstává stejně rychlý, protože o něm rozhoduje počáteční nával, ale zápis klesne na třetinu. Když to nestačí, snižte ji na `2`. Segmenty relace se uklidí po jejím konci a nečinná relace se ukončí po pěti minutách.

**Vytížený procesor.** Bez akcelerace vezme softwarový převod všechna jádra a DSM přestane reagovat. V `compose.yml` je proto připravený zakomentovaný limit `cpus`, kterým jedno jádro necháte systému. Trvalejší řešení je zprovoznit QuickSync, viz [Hardwarová akcelerace](#hardwarová-akcelerace) — pak se skoro nepřekódovává.

## Fronta stahování

Fronta přežije restart, umí navázat na `.part` soubor pomocí HTTP Range a podporuje pozastavení, pokračování, opakování chyby, změnu pořadí, odstranění a 1–8 souběžných stahování. Dokončený soubor se při odstranění z historie nemaže.

V **Nastavení** se volí, kolik souborů se stahuje najednou dohromady a kolik z jednoho zdroje. Poskytovatelé obvykle omezují počet souběžných spojení a přebytečné přenosy utnou nebo je nechají hladovět, dokud je nesejme hlídač nečinnosti; jeden přenos na zdroj je proto nejbezpečnější. Přerušené spojení fronta sama naváže, a jakmile se přenos zase rozjede, vrátí se i rozpočet pokusů.

V části **Doplňky** lze pro každý doplněk poskytující streamy zvlášť nastavit ukládání filmů a seriálů. Hostitelský adresář určuje `DOWNLOAD_PATH`; v kartě doplňku se zadává jen relativní podsložka uvnitř něj. Prázdná podsložka znamená přímo základní `DOWNLOAD_PATH`; lze použít i více úrovní, například `Webshare/Filmy`. Strukturovaný režim vytváří pro film složku podle názvu a pro seriál složky seriálu a série. Plochý režim ukládá přímo do zvolené podsložky, například `Film.mkv` nebo `Seriál - S01E07 - Název dílu.mkv`. Změna se projeví u nově přidaných položek ve frontě.

Při první inicializaci se automaticky přidají oficiální **Cinemeta** (katalog a metadata) a **OpenSubtitles v3** (titulky). Lze je vypnout nebo odstranit; po vědomém odstranění se při restartu samy nevrátí.

## Bezpečnost

Server nespouští kód doplňků, pouze čte jejich JSON API. Ve výchozím stavu blokuje manifesty a streamy směřující do privátní sítě. Pro vlastní LAN doplňky lze vědomě nastavit `ALLOW_PRIVATE_ADDONS=1`.

Přihlášení si zakládáte při prvním otevření, výchozí účet se nevytváří. Heslo se ukládá jen jako otisk (scrypt) a relace nese podepsanou známku; odhlášení všech zařízení vymění podpisové tajemství, takže dosud vydané známky rázem neplatí.

Zapomenuté heslo se dá obejít záložními údaji z prostředí: nastavte `ADMIN_USERNAME` a `ADMIN_PASSWORD`, přihlaste se jimi a heslo si v Nastavení změňte. Druhá možnost je smazat klíč `auth` ze souboru `state.json` v datovém svazku — server pak při dalším startu znovu nabídne založení účtu a doplňky ani knihovna se neztratí.

Používejte pouze zdroje a účty, ke kterým máte oprávněný přístup.
