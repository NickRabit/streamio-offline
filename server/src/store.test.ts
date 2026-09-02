import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Store } from "./store.js";
import type { AddonRecord } from "./types.js";

const legacyAddon = () => ({
  key: "provider-1", manifestUrl: "https://example.com/manifest.json", role: "source" as const,
  enabled: true, addedAt: "2026-01-01T00:00:00.000Z", manifest: { id: "test", name: "Test", version: "1" },
});

const addon = (downloadSettings: AddonRecord["downloadSettings"]): AddonRecord => ({
  ...legacyAddon(), downloadSettings,
});

test("starý stav doplňku se migruje na výchozí ukládání", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-store-"));
  try {
    await writeFile(path.join(directory, "state.json"), JSON.stringify({ addons: [legacyAddon()], defaultsInstalled: true, settings: {} }));
    const store = new Store(directory); await store.load();
    assert.deepEqual(store.addons()[0].downloadSettings, {
      movie: { subfolder: "", layout: "structured" }, series: { subfolder: "", layout: "structured" },
    });
    assert.equal(store.settings().catalogTileSize, "medium");
    assert.equal(store.settings().libraryTileSize, "medium");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("vlastní pravidla doplňku přežijí uložení a nové načtení", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stremio-store-"));
  try {
    const first = new Store(directory); await first.load();
    await first.update((state) => state.addons.push(addon({
      movie: { subfolder: "Webshare/Filmy", layout: "flat" },
      series: { subfolder: "Webshare/Seriály", layout: "structured" },
    })));
    const second = new Store(directory); await second.load();
    assert.deepEqual(second.addons()[0].downloadSettings, {
      movie: { subfolder: "Webshare/Filmy", layout: "flat" },
      series: { subfolder: "Webshare/Seriály", layout: "structured" },
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
