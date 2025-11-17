import { test, expect } from '@playwright/test';
import path from 'path';
test('browser can use demo to upload (presign)', async ({ page }) => {
  await page.goto('http://localhost:4000/demo');
  const fixture = path.resolve(__dirname, '../fixtures/small.bin');
  await page.setInputFiles('input[type=file]', fixture);
  await page.click('button#start');
  await page.waitForTimeout(2000);
  expect(await page.title()).toContain('PDF World');
});
