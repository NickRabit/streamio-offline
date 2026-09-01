# Plán dalších úprav

Zásobník námětů. Není to závazek ani pořadí sprintů, jen dohodnutá priorita.

## Cílová platforma: Synology s Intel Celeronem

Ověřený stav, ne odhad:

- Image se staví pro amd64 včetně Intel ovladačů (`intel-media-va-driver` pro novější
  iGPU, `i965-va-driver` pro starší). Přechod základu na `node:22-trixie-slim` je
  nepoškodil.
- **QuickSync se zapíná override souborem**, ne úpravou `compose.yml`:
  `docker compose -f compose.yml -f compose.synology.yml up -d --build`.
  GID render nodu se zjistí přes `stat -c "%g" /dev/dri/renderD128` a nastaví v `.env`
  jako `RENDER_GID`. Podrobnosti v README.
- Celerony v DS220+/DS920+ (Gemini Lake J4025/J4125) umí hardwarově dekódovat HEVC
  a enkódovat H.264, takže s akcelerací zvládnou i skutečné překódování.
- Bez akcelerace: přímé přehrání i remux jedou naplno, protože kopírování nic nestojí,
  a to je většina přehrávání. Softwarové překódování 1080p ale Celeron nemusí stíhat
  v reálném čase; 480p a 720p ano.
- Stahování, katalogy a fronta jsou I/O záležitost, tam výkon nehraje roli.

## 1. Lokální knihovna: přehrávání stažených souborů

Největší díra vzhledem k názvu projektu. Stažené soubory leží v `/downloads`, ale
z aplikace je nelze přehrát. Stránka **Knihovna** procházející stažené filmy a seriály
s přehráváním přímo ze souboru: direct play z disku znamená okamžitý posun po časové
ose bez FFmpegu a funguje i bez internetu.

Fronta už zná strukturu (seriál, série, epizoda) a soubory se ukládají do složek podle
titulu, takže se knihovna dá postavit nad existujícím rozvržením složek.

## 2. Pokračovat ve sledování

Ukládat pozici přehrávání na server (titul a čas, stačí do `state.json`) a na katalogu
ukázat řádek **Rozkoukané** s obnovením pozice. Malá práce, velký posun v použitelnosti;
Stremio i Netflix to mají jako první věc na úvodní obrazovce.

## 3. Automatické stahování nových epizod

Volba **Sledovat seriál**. Server jednou denně zkontroluje nové epizody přes metadata
a přidá je do fronty jako líné úlohy. Infrastruktura (líné úlohy, záložní zdroje) už
existuje, chybí plánovač a seznam sledovaných seriálů.

## 4. Vyhledávání

- Živé hledání s odkladem zhruba 400 ms místo tlačítka.
- Historie posledních hledání.
- Našeptávání z už načtených katalogů.
- Volitelně řadit výsledky podle shody názvu místo pořadí doplňků.

## 5. Fronta stahování

- Naplánované stahování, například jen v noci. Na NASu praktické.
- Omezení rychlosti.
- Upozornění po dokončení fronty.
- Automatické mazání zhlédnutého, navazuje na bod 2.

## Známé mezery mimo tento seznam

- **Vystavení ven** patří za reverzní proxy s HTTPS. Přihlášení existuje, ale po HTTP
  jde cookie po síti nechráněná; `Secure` se nastaví samo, jakmile server uvidí HTTPS.
- **Torrenty bez debrid služby** nelze stáhnout: doplněk, který vrátí jen `infoHash`,
  je pro aplikaci nepoužitelný.
- **Testy pokrývají jen serverovou stranu.** Řazení a filtrování zdrojů ve `web/src/streams.ts`
  je ověřené proti reálným datům ručně, ale automatický test pro workspace `web` chybí.
