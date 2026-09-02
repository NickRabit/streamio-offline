# Follow-up: multiplatformní distribuce

## Cíl

Zachovat jednu společnou codebase a aplikaci vydávat ve čtyřech podobách:

- Docker image pro NAS, server a webové použití,
- nativně instalovatelná aplikace pro macOS,
- nativně instalovatelná aplikace pro Windows,
- desktopová aplikace pro Linux.

Desktopové varianty nemají vyžadovat Docker, systémový Node.js ani samostatnou instalaci FFmpegu.

## Doporučená architektura

Jako desktopový obal použít Electron. Současné React UI i Node.js server tak mohou zůstat společné pro všechny platformy.

```text
Společné React UI
        │
Společný Node.js server a aplikační logika
        │
        ├── Docker → webové UI v prohlížeči
        └── Electron → macOS / Windows / Linux
```

Navrhované členění monorepa:

```text
web/                 společné React UI
server/              společné API a běhová vrstva
desktop/             Electron main process a instalátory
packages/core/       sdílená doménová logika, až bude oddělení účelné
packages/platform/   rozhraní a adaptéry platformních funkcí
```

Electron má proti Tauri výhodu v přímém využití současného Node.js serveru. Tauri by vyžadovalo Node sidecar nebo postupný přepis backendu do Rustu.

## Co zůstane společné

- katalogy, metadata a Stremio doplňky,
- vyhledávání, filtrování a řazení,
- fronta stahování a její perzistence,
- pojmenování a adresářová struktura médií,
- knihovna, historie a oblíbené položky,
- aplikační API,
- React UI a přehrávač,
- převážná část práce s FFmpeg/FFprobe,
- testy doménové logiky a API.

Cílem je udržet přibližně 90–95 % kódu společných.

## Platformní adaptéry

| Oblast | Docker / Linux server | macOS desktop | Windows desktop | Linux desktop |
|---|---|---|---|---|
| FFmpeg | součást image | přibalená binárka | přibalené `.exe` | přibalená binárka |
| HW akcelerace | VAAPI / QSV | VideoToolbox | QSV / NVENC / AMF | VAAPI / QSV |
| Výběr složky | cesta z konfigurace | systémový dialog | systémový dialog | systémový dialog |
| Data aplikace | `/data` | Application Support | AppData | XDG data directory |
| Média | Docker volume | uživatelem vybraná složka | uživatelem vybraná složka | uživatelem vybraná složka |
| Distribuce | multiarch image | `.dmg` | `.exe` | AppImage / DEB |

Desktopová aplikace spustí společný server pouze na loopback adrese a náhodném volném portu. Electron okno načte stejné webové UI. Při ukončení aplikace musí korektně zastavit server, přehrávací relace a FFmpeg procesy, ale zachovat stahovací frontu pro další spuštění.

## Navržené etapy

### 1. Oddělení běhového prostředí

- odstranit pevné předpoklady o Docker cestách,
- zavést rozhraní pro datový adresář, adresář médií a binárky FFmpeg,
- oddělit platformní detekci HW akcelerace,
- zachovat kompatibilní formát uloženého stavu.

### 2. Electron prototyp pro macOS

- přidat `desktop` workspace,
- spouštět a ukončovat lokální Node server,
- otevřít současné UI v Electron okně,
- přidat systémový výběr složky,
- přibalit FFmpeg a FFprobe pro Apple Silicon a Intel,
- ukládat nastavení do Application Support.

### 3. Windows a Linux

- přibalit platformní FFmpeg binárky,
- vytvořit Windows instalátor,
- vytvořit AppImage a případně DEB,
- ověřit dlouhé cesty, názvy souborů a rozdíly souborových systémů,
- otestovat obnovení fronty po pádu a restartu.

### 4. Hardwarová akcelerace

- macOS: VideoToolbox,
- Windows: preferovat QSV, poté NVENC nebo AMF,
- Linux: VAAPI/QSV,
- vždy zachovat bezpečný softwarový fallback,
- při startu provést krátký funkční test dostupného enkodéru.

### 5. Distribuce

- GitHub Actions pro sestavení všech artefaktů,
- Docker image pro `linux/amd64` a `linux/arm64`,
- macOS build pro `arm64` a `x64`, případně universal binary,
- Windows x64 build; ARM64 až podle potřeby,
- podepisování a notarizace macOS aplikace,
- podepisování Windows instalátoru,
- později automatické aktualizace.

## Rizika a rozhodnutí

- Přibalené FFmpeg buildy musí mít jasnou licenci a odpovídající distribuční podmínky.
- HW akcelerace se mezi platformami výrazně liší a musí mít softwarový fallback.
- Electron zvětší instalační balíček přibližně o stovky MB, ale výrazně sníží množství rozdílného kódu.
- Desktop server nesmí naslouchat na veřejném rozhraní a má používat interní autentizaci nebo IPC ochranu.
- Aktualizace nesmí přerušit aktivní stahování ani poškodit perzistentní frontu.
- Migrace dat mezi Docker a desktop variantou může být doplněna později exportem/importem konfigurace.

## Hrubý odhad

- základ desktopové architektury a první macOS build: 3–5 dní,
- Windows a Linux balíčky: 4–7 dní,
- platformní FFmpeg a HW akcelerace: přibližně 1 týden,
- podepisování, aktualizace a důkladné testování: 1–2 týdny.

Funkční multiplatformní MVP lze očekávat přibližně za 1–2 týdny. Uhlazená vydatelná verze se všemi instalátory, aktualizacemi a ověřenou HW akcelerací spíše za 3–5 týdnů.

## Doporučený první krok

Nejdříve vytvořit Electron prototyp pro macOS bez změny UI. Jeho cílem bude ověřit spuštění společného serveru, přibalený FFmpeg, výběr složky a přehrání i stažení jednoho streamu. Teprve po ověření tohoto vertikálního řezu má smysl doplnit Windows/Linux balíčky a hardwarové adaptéry.
