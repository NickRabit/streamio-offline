import { defineConfig, devices } from "@playwright/test";

const appPort = Number(process.env.APP_PORT ?? 8099);
const addonPort = Number(process.env.ADDON_PORT ?? 8098);
export const appUrl = `http://127.0.0.1:${appPort}`;
export const addonManifest = `http://127.0.0.1:${addonPort}/manifest.json`;

const storageState = "e2e/.tmp/session.json";

export default defineConfig({
  testDir: "e2e/tests",
  // The fixture stack is a single server with a single state file, so the specs
  // share it and must not run against it at the same time.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["html", { open: "never" }], ["list"]] : "list",
  use: { baseURL: appUrl, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "setup", testMatch: /setup\.spec\.ts/ },
    {
      name: "chromium",
      testIgnore: /setup\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState },
    },
  ],
  webServer: [
    {
      command: "node e2e/fixtures/addon-server.mjs",
      url: `http://127.0.0.1:${addonPort}/manifest.json`,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
    },
    {
      command: "node e2e/fixtures/app-server.mjs",
      url: `${appUrl}/api/status`,
      reuseExistingServer: false,
      stdout: "pipe",
    },
  ],
});
