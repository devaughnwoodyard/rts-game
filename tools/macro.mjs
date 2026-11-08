// Fast close-up of the gallery lineup: node tools/macro.mjs [clip] → test/out/macro-<clip>.png
import { chromium } from 'playwright'; import path from 'node:path';
import { serve, root } from './serve.mjs';
const clip = process.argv[2] || 'fire';
const { server, url } = await serve();
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await (await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true })).newPage();
const errors = []; page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); if (m.type() === 'warning' && !m.text().includes('GL Driver')) console.log('[warn]', m.text()); }); page.on('pageerror', e => errors.push(String(e)));
await page.goto(url + '/?gallery=1'); await page.waitForFunction(() => window.world?.gallery && window.world.sim, null, { timeout: 60000 });
await page.evaluate((c) => { const w = window.world, g = w.gallery.lineup; w.gallery.show(c); w.setView('low'); w.views.low.min = 5; w.views.low.zoom = 9; w.zoomBy(1); w.jumpTo((g[2].position.x + g[3].position.x) / 2, g[2].position.z + 1); }, clip);
await page.waitForTimeout(2500);
await page.screenshot({ path: path.join(root, `test/out/macro-${clip}.png`) });
await browser.close(); server.close();
if (errors.length) { console.error(errors.join('\n')); process.exit(1); } console.log('ok');
