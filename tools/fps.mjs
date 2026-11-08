// Prints the ?debug=1 FPS counter for each query string given. Usage: node tools/fps.mjs "" "shadows=0" ...
import { chromium } from 'playwright';
import { serve } from './serve.mjs';
const qs = process.argv.slice(2); if (!qs.length) qs.push('');
const { server, url } = await serve();
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
for (const q of qs) {
  for (const dsf of [2, 1]) {
    const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: dsf, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    await page.goto(`${url}/?debug=1&${q}`); await page.waitForTimeout(5000);
    const n = await page.evaluate(() => new Promise(r => { let f = 0; const t0 = performance.now(); const k = () => { f++; if (performance.now() - t0 < 4000) requestAnimationFrame(k); else r(f / ((performance.now() - t0) / 1000)); }; requestAnimationFrame(k); }));
    console.log(`?${q} dpr${dsf}: ${n.toFixed(1)} fps, hud says ${await page.evaluate(() => document.querySelector('.v-dbg')?.textContent)}`);
    await ctx.close();
  }
}
await browser.close(); server.close();
