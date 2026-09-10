# Addons and downloads

## Adding an addon

In **Addons**, paste a full `manifest.json` URL. A catalog manifest supplies
movies, series, and metadata. A source manifest supplies streams or subtitles.
One manifest can do both.

On first start the official **Cinemeta** (catalog and metadata) and
**OpenSubtitles v3** (subtitles) addons are installed. They can be disabled or
removed; after a deliberate removal they are not restored on restart.

### Real-Debrid and other debrid services

Personalized addon URLs configured for Real-Debrid still work: if the addon
already returns HTTPS, the app plays and downloads it like any other HTTP
stream. The sensitive part of the URL is hidden after you save it.

A raw torrent (`infoHash` or magnet, no HTTP URL) needs an API token in
**Settings → Real-Debrid**. The token is verified against a premium account
before it is stored, hidden in the UI, and treated as a secret in the backup.
The app never runs a torrent engine. Real-Debrid fetches the torrent on its
servers; this app then pulls the unrestricted HTTPS file through the existing
queue.

- **To library** on a torrent creates a waiting job (`Čeká na Real-Debrid`).
  That is what starts caching on Real-Debrid. When they report the file
  downloaded, the job becomes a normal HTTP download — no second click.
  Waiting jobs do not take an HTTP slot.
- **Play** and **To device** stay off for a raw torrent. They would only kick
  off caching and then fail. Play the file from the library once it has landed.
- Without a token, torrent rows are hidden and the empty list points at
  Settings.

AllDebrid, Premiumize, and scraping the token out of a Torrentio URL are out
of scope.

## The download queue

The queue survives a restart, resumes a `.part` file with HTTP Range, and
supports pause, resume, retry, reorder, remove, and 1–8 concurrent downloads.
Removing a finished job from history does not delete the file.

A source that dies mid-transfer is retried from the partial file; a full disk
pauses the whole queue and starts it again when space is free. Once a transfer
is moving again, the retry budget is restored.

**Settings** choose how many files download at once overall and how many from
one source. Providers usually cap concurrent connections and kill or starve the
extras, so one transfer per source is the safest default.

### Seasons and whole shows

Downloading a season or a whole show opens a selection dialog. Choose one or
more stream addons and arrange them in priority order, then select the required
audio language and an optional fallback. Subtitles can be disabled, preferred,
or required, with their own language and fallback.

Each episode enters the queue as a small rule rather than a preselected URL.
Only when that episode reaches the front does the queue ask the selected addons
for current streams and inspect the real audio and text-subtitle tracks. A
primary-language match anywhere in the chosen sources wins over a fallback
match; addon order decides between otherwise equivalent matches. Unknown or
missing audio metadata is not treated as a match.

Optional subtitles never prevent a matching video from downloading. Required
subtitles make the queue try another source when neither a usable embedded
track nor an external subtitle from an addon is available. External SRT and
WebVTT subtitles are saved as a language-tagged `.vtt` sidecar next to the
video. The queue shows the resolved languages and whether a fallback was used.

### Segmented downloads

One file can also be pulled over several connections at once, each fetching its
own byte range. **Settings → Segments per file** sets how many; the default is
2, and 1 turns the split off.

A file is split only when the source answers a range request with `206` and the
full size, and only while every part stays at least 16 MiB — anything else falls
back to a single stream. The plan is part of the queue state, so a pause, a
restart, or a dropped connection resumes each part at its own offset. While a
file is split, the `.part` on disk already has the final size.

Segments multiply the connections a provider sees: `concurrent per source ×
segments`. Raise them only for a provider that tolerates it — one that does not
answers `429` or drops the extra connections, and the transfer then spends its
retry budget instead of going faster.

## To library vs. to device

The selected source and the player offer two destinations:

- **To library** (`Do knihovny`) adds the file to the server queue and it lands
  under `DOWNLOAD_PATH`.
- **To device** (`Do zařízení`) starts a native download in the current browser.

Individual library files can also be downloaded from their context menu.

External streams always pass through the server proxy: the browser talks only to
Stremio Offline, and the provider URL is never placed in the download link.
Filenames follow the same rules as library downloads.

## Where files are saved

In **Addons**, each stream addon can set where movies and series are saved. The
host directory is `DOWNLOAD_PATH`; the addon card takes only a relative
subdirectory inside it. An empty subdirectory means `DOWNLOAD_PATH` itself;
nested paths such as `Webshare/Movies` work.

| Mode | Result |
| --- | --- |
| Structured | A folder named after the movie, or show and season folders for a series. |
| Flat | Straight into the chosen subdirectory: `Movie.mkv`, `Show - S01E07 - Episode title.mkv`. |

The change applies to newly queued items.

## Backing up the configuration

**Settings** can export the configuration to JSON and import it later. The backup
holds app settings, installed addon order and state, and their save rules. It
does **not** hold the account, the library, or watch history.

Personalized addon URLs and the Real-Debrid API token are stored in the file in
the clear — treat it as a password. Import replaces the current configuration
and re-checks every manifest before saving.

## Queue browsing

The queue displays 20, 50 or 100 jobs per page. Filters and sorting are collapsed
by default; the summary indicates active filters and a custom sort order.
On narrow phones, each job keeps its path and timestamps under Details. Long
titles wrap to two lines, with the full title available when Details is expanded. Search matches titles and paths;
status and inclusive local-date filters can be combined. Dates can refer to
when a job was added, first started or completed. Sorting changes the view only;
priority arrows are enabled in ascending queue-priority order.

New downloads persist their first start and successful completion timestamps.
Elapsed time is the interval between them, including pauses and retry waits.
Older jobs without these timestamps display a dash and are excluded from filters
that require the missing date. Missing values sort last in either direction.
Pagination limits rendered rows; the live queue snapshot still contains all jobs.
