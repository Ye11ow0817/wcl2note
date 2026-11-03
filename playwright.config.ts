import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/electron",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  reporter: "list",
});
