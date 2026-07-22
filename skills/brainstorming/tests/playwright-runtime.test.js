const assert = require('node:assert/strict');
const test = require('node:test');

const { chromium } = require('@playwright/test');

test('version-matched Chromium launches and renders a local smoke page', { timeout: 30_000 }, async t => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    if (/MachPortRendezvous|bootstrap_check_in.*Permission denied/u.test(String(error))) {
      t.skip('Chromium is unavailable in this macOS sandbox');
      return;
    }
    throw error;
  }
  t.after(async () => {
    await browser.close();
  });

  assert.equal(browser.browserType().name(), 'chromium');
  assert.match(browser.version(), /^\d+(?:\.\d+)+$/u);

  const page = await browser.newPage();
  await page.setContent('<main><h1 data-smoke="visual-shell">Visual Shell Chromium smoke</h1></main>');

  assert.equal(
    await page.locator('[data-smoke="visual-shell"]').textContent(),
    'Visual Shell Chromium smoke',
  );
  assert.equal(await page.evaluate(() => document.readyState), 'complete');
});
