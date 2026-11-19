import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  use: {
    baseURL: "http://127.0.0.1:3100",
    viewport: { width: 1440, height: 1000 },
    launchOptions: {
      channel:
        process.env.PLAYWRIGHT_USE_BUNDLED === "1" ? undefined : "chrome",
    },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node tests/mock-api.mjs",
      url: "http://127.0.0.1:4319/__test__/ready",
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "npm run dev -- --port 3100",
      url: "http://127.0.0.1:3100",
      reuseExistingServer: !process.env.CI,
      env: {
        NEXT_PUBLIC_API_BASE_URL: "http://127.0.0.1:4319",
        NEXT_PUBLIC_IDENTITY_PROJECT_ID: "harness-test",
        NEXT_PUBLIC_FIREBASE_API_KEY: "local-test-public-key",
        NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "harness-test.firebaseapp.com",
      },
    },
    {
      command: "npm --prefix ../admin run dev",
      url: "http://127.0.0.1:3101",
      reuseExistingServer: !process.env.CI,
      env: {
        INTERNAL_API_BASE_URL: "http://127.0.0.1:4319",
        ADMIN_APP_ORIGIN: "http://127.0.0.1:3101",
      },
    },
  ],
  reporter: "list",
});
