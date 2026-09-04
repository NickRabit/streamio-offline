import { defineConfig, devices } from "@playwright/test";

const appPort = Number(process.env.APP_PORT ?? 8099);
const addonPort = Number(process.env.ADDON_PORT ?? 8098);
export const appUrl = `http://127.0.0.1:${appPort}`;
export const addonManifest = `http://127.0.0.1:${addonPort}/manifest.json`;

const storageState = "e2e/.tmp/session.json";

// Chosen to sit on either side of the breakpoints in web/src/style.css, which are
// 700px, 980px, a 780px height rule, and a landscape rule bounded by 980x500.
export const viewports = [
  { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
  { name: "desktop-short", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 760 } } },
  { name: "tablet", use: { ...devices["Desktop Chrome"], viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true } },
  { name: "mobile", use: { ...devices["iPhone 13"] } },
  { name: "mobile-landscape", use: { ...devices["iPhone 13 landscape"] } },
];

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
      // The journeys are about behaviour, not layout, so one viewport is enough.
      name: "chromium",
      testIgnore: [/setup\.spec\.ts/, /layout\//],
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState },
    },
    ...viewports.map(({ name, use }) => ({
      name,
      testMatch: /layout\//,
      dependencies: ["setup"],
      use: { ...use, storageState },
    })),
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
