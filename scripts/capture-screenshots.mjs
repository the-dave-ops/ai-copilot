// Capture README screenshots of the running app with headless Chrome.
//
// Prerequisites:
//   1. App running at APP_URL (default http://localhost:3000)
//   2. Chrome/Chromium installed (CHROME_PATH env to override)
//   3. npm install (puppeteer-core is a root devDependency)
//
// Usage:
//   APP_URL=http://localhost:3000 node scripts/capture-screenshots.mjs
//
// Screenshots are written to docs/screenshots/.
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.env.APP_URL || 'http://localhost:3000';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'docs',
  'screenshots',
);
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });

const shot = async (name, ms = 400) => {
  await new Promise((r) => setTimeout(r, ms));
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`saved ${name}.png`);
};

const clickByText = (selector, re) =>
  page.evaluate(
    (sel, src) => {
      const rx = new RegExp(src, 'i');
      const el = [...document.querySelectorAll(sel)].find((e) =>
        rx.test(e.textContent || ''),
      );
      if (el) el.click();
      return !!el;
    },
    selector,
    re.source,
  );

// 1. Connect screen
await page.goto(BASE, { waitUntil: 'networkidle2' });
await page.waitForSelector('.auth-tabs', { timeout: 15000 });
await shot('01-connect', 800);

// 2. Connect with Public / No Auth
const tabOk = await clickByText('.auth-tab', /public/i);
console.log('public tab clicked:', tabOk);
await new Promise((r) => setTimeout(r, 300));
await page.click('.auth-submit');
await page.waitForSelector('textarea', { timeout: 20000 });
await page.waitForSelector('.starter-card', { timeout: 15000 }).catch(() => {});
await shot('02-chat-home', 1200);

// 3. Slash command menu
await page.click('textarea');
await page.keyboard.type('/');
await page.waitForSelector('.slash-menu', { timeout: 8000 });
await shot('03-slash-menu', 500);
await page.keyboard.press('Escape');
await new Promise((r) => setTimeout(r, 300));
// clear textarea
await page.click('textarea', { clickCount: 3 });
await page.keyboard.press('Backspace');

// 4. Tool call (read): list users -> clean tabular output
await page.type('textarea', 'List all users in the system');
await page.keyboard.press('Enter');
await page.waitForFunction(
  () => document.body.innerText.includes('Done — I ran the request'),
  { timeout: 30000 },
);
await shot('04-tool-call', 800);

// 5. Start a new clean chat for the mutating action approval card
await clickByText('button', /New Chat/i);
await page.waitForSelector('textarea', { timeout: 10000 });
await new Promise((r) => setTimeout(r, 600));

// 6. Approval card (write): create book -> HITL approval UI
await page.click('textarea');
await page.type('textarea', 'Create a new book titled "AI Handbook"');
await page.keyboard.press('Enter');
await page.waitForSelector('.approval', { timeout: 20000 });
await new Promise((r) => setTimeout(r, 1200));
await shot('05-approval', 400);

await browser.close();
console.log('done');
