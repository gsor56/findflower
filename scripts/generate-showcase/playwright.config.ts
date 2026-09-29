import { defineConfig } from '@playwright/test';
import path from 'node:path';

export const root = path.resolve(__dirname, '../..');
export const baseURL = `http://127.0.0.1:${process.env.SHOWCASE_PORT || 3000}`;
export const recordVideo = {
  dir: path.join(root, 'public/assets'),
  size: { width: 1920, height: 1080 },
};

export default defineConfig({
  testDir: __dirname,
  testMatch: /(?:scan-input|scan-ranking|dash-engine|species-fields|scan-correction)\.spec\.ts$/,
  outputDir: path.join(root, 'public/assets/test-results'),
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    browserName: 'chromium',
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    baseURL,
    serviceWorkers: 'block',
    // The capture fixture creates a context with recordVideo above. Recording
    // starts at page creation; the manifest trims setup before choreography.
    launchOptions: { args: ['--enable-unsafe-swiftshader'] },
  },
  webServer: {
    command: 'node scripts/generate-showcase/server.js',
    cwd: root,
    url: `${baseURL}/__showcase_health`,
    reuseExistingServer: false,
  },
});
