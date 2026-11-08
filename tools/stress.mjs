// Stress/behaviour check: 40 warden squads (120 skinned soldiers) fighting near the middle, then a death.
// Usage: node tools/stress.mjs → test/out/stress-*.png, prints FPS + mixer cost.
import { chromium } from 'playwright'; import path from 'node:path';
import { serve, root } from './serve.mjs';
const { server, url } = await serve();
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await (await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true })).newPage();
const errors = []; page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); page.on('pageerror', e => errors.push(String(e)));
await page.goto(url + '/?debug=1'); await page.waitForFunction(() => window.world?.sim); await page.waitForTimeout(2000);
await page.evaluate(() => {
  const w = window.world, s = w.sim;
  for (let i = 0; i < 20; i++) for (const team of [0, 1]) {
    const e = s.spawn('warden', team, (team ? 6 : -6) + (i % 5) * 2.6 * (team ? 1 : -1), -12 + Math.floor(i / 5) * 6);
    e.dest = { x: team ? -20 : 20, z: e.z }; e.state = 'move';
  }
  w.setView('tactical'); w.jumpTo(0, -4);
});
await page.waitForTimeout(4000);
await page.screenshot({ path: path.join(root, 'test/out/stress-fight.png') });
const r = await page.evaluate(() => new Promise(res => { let f = 0; const t0 = performance.now(); const k = () => { f++; if (performance.now() - t0 < 4000) requestAnimationFrame(k); else res({ fps: f / ((performance.now() - t0) / 1000), squads: window.world.squadCount(), wardens: window.world.entities.filter(e => e.kind === 'warden').length }); }; requestAnimationFrame(k); }));
// JS cost of 120 mixers at 30 fps-ish dt
const mix = await page.evaluate(() => { const ms = []; for (const e of window.world.entities) for (const s of e.mesh?.userData?.squad?.soldiers || []) ms.push(s.mixer); const t0 = performance.now(); for (let i = 0; i < 60; i++) for (const m of ms) m.update(0.016); return { mixers: ms.length, msPerFrame: (performance.now() - t0) / 60 }; });
console.log(JSON.stringify(r), JSON.stringify(mix));
// kill one squad, capture death
await page.evaluate(() => { const w = window.world; const e = w.entities.find(x => x.kind === 'warden' && x.team === 1); w.jumpTo(e.x, e.z + 2); w.views.tactical.zoom = 22; w.zoomBy(1); w.sim.kill(e); window.__dead = e; });
await page.waitForTimeout(1800);
await page.screenshot({ path: path.join(root, 'test/out/stress-death.png') });
await page.waitForTimeout(9000);
console.log('after death', JSON.stringify(await page.evaluate(() => ({ inScene: !!window.__dead.mesh.parent, squads: window.world.squadCount() }))));
await browser.close(); server.close();
if (errors.length) { console.error('ERRORS\n' + errors.join('\n')); process.exit(1); }
