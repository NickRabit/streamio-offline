# Addons and downloads

## Adding an addon

In **Addons**, paste a full `manifest.json` URL. A catalog manifest supplies
movies, series, and metadata. A source manifest supplies streams or subtitles.
One manifest can do both.

On first start the official **Cinemeta** (catalog and metadata) and
**OpenSubtitles v3** (subtitles) addons are installed. They can be disabled or
removed; after a deliberate removal they are not restored on restart.

### Real-Debrid and other debrid services

Personalized addon URLs configured for Real-Debrid work. The sensitive part of
the URL is hidden after you save it. If the addon already returns a resolved
HTTPS address, it can be played and downloaded.

Resolving a raw `infoHash` through the Real-Debrid API is **not** built in, and
there is no built-in debrid account setting — configure that in the addon's own
manifest URL.

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

Personalized addon URLs may contain access tokens — treat the file as a
password. Import replaces the current configuration and re-checks every manifest
before saving.
