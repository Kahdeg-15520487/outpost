import { defineConfig, devices } from "@playwright/test";

/**
 * The responsive suite: Playwright, one project per device class, functional layout assertions plus
 * pixel snapshots. Two layers, on purpose:
 *
 *   layout.spec.ts   structural truth — what is visible at which breakpoint, nothing overflows, no
 *                    screen scrolls sideways, the app fills the window. Runs everywhere, on every
 *                    project; this is the layer that catches logic bugs.
 *   visual.spec.ts   `toHaveScreenshot()` baselines, one per project and platform. Catches everything
 *                    nobody thought to assert. Baselines are per platform (font rendering differs),
 *                    so they are opt-in: RESPONSIVE_SNAPSHOTS=1.
 *
 *   pnpm test:responsive                 the whole suite (visual skipped unless enabled)
 *   pnpm test:responsive:update          re-take the baselines — review the diff before committing
 *   pnpm test:responsive --project=phone one device
 *
 * The instance under test is hermetic: packages/server/test/responsive/fixture.ts writes its own
 * config (offline demo model, no providers), uses a throwaway data dir and seeds a small workspace.
 */
const PORT = Number(process.env.PORT ?? 4599);
const baseURL = `http://127.0.0.1:${PORT}`;
const state = "packages/server/test/responsive/.auth.json";

export default defineConfig({
	testDir: "packages/server/test/responsive",
	testMatch: /.*\.spec\.ts|auth\.setup\.ts/,
	// {platform} keeps a Windows baseline and a Linux baseline apart instead of overwriting each other.
	snapshotPathTemplate: "{testDir}/__snapshots__/{projectName}/{platform}/{testFilePath}/{arg}{ext}",
	fullyParallel: false,
	workers: 1,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	timeout: 45_000,
	expect: {
		timeout: 10_000,
		toHaveScreenshot: {
			// Anti-aliasing jitter only; a real layout change moves far more than 2% of the pixels.
			maxDiffPixelRatio: 0.02,
			animations: "disabled",
			caret: "hide",
			scale: "css",
		},
	},
	reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
	use: { baseURL, trace: "retain-on-failure" },
	webServer: {
		command: "pnpm --filter @outpost/web build && node --import tsx test/responsive/fixture.ts",
		cwd: "packages/server",
		url: `${baseURL}/api/me`,
		reuseExistingServer: !process.env.CI,
		timeout: 240_000,
		stdout: "pipe",
		stderr: "pipe",
		env: { PORT: String(PORT) },
	},
	projects: [
		{ name: "setup", testMatch: /auth\.setup\.ts/, use: { ...devices["Desktop Chrome"] } },
		{
			name: "desktop",
			dependencies: ["setup"],
			testIgnore: /auth\.setup\.ts/,
			use: { ...devices["Desktop Chrome"], browserName: "chromium", viewport: { width: 1440, height: 900 }, storageState: state },
		},
		{
			name: "laptop",
			dependencies: ["setup"],
			testIgnore: /auth\.setup\.ts/,
			use: { ...devices["Desktop Chrome"], browserName: "chromium", viewport: { width: 1024, height: 768 }, storageState: state },
		},
		{
			name: "tablet",
			dependencies: ["setup"],
			testIgnore: /auth\.setup\.ts/,
			use: { ...devices["iPad (gen 7)"], browserName: "chromium", storageState: state },
		},
		{
			name: "phone",
			dependencies: ["setup"],
			testIgnore: /auth\.setup\.ts/,
			use: { ...devices["Pixel 7"], browserName: "chromium", storageState: state },
		},
	],
});
