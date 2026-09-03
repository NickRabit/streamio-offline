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
DATA_PATH=/volume1/docker/stremio-offline/data
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

Ve stejné části lze konfiguraci exportovat do JSON a později ji importovat. Záloha obsahuje nastavení aplikace, pořadí a stav nainstalovaných doplňků i jejich pravidla ukládání; neobsahuje účet, knihovnu ani historii sledování. Personalizované URL doplňků mohou obsahovat přístupové tokeny, proto je potřeba se souborem zacházet jako s heslem. Import nahradí aktuální konfiguraci a před uložením znovu ověří všechny manifesty.

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
DATA_PATH=/volume1/docker/stremio-offline/data
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

Že je enkodér připravený, poznáte v logu podle `VAAPI je k dispozici`. Server při startu opravdu zakóduje zkušební snímek a zvlášť ověří hardwarové škálování a řízení datového toku. Omezené ovladače v Synology proto mohou správně hlásit `gpuScaling:false` nebo `bitrateControl:false`; nejde o chybu. Aplikace pak obraz dekóduje a zmenší na CPU, nahraje jej do GPU a hardwarově zakóduje v režimu konstantní kvality. Skutečný běh na GPU potvrzuje `hardware:true` u záznamu o spuštění, změně stopy nebo posunu.

Pro CQP lze v `.env` nastavit `VAAPI_QP=23`. Nižší číslo znamená vyšší kvalitu a větší datový tok; vyšší číslo šetří místo a síť. `FFMPEG_CRF` a `FFMPEG_PRESET` se používají jen při softwarovém fallbacku. Při hardwarovém převodu se zvuk převádí do AAC kvůli spolehlivému fMP4/HLS výstupu; při pouhém přebalení zůstává beze změny.

Hláška `unknown libva error` znamená, že zařízení jde otevřít, ale ovladač se nerozběhl. Co je k dispozici, zjistíte v terminálu kontejneru:

```bash
vainfo --display drm --device /dev/dri/renderD128
```

Když si libva ovladač nevybere sama, vynuťte ho v `.env` přes `LIBVA_DRIVER_NAME` — `iHD` pro Gemini Lake a novější, `i965` zejména pro starší Braswell. Pokud VAAPI nerozchodíte vůbec, přímé přehrávání i přebalení dál fungují bez akcelerace a skutečný převod přejde na `libx264`.

### Když se NAS zadrhává

Přehrávání velkého souboru umí Synology na několik minut položit. Stojí za tím dvě věci a obě se dají srovnat.

**Zápisový nával.** Při přebalení běží FFmpeg rychleji než reálný čas, aby byl posun po časové ose svižný, a segmenty sype do `/data`. Při původní osminásobné rychlosti to bylo přes 300 MB za dvacet sekund; slabší NAS se zadusí protlačováním špinavých stránek na disk. Výchozí hodnota je proto `FFMPEG_READRATE_REMUX=3` — posun zůstává stejně rychlý, protože o něm rozhoduje počáteční nával, ale zápis klesne na třetinu. Když to nestačí, snižte ji na `2`. Segmenty relace se uklidí po jejím konci a nečinná relace se ukončí po pěti minutách.

**Vytížený procesor.** Bez akcelerace vezme softwarový převod všechna jádra a DSM přestane reagovat. V `compose.yml` je proto připravený zakomentovaný limit `cpus`, kterým jedno jádro necháte systému. Trvalejší řešení je zprovoznit QuickSync, viz [Hardwarová akcelerace](#hardwarová-akcelerace) — náročné kódování pak převezme Intel GPU. Pokud log uvádí `gpuScaling:false`, menší část práce se škálováním zůstane na CPU, což je očekávané.

## Fronta stahování

Fronta přežije restart, umí navázat na `.part` soubor pomocí HTTP Range a podporuje pozastavení, pokračování, opakování chyby, změnu pořadí, odstranění a 1–8 souběžných stahování. Dokončený soubor se při odstranění z historie nemaže.

V **Nastavení** se volí, kolik souborů se stahuje najednou dohromady a kolik z jednoho zdroje. Poskytovatelé obvykle omezují počet souběžných spojení a přebytečné přenosy utnou nebo je nechají hladovět, dokud je nesejme hlídač nečinnosti; jeden přenos na zdroj je proto nejbezpečnější. Přerušené spojení fronta sama naváže, a jakmile se přenos zase rozjede, vrátí se i rozpočet pokusů.

V části **Doplňky** lze pro každý doplněk poskytující streamy zvlášť nastavit ukládání filmů a seriálů. Hostitelský adresář určuje `DOWNLOAD_PATH`; v kartě doplňku se zadává jen relativní podsložka uvnitř něj. Prázdná podsložka znamená přímo základní `DOWNLOAD_PATH`; lze použít i více úrovní, například `Webshare/Filmy`. Strukturovaný režim vytváří pro film složku podle názvu a pro seriál složky seriálu a série. Plochý režim ukládá přímo do zvolené podsložky, například `Film.mkv` nebo `Seriál - S01E07 - Název dílu.mkv`. Změna se projeví u nově přidaných položek ve frontě.

Při první inicializaci se automaticky přidají oficiální **Cinemeta** (katalog a metadata) a **OpenSubtitles v3** (titulky). Lze je vypnout nebo odstranit; po vědomém odstranění se při restartu samy nevrátí.

## Sestavení obrazu

Stavět na NASu se nevyplácí: trvá to dlouho a Container Manager používá klasický builder, kde se kvůli prázdnému `ARG TARGETARCH` snadno ztratí ovladače VAAPI. Obraz proto vzniká jinde a NAS ho jen dostane hotový.

**Místně** to udělá jeden příkaz — přeloží, projede testy, sestaví pro zvolenou architekturu, vypíše, co v obrazu je, a zabalí ho:

```bash
./scripts/build-image.sh
```

Vznikne `dist/stremio-offline-amd64-<datum>.tar.gz`, který nahrajete na NAS a v Container Manageru přidáte přes **Image → Přidat → Přidat ze souboru**. Přepínače `--arch`, `--tag` a `--out` mění architekturu, značku a cílovou složku.

**Na GitHubu** to samé dělá workflow `Sestavení obrazu`, spouštěný ručně (**Actions → Sestavení obrazu → Run workflow**) a při vydání verze. Nejdřív pustí testy, pak sestaví obraz zvlášť pro `linux/amd64` a `linux/arm64` (repozitář je veřejný, takže má pro obě architektury zdarma nativní runner — žádná emulace), spojí je do jednoho seznamu a odešle do GHCR jako `ghcr.io/nickrabit/streamio-offline:latest` (a pod otiskem commitu). Nakonec ověří, že amd64 obraz opravdu nese ovladače VAAPI — jinak úloha spadne. arm64 se na ovladače nekontroluje, tam QuickSync stejně nejede.

Díky tomu je tenhle jeden obraz vhodný i pro **Mac s Apple Silicon**: `docker pull` nebo `docker compose up` si samy vyberou architekturu, která na stroji sedí, takže na M1/M2/M3 Macu se stahuje hotový arm64 obraz místo osmiminutového sestavování přes emulaci.

NAS pak obraz jen stahuje. Použijte `compose.pull.yml` místo `compose.yml`:

```bash
docker compose -f compose.pull.yml pull
docker compose -f compose.pull.yml up -d
```

Pozor na jednu věc: Container Manager stahuje obraz jen tehdy, když ho ještě nemá. Projekt, který `:latest` už jednou stáhl, po zastavení a spuštění nastartuje tu starou verzi znovu. O nový obraz je proto potřeba říct výslovně — buď smazat ten místní v záložce **Image** a projekt spustit, nebo použít `scripts/nas-update.sh`, který stažení i restart udělá sám:

```bash
./scripts/nas-update.sh /volume2/docker/streamio-offline
```

Bez SSH ho pověsíte na **Řídicí panel → Plánovač úloh → Vytvořit → Uživatelem definovaný skript**, spouštěný jako `root`. Jde tak i aktualizovat pravidelně.

Balíček v GHCR zdědí soukromí repozitáře, takže se k němu NAS musí přihlásit tokenem (Container Manager → Registry → Nastavení). Pokud vám nevadí, že obraz uvidí kdokoli, je jednodušší přepnout balíček v GitHubu na veřejný — repozitář může zůstat soukromý a přihlašování odpadne. Obraz nenese žádné údaje, jen aplikaci.

Na push se nestaví: commitů bývá hodně a obraz z každého z nich by byl zbytečný běh. Až se vývoj přesune na větve a do `main` se bude slévat hotová práce, dává smysl vrátit do workflow `on: push: branches: [main]`.

Ruční spuštění navíc umí přiložit balík ke stažení, když se do GHCR pouštět nechcete.

### Vydání verzí

Značka `:latest` sama o sobě neřekne, co v obrazu je — k tomu slouží otisk commitu, ale ten si nikdo nepamatuje. Pro čitelnou historii verzí otagujte commit na `main`:

```bash
git tag v0.4.0
git push origin v0.4.0
```

Spustí se `Vydání verze`. To si zavolá `Sestavení obrazu`, takže se obraz sestaví a otestuje přímo z commitu, na který tag ukazuje — vydaná verze je pak zaručeně to, co se otestovalo. Ke značkám `:latest` a otisku commitu přibudou `:0.4.0` a `:0.4`. Až po úspěšném sestavení vznikne GitHub Release s automaticky vygenerovanými poznámkami ze zpráv commitů. Na NASu nebo Macu pak jde připnout konkrétní verzi místo `:latest`:

```yaml
image: ghcr.io/nickrabit/streamio-offline:0.4.0
```

### Windows

Obraz je stejný jako pro Linux — Docker Desktop na Windows pouští linuxové kontejnery přes WSL2, takže žádná zvláštní úprava image není potřeba. Dvě věci se ale musí přizpůsobit: v `compose.yml` zakomentujte blok `devices:` (`/dev/dri` na Windows neexistuje, kontejner by se odmítl spustit) a cesty v `.env` (`DATA_PATH`, `DOWNLOAD_PATH`) směřujte do WSL, ne na `/mnt/c/...` — čtení a zápis přes hranici souborových systémů je znatelně pomalejší, což je u stahování a generování náhledů poznat. Akcelerace přes QuickSync na Windows nefunguje, překódování tedy poběží na procesoru; na běžném PC to vadí méně než na Celeronu v NASu.

## Kde leží data

Server si vedle stažených filmů drží vlastní data: účet, seznam doplňků, náhledy knihovny, statistiky a frontu stahování. Sídlí v `/data` a cestu k nim určuje `DATA_PATH`, ve výchozím stavu složka `data` vedle `compose.yml`.

Je to normální složka, ne skrytý svazek Dockeru — zálohujete ji zkopírováním a smazáním ji server vrátíte do stavu po instalaci (přijdete o účet a doplňky, stažené soubory zůstanou). Na Synology dává smysl ji dát do sdílené složky, ať je vidět ve File Stationu.

Instalace ze starších verzí držely data v pojmenovaném svazku `stremio-offline-data`. Přenést je jde přes SSH jedním příkazem — název svazku napoví `docker volume ls`:

```bash
docker run --rm -v stremio-offline_stremio-offline-data:/from -v /volume1/docker/stremio-offline/data:/to alpine sh -c 'cp -a /from/. /to/'
```

Bez SSH je jednodušší začít nanovo: doplňky přidáte znovu a stažené soubory zůstávají, protože leží mimo tuhle složku.

## Bezpečnost

Server nespouští kód doplňků, pouze čte jejich JSON API. Ve výchozím stavu blokuje manifesty a streamy směřující do privátní sítě. Pro vlastní LAN doplňky lze vědomě nastavit `ALLOW_PRIVATE_ADDONS=1`.

Přihlášení si zakládáte při prvním otevření, výchozí účet se nevytváří. Heslo se ukládá jen jako otisk (scrypt) a relace nese podepsanou známku; odhlášení všech zařízení vymění podpisové tajemství, takže dosud vydané známky rázem neplatí.

Zapomenuté heslo se dá obejít záložními údaji z prostředí: nastavte `ADMIN_USERNAME` a `ADMIN_PASSWORD`, přihlaste se jimi a heslo si v Nastavení změňte. Druhá možnost je smazat klíč `auth` ze souboru `state.json` v datovém svazku — server pak při dalším startu znovu nabídne založení účtu a doplňky ani knihovna se neztratí.

Používejte pouze zdroje a účty, ke kterým máte oprávněný přístup.
