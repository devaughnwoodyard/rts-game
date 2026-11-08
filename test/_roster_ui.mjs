// Headless smoke test: serves the repo, loads the game at phone landscape size,
// fails on console errors, screenshots each camera view.
// Usage: node test/smoke.mjs [label]
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const label = process.argv[2] || 'smoke';
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const errors = [];
// Optional modules owned by other workers (roster/abilities/heroes) may not exist yet: their 404s aren't errors.
const optional404 = (m) => /404/.test(m.text()) && /(roster|abilities|abilitybar|heroes)\.js/.test(m.location()?.url || '');
const pending404 = new Set();
page.on('requestfailed', () => {}); page.on('response', r => { if (r.status() === 404 && /(roster|abilities|abilitybar|heroes)\.js/.test(r.url())) pending404.add(r.url()); });
page.on('console', m => { if (m.type() === 'error' && !(optional404(m) || (/404/.test(m.text()) && pending404.size))) errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForTimeout(6000);
await page.waitForFunction(() => window.world?.abilities && window.world?.sim, null, { timeout: 60000 });
await page.evaluate(async () => {
  const { ROSTER } = await import('./js/roster.js');
  const w = window.world;
  const mk = (k, t, x, z) => { const r = ROSTER[k]; return w.sim.spawn(k, t, x, z, { isUnit: true, hp: r.hp, hpMax: r.hp, speed: r.speed, range: r.range, dps: r.dps, fireRate: r.cooldown, r: r.r, cls: r.cls, light: r.light, air: r.air, armor: r.armor, supply: 0 }); };
  const cc = w.sim.hq[0]; const us = [];
  for (let i = 0; i < 3; i++) us.push(mk('earth_strider', 0, cc.x + 20 + i * 2, cc.z - 10));
  for (let i = 0; i < 4; i++) mk('volcanic_brute', 1, cc.x + 40 + i * 2, cc.z - 12);
  w.input.selected.clear(); us.forEach(u => w.input.selected.add(u));
  for (const u of us) for (const id of ROSTER[u.kind].abilities) w.abilities.setAutocast(u, id, false);
  window.__us = us;
});
await page.waitForTimeout(800);
const bb = await page.$$('.v-abil .ab'); console.log('buttons', bb.length);
const box = await bb[2].boundingBox();
await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2); await page.waitForTimeout(400);
console.log('targeting tip:', await page.evaluate(() => document.querySelector('.v-abil .tip').textContent));
await page.screenshot({ path: path.join(root, 'test/out/abilitybar-target.png') });
const p = await page.evaluate(() => { const e = world.entities.find(e => e.kind === 'volcanic_brute'); return world.project(e.x, 0, e.z); });
const sel0 = await page.evaluate(() => world.input.selected.size);
await page.touchscreen.tap(p.x, p.y); await page.waitForTimeout(600);
console.log(await page.evaluate((s0) => JSON.stringify({ sel0: s0, sel: world.input.selected.size, cd: world.abilities.cooldown(window.__us[0], 'ea_flashflood'), obs: world.obstacles.filter(o => o.flood).length, zones: world.abilities.zones.length, tip: document.querySelector('.v-abil .tip').textContent })), sel0);
await page.screenshot({ path: path.join(root, 'test/out/abilitybar-after.png') });
fs.mkdirSync(path.join(root, 'test/out'), { recursive: true });
for (const view of ['tactical', 'aerial', 'low']) {
  await page.evaluate(v => window.world?.setView?.(v), view);
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(root, `test/out/${label}-${view}.png`) });
}
const stats = await page.evaluate(() => ({
  entities: window.world?.entities?.length, t: window.world?.clock?.t, ui: window.world?.ui,
}));
console.log(JSON.stringify(stats));
await browser.close(); server.close();
if (errors.length) { console.error('CONSOLE ERRORS:\n' + errors.join('\n')); process.exit(1); }
console.log(`OK ${label}: screenshots in test/out/`);
