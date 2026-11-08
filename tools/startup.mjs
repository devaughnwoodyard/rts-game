// Measures time until window.world (createEngine resolved) and window.world.sim exist.
import { chromium } from 'playwright';
import { serve } from './serve.mjs';
const { server, url } = await serve();
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await (await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true })).newPage();
const t0 = Date.now(); await page.goto(url + '/?' + (process.argv[2] || ''));
await page.waitForFunction(() => window.world, null, { timeout: 60000 }); const t1 = Date.now();
await page.waitForFunction(() => window.world.sim, null, { timeout: 60000 });
console.log('world', t1 - t0, 'ms; sim', Date.now() - t0, 'ms');
await browser.close(); server.close();
