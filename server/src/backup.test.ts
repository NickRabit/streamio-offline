import assert from "node:assert/strict";
import test from "node:test";
import { createSettingsBackup, parseSettingsBackup } from "./backup.js";
import { defaultDownloadSettings } from "./naming.js";
import { defaultSettings } from "./store.js";

test("záloha zachová nastavení, pořadí a citlivou URL doplňku", () => {
  const settings = { ...defaultSettings(), concurrentDownloads: 4, audioLanguage: "sk" };
  const backup = createSettingsBackup(settings, [{
    key: "secret-key", manifestUrl: "https://example.com/token/abc/manifest.json", role: "source", enabled: false,
    addedAt: "2026-01-01T00:00:00.000Z", downloadSettings: defaultDownloadSettings(),
    manifest: { id: "one", name: "One", version: "1" },
  }]);
  assert.equal(backup.settings.concurrentDownloads, 4);
  assert.equal(backup.addons[0].manifestUrl, "https://example.com/token/abc/manifest.json");
  assert.equal("key" in backup.addons[0], false);
  assert.equal("manifest" in backup.addons[0], false);
  assert.deepEqual(parseSettingsBackup(backup).addons, backup.addons);
});

test("import odmítne cizí formát a normalizuje hodnoty", () => {
  assert.throws(() => parseSettingsBackup({ format: "other", version: 1, settings: {}, addons: [] }), /podporovaná záloha/);
  const parsed = parseSettingsBackup({
    format: "stremio-offline-settings", version: 1, settings: { concurrentDownloads: 99, artworkLocation: "elsewhere" },
    addons: [{ manifestUrl: "https://example.com/manifest.json", role: "both", enabled: true, downloadSettings: {} }],
  });
  assert.equal(parsed.settings.concurrentDownloads, 8);
  assert.equal(parsed.settings.artworkLocation, "data");
  assert.deepEqual(parsed.addons[0].downloadSettings, defaultDownloadSettings());
});
