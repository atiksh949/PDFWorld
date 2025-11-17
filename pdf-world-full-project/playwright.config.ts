import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e/playwright',
  use: { headless: true },
  timeout: 30000
});
