# Follow-up: multiplatformní desktopová distribuce

## Shrnutí rozhodnutí

Vytvořit instalovatelnou aplikaci pro macOS, Windows a Linux se současnou
codebase je dobře proveditelné. Doporučený desktopový obal je **Electron**.
Současné React UI i Node.js/Express server mohou zůstat společné s Docker verzí;
platformně specifická bude hlavně práce se soubory, FFmpeg, hardwarová akcelerace,
životní cyklus aplikace a výroba instalačních balíčků.

Cílem je sdílet přibližně **90–95 % aplikačního kódu**. Půjde o nativně
instalovatelnou desktopovou aplikaci, ne o nativní AppKit/WinUI/GTK UI. Skutečně
nativní ovládací prvky by sdílení současného React UI výrazně omezily.

Funkční macOS prototyp je práce přibližně na jeden týden. Nepodepsané MVP pro
všechny tři systémy je realistické za 2–3 týdny. Vydatelná verze s ověřenou HW
akcelerací, podepisováním, notarizací a testováním spíše za 4–7 týdnů práce jednoho
vývojáře.

## Proč Electron

```text
Společné React UI
        │
Společný Express server a aplikační logika
        │
        ├── Docker → webové UI v běžném prohlížeči
        └── Electron → macOS / Windows / Linux
                          │
                          ├── nativní výběr složky
                          ├── platformní FFmpeg
                          └── start, ukončení a aktualizace aplikace
```

Electron je pro tento projekt praktičtější než Tauri:

- obsahuje Node.js runtime, takže současný server není nutné přepisovat ani
  balit do dalšího spustitelného souboru,
- na všech platformách používá Chromium, což snižuje rozdíly v přehrávání proti
  systémovým WebView,
- současné UI používá relativní `/api` adresy a lze ho načíst ze stejného
  loopback serveru bez rozvětvení celé API vrstvy,
- systémový výběr adresáře a další desktopové funkce lze bezpečně vystavit přes
  malé preload IPC rozhraní.

Tauri umí externí Node server spustit jako sidecar, ale bylo by nutné dodat
sidecar pro každou kombinaci OS a architektury, případně backend postupně
přepsat do Rustu. V tomto projektu by tím výrazně vzrostla složitost a hlavní
výhoda menšího instalačního balíčku by se zčásti ztratila.

Nevýhodou Electronu je větší instalační balík a nutnost pravidelně aktualizovat
Electron kvůli bezpečnostním opravám Chromia a Node.js.

## Navržené členění repozitáře

```text
web/                    společné React UI
server/                 společné API a aplikační logika
desktop/                Electron main process, preload a balení
  src/main.ts
  src/preload.ts
  resources/            FFmpeg/FFprobe podle platformy a architektury
packages/platform/      runtime konfigurace a platformní rozhraní
packages/media/         FFmpeg argumenty, probing a HW adaptéry (až se vyplatí oddělit)
```

`packages/*` není nutné zakládat předem. První refaktor může zůstat v `server/`;
samostatné balíčky mají smysl až ve chvíli, kdy se objeví druhá implementace
stejného rozhraní.

## Co může zůstat společné

- katalogy, metadata a komunikace se Stremio doplňky,
- vyhledávání, filtrování a řazení,
- fronta stahování, obnovení `.part` souborů a její perzistence,
- pojmenování a adresářová struktura médií,
- knihovna, historie, statistiky a oblíbené položky,
- Express API a jeho autentizace,
- React UI včetně přehrávače a `hls.js`,
- direct play, remux a většina plánování FFmpeg převodu,
- testy doménové logiky a API,
- formát `state.json`, `downloads.json` a `stats.json`.

Desktop-specific UI by mělo být omezené na několik podmíněných prvků, například
tlačítko **Vybrat složku**. Docker verze na stejném místě dál zobrazí cestu
nastavenou správcem kontejneru.

## Nutný refaktor současného serveru

Server je nyní modul s top-level inicializací a na konci se sám připojí na
`0.0.0.0:PORT`. Pro desktop je vhodné z něj udělat explicitně spouštěnou službu:

```ts
const runtime = await startServer({
  host: "127.0.0.1",
  port: 0,
  dataDir,
  downloadDir,
  ffmpegPath,
  ffprobePath,
  acceleration,
});

console.log(runtime.url);
await runtime.close();
```

Konkrétní změny:

1. Přesunout inicializaci Expressu, store, fronty a playback manageru do
   `startServer(config)`.
2. Vrátit skutečný port přidělený systémem. Hodnota musí být předána i interním
   FFmpeg/FFprobe HTTP požadavkům; nestačí současné čtení `process.env.PORT`.
3. V Dockeru zachovat `host: 0.0.0.0` a port 8080, v desktopu vždy použít
   `127.0.0.1` a náhodný volný port.
4. Nahradit spouštění názvů `ffmpeg` a `ffprobe` explicitními cestami z runtime
   konfigurace.
5. Doplnit řízené `close()`: přestat přijímat HTTP požadavky, pozastavit aktivní
   stahování, atomicky uložit frontu, ukončit všechny FFmpeg procesy a uklidit
   playback relace.
6. Přesunout globální `unhandledRejection` a `uncaughtException` handlery z
   aplikačního serveru do konkrétního entrypointu, aby se v Electron procesu
   neregistrovaly opakovaně.
7. Zachovat současný Docker entrypoint jako tenkou vrstvu volající stejný
   `startServer()`.

Server lze provozovat přímo v Node části Electronu nebo v odděleném utility
procesu. Pro první prototyp je jednodušší oddělený proces: chyba serveru neshodí
desktopové okno a ukončení lze jednoznačně řídit. Až měření ukáže problém, lze
zvážit běh ve stejném procesu.

## Výběr a změna lokální složky

Desktop při prvním spuštění nabídne systémový dialog pro výběr adresáře. Cestu
uloží do malé desktopové konfigurace v uživatelském datovém adresáři:

| Prostředí | Aplikační data | Média |
|---|---|---|
| Docker | `/data` | `/downloads` volume |
| macOS | `Application Support/Stremio Offline` | vybraná složka |
| Windows | `%APPDATA%/Stremio Offline` | vybraná složka |
| Linux | XDG data directory | vybraná složka |

Renderer nesmí dostat obecný přístup k filesystemu ani celé Electron IPC.
Preload vystaví pouze úzké metody typu:

```ts
window.desktop?.chooseDownloadDirectory();
window.desktop?.getPlatformInfo();
```

Electron okno musí běžet s `nodeIntegration: false`, `contextIsolation: true` a
sandboxem. Je také potřeba zakázat neočekávanou navigaci a otevírání nových oken.

Download root je dnes zafixovaný při konstrukci fronty a na několika místech v
serveru. Nejbezpečnější první implementace změny složky proto je:

1. pozastavit aktivní úlohy,
2. zavřít lokální server,
3. uložit novou cestu,
4. server znovu spustit,
5. obnovit UI.

Přepínání kořene knihovny bez restartu lze doplnit později. Je nutné předem
rozhodnout, zda při změně složky zůstane jedna společná fronta, nebo bude každá
složka představovat samostatnou knihovnu. Pro MVP je vhodná jedna zvolená složka
a explicitní upozornění, že staré soubory se automaticky nepřesouvají.

## Hardwarová akcelerace

Je potřeba oddělit dvě nezávislé vrstvy.

### 1. Direct-play dekódování v UI

Video přehrává Chromium uvnitř Electronu. GPU akcelerace renderingu a podporované
kodeky se zjišťují za běhu. Současný `MediaSource.isTypeSupported()` mechanismus
lze zachovat, ale nelze předpokládat, že každý systém zvládne HEVC/AV1 jen proto,
že má vhodnou grafickou kartu. Záleží také na OS, ovladači a sestavení Chromia.
Když kodek přehrát nejde, server zvolí remux nebo transcode stejně jako dnes.

V diagnostice aplikace má být vidět:

- stav GPU procesu Chromia,
- detekované direct-play kodeky,
- zvolený playback režim,
- použitý FFmpeg enkodér a případný fallback.

### 2. Překódování ve FFmpeg

Současná implementace je specializovaná na VAAPI a H.264. Je vhodné zavést
rozhraní, které vrátí otestovaný plán argumentů místo větvení celého playback
manageru podle operačního systému:

```ts
interface HardwareEncoder {
  name: "videotoolbox" | "qsv" | "nvenc" | "amf" | "vaapi";
  probe(): Promise<HardwareCapabilities>;
  videoArgs(options: TranscodeOptions): string[];
}
```

Preferované pořadí:

| Platforma | Detekce a fallback |
|---|---|
| Docker / NAS | VAAPI → software |
| macOS | VideoToolbox → software |
| Windows | QSV → NVENC → AMF → software |
| Linux desktop | VAAPI → QSV → software |

Samotná přítomnost enkodéru ve výpisu FFmpeg nestačí. Stejně jako současné VAAPI
ověření má každý kandidát při startu skutečně zakódovat krátký testovací obraz.
Zvlášť je vhodné ověřit:

- dekódování,
- upload/download snímků mezi CPU a GPU,
- scaling,
- H.264 encoding,
- cílový bitrate versus constant-quality režim.

Přibalená FFmpeg binárka nenahrazuje systémový GPU ovladač, takže softwarový
fallback musí zůstat vždy dostupný. FFmpeg buildy pro jednotlivé platformy musí
mít doložený původ, kontrolní součty a jasné LGPL/GPL distribuční podmínky.

UI nesmí natvrdo zobrazovat `VAAPI`; má zobrazovat obecné `HW` nebo konkrétní
enkodér vrácený serverem.

## Balení FFmpeg

Každý release artefakt ponese odpovídající `ffmpeg` a `ffprobe`:

```text
macOS arm64       ffmpeg/ffprobe arm64 s VideoToolbox
macOS x64         ffmpeg/ffprobe x64 s VideoToolbox
Windows x64       ffmpeg.exe/ffprobe.exe s QSV, NVENC a AMF
Linux x64         ffmpeg/ffprobe s VAAPI a QSV
Linux arm64       až podle skutečné poptávky a dostupných ovladačů
```

Pro první verzi je jednodušší vydávat samostatné macOS arm64 a x64 balíčky než
universal aplikaci. Universal Electron bez universal FFmpeg stejně potřebuje
vybrat správnou binárku za běhu a balík zbytečně naroste.

Binárky musí být umístěné mimo ASAR nebo z něj při balení explicitně rozbalené,
protože operační systém musí spustit skutečný soubor. Před releasem se ověří
`ffmpeg -version`, seznam potřebných enkodérů a krátký softwarový encode test.

## Společný build a release pipeline

Z pohledu vývojáře může existovat jeden vstupní příkaz, například:

```bash
npm run release
```

Ten spustí společné testy a CI workflow s platformní matrix. Neznamená to ale,
že jeden lokální stroj bezpečně vytvoří a podepíše všechny výsledné balíky.

```text
test (Linux)
   ├── Docker amd64/arm64
   ├── Linux x64 → AppImage + DEB
   ├── Windows x64 → NSIS installer
   ├── macOS arm64 → DMG/ZIP + podpis + notarizace
   └── macOS x64   → DMG/ZIP + podpis + notarizace
```

macOS artefakty se musí sestavit a podepsat na macOS runneru. Windows instalátor
je vhodné stavět na Windows runneru, i když část nástrojů umí cross-build přes
Wine. Tím se omezí překvapení kolem podpisu, nativních závislostí a FFmpeg
binárek.

Kořenový `package.json` bude mít workspaces `server`, `web` a `desktop`. Pořadí
release buildu:

1. `npm ci`, TypeScript kontrola a všechny testy,
2. jeden produkční build `web/`,
3. build `server/` a `desktop/`,
4. vložení platformního FFmpeg,
5. smoke test zabalené aplikace,
6. podpis/notarizace,
7. publikace artefaktů a kontrolních součtů.

Docker workflow zůstane samostatným cílem, ale sdílí stejný testovací job a
stejný sestavený web/server. Nemá se z desktopového balíku zpětně vyrábět Docker
image ani naopak.

## Podepisování a aktualizace

Pro běžnou distribuci je potřeba:

- macOS Developer ID podpis a notarizace; bez nich Gatekeeper uživatele výrazně
  odrazuje nebo aplikaci zablokuje,
- Windows code-signing certifikát; bez něj bude SmartScreen při malém počtu
  instalací varovat,
- Linux AppImage a DEB; případně RPM až podle poptávky,
- oddělit aktualizaci aplikace od perzistentních dat a rozpracovaných downloadů.

Automatické aktualizace lze pro macOS a Windows doplnit po stabilizaci balíčků.
Na Linuxu je vhodné nejdřív spoléhat na nový AppImage nebo systémový balíčkovací
mechanismus. Aktualizace se nesmí instalovat během aktivního stahování nebo
přehrávání bez výslovného souhlasu uživatele.

## Bezpečnost desktopové varianty

- Server poslouchá výhradně na `127.0.0.1`, nikdy na LAN rozhraní.
- Použije náhodný port a interní náhodný token známý desktopovému procesu.
- Současné přihlášení lze v první verzi zachovat; není nutné kvůli desktopu
  vytvářet druhou autentizační větev.
- Renderer nedostane Node.js ani obecný filesystem/shell přístup.
- IPC kontroluje odesílatele a přijímá pouze konkrétní, validované operace.
- Neočekávaná navigace a `window.open` se blokují; externí odkazy se otevírají až
  po validaci protokolu.
- Aplikace musí pravidelně aktualizovat Electron, protože s ní distribuuje vlastní
  Chromium a Node.js.

## Etapy implementace

### 1. Runtime refaktor

- vytvořit `startServer(config)` a `close()`,
- odstranit pevné předpoklady o Docker cestách, portu a FFmpeg v `PATH`,
- přidat testy startu na portu 0 a korektního ukončení,
- zachovat stávající Docker chování a datový formát.

### 2. Vertikální macOS prototyp

- přidat `desktop` workspace,
- spustit server pouze na loopbacku,
- otevřít současné UI bez jeho forku,
- přidat výběr download složky,
- přibalit FFmpeg/FFprobe pro Apple Silicon,
- ověřit direct play, remux, transcode, seek a jedno stažení.

### 3. Multiplatformní balíčky

- macOS x64,
- Windows x64 s NSIS,
- Linux x64 AppImage a DEB,
- otestovat mezery, diakritiku, dlouhé cesty, síťové disky a rozdíly filesystemů,
- ověřit obnovení fronty po pádu a restartu aplikace.

### 4. HW adaptéry

- VideoToolbox,
- QSV, NVENC a AMF,
- desktopové VAAPI/QSV,
- jednotný report schopností a bezpečný software fallback,
- testy na skutečném hardwaru, ne pouze v CI virtuálních strojích.

### 5. Produkční distribuce

- podpisy, notarizace a checksums,
- release workflow a verzování,
- smoke test nainstalované aplikace,
- následně automatické aktualizace.

## Realistický odhad

Odhad předpokládá jednoho vývojáře obeznámeného se současnou codebase:

| Oblast | Odhad |
|---|---:|
| Refaktor serveru a runtime konfigurace | 2–4 dny |
| Electron shell, preload, konfigurace a výběr složky | 2–3 dny |
| Přibalení FFmpeg pro platformy a architektury | 2–4 dny |
| VideoToolbox/QSV/NVENC/AMF/VAAPI adaptéry | 5–10 dní |
| CI matrix a instalační balíčky | 3–5 dní |
| Podpisy, notarizace a aktualizace | 3–7 dní |
| Testování na skutečných OS a GPU | 4–8 dní |

Milníky:

- **macOS prototyp:** 4–7 pracovních dní,
- **nepodepsané MVP pro macOS, Windows a Linux:** 10–15 pracovních dní,
- **vydatelná verze:** 20–35 pracovních dní,
- **širší GPU matice a automatické aktualizace:** podle dostupného hardwaru další
  přibližně týden.

Největší nejistota není Electron ani React, ale dostupnost a chování konkrétních
FFmpeg sestavení a GPU ovladačů na Windows a Linuxu.

## Doporučený první krok

Začít malým vertikálním řezem pro macOS Apple Silicon:

1. `startServer({ host: "127.0.0.1", port: 0, ... })`,
2. Electron okno se současným React UI,
3. výběr a zapamatování download složky,
4. přibalený FFmpeg/FFprobe,
5. VideoToolbox probe se softwarovým fallbackem,
6. integrační test přehrání, seeku, stažení a restartu aplikace.

Tento řez ověří všechny důležité hranice architektury. Teprve potom má smysl
rozšířit build matrix o Windows/Linux a investovat do jejich GPU adaptérů.
