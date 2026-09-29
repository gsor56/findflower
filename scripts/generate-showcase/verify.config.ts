import { defineConfig } from '@playwright/test';
import captureConfig from './playwright.config';

export default defineConfig({
  ...captureConfig,
  testMatch: 'verify.spec.ts',
  use: { ...captureConfig.use, video: 'off' },
});
