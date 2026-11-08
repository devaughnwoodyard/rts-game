// Screenshots the ?gallery=1 lineup (844x390 @2x, like a phone in landscape) in all three views.
// Usage: node tools/gallery-shots.mjs [clip ...]   → test/out/gallery-<view>-<clip>.png, prints FPS (?debug=1).
import { chromium } from 'playwright'; import fs from 'node:fs'; import path from 'node:path';
import { serve, root } from './serve.mjs';
const clipsArg = process.argv.slice(2);
const clips = clipsArg.length ? clipsArg : ['walk', 'fire'];
const { server, url } = await serve();
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); if (m.type() === 'warning') console.log('[warn]', m.text()); });
page.on('pageerror', e => errors.push(String(e)));
await page.goto(url + '/?gallery=1&debug=1', { waitUntil: 'load' });
await page.waitForFunction(() => window.world?.gallery, null, { timeout: 30000 });
await page.waitForTimeout(3000);
fs.mkdirSync(path.join(root, 'test/out'), { recursive: true });
for (const clip of clips) {
  await page.evaluate(c => window.world.gallery.show(c), clip);
  for (const view of ['tactical', 'aerial', 'low']) {
    await page.evaluate(v => window.world.setView(v), view);
    await page.waitForTimeout(clip === 'die' ? 2500 : 900);
    await page.screenshot({ path: path.join(root, `test/out/gallery-${view}-${clip}.png`) });
  }
  // close-up: low view at minimum zoom on the lineup
  await page.evaluate(() => { const w = window.world, g = w.gallery.lineup; w.setView('low'); w.zoomBy(0.01); w.jumpTo(g[2].position.x + 2.5, g[2].position.z - 2); });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(root, `test/out/gallery-close-${clip}.png`) });
  await page.evaluate(() => { const w = window.world, g = w.gallery.lineup[2]; w.views.low.min = 5; w.views.low.zoom = 6; w.zoomBy(1); w.jumpTo(g.position.x, g.position.z - 0.5); });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(root, `test/out/gallery-macro-${clip}.png`) });
  await page.evaluate(() => { const w = window.world; w.views.low.min = 16; w.zoomBy(100); w.jumpTo(w.gallery.lineup[0].position.x - 3, w.gallery.lineup[0].position.z + 6); });
}
await page.evaluate(() => window.world.setView('tactical'));
await page.waitForTimeout(2500);
const fps = await page.evaluate(() => document.querySelector('.v-dbg')?.textContent);
console.log('debug counter:', fps, 'squads', await page.evaluate(() => window.world.squadCount?.()));
await browser.close(); server.close();
if (errors.length) { console.error('CONSOLE ERRORS:\n' + errors.join('\n')); process.exit(1); }
console.log('OK gallery');
