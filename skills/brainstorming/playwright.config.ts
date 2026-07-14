import { defineConfig, devices } from "@playwright/test";

declare const process: {
  env: Record<string, string | undefined>;
};

const scratchRoot = (
  process.env.CLAUDE_SCRATCH_DIR
  ?? `${process.env.HOME ?? "."}/.claude-scratch`
).replace(/\/$/u, "");
const outputRoot = `${scratchRoot}/my-claude-code/playwright`;
const chromium = {
  ...devices["Desktop Chrome"],
  browserName: "chromium" as const,
  headless: true,
};

export default defineConfig({
  testDir: "./e2e",
  outputDir: `${outputRoot}/results`,
  reporter: [
    ["line"],
    ["html", { outputFolder: `${outputRoot}/report`, open: "never" }],
  ],
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  use: {
    ...chromium,
    colorScheme: "light",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "e2e",
      testIgnore: [
        "**/*.visual.spec.ts",
        "**/*.performance.spec.ts",
        "**/accessibility-compatibility.spec.ts",
      ],
    },
    {
      name: "visual",
      testMatch: "**/*.visual.spec.ts",
    },
    {
      name: "a11y",
      testMatch: "**/accessibility-compatibility.spec.ts",
    },
    {
      name: "performance",
      testMatch: "**/*.performance.spec.ts",
      workers: 1,
    },
  ],
});
