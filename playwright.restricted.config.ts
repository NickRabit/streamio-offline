import { defineConfig, devices } from "@playwright/test";

const appPort = Number(process.env.RESTRICTED_APP_PORT ?? 8199);
const addonPort = Number(process.env.ADDON_PORT ?? 8098);
export const appUrl = `http://127.0.0.1:${appPort}`;

export default defineConfig({
  testDir: "e2e/tests",
  testMatch: /restricted\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["html", { open: "never" }], ["list"]] : "list",
  use: { baseURL: appUrl, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    {
      name: "restricted",
      use: { ...devices["Desktop Chrome"] },
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
      command: "node e2e/fixtures/restricted-server.mjs",
      url: `${appUrl}/api/status`,
      reuseExistingServer: false,
      stdout: "pipe",
      env: {
        ...process.env,
        RESTRICTED_APP_PORT: String(appPort),
        ADDON_PORT: String(addonPort),
      },
    },
  ],
});
