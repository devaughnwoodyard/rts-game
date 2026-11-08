// Scripted playthrough: builds units, buys defenses, speeds the clock, and screenshots a fight.
import { chromium } from 'playwright';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg' };
const server = http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
await new Promise(r => server.listen(0, r)); const port = server.address().port;
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await (await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true })).newPage();
const errors = []; page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); page.on('pageerror', e => errors.push(String(e)));
await page.goto(`http://127.0.0.1:${port}/`); await page.waitForTimeout(4000);
fs.mkdirSync(path.join(root, 'test/out'), { recursive: true });
const snap = async (n) => page.screenshot({ path: path.join(root, `test/out/play-${n}.png`) });
const st = async () => page.evaluate(() => { const w = window.world; const by = {}; for (const e of w.entities) { const k = e.team + ':' + e.kind; by[k] = (by[k] || 0) + 1; } return { t: Math.round(w.clock.t), crystals: w.ui.crystals, tier: w.ui.defenseTier, etier: w.ui.enemyTier, over: w.ui.gameOver, by }; });
// Fast-forward helper: run sim at high speed in bursts
// Polls game time (not wall time): headless swiftshader frames are slow and engine caps dt at 0.05*speed, so a fixed wait under-runs.
const ff = async (sec) => { const until = await page.evaluate(s => { window.world.clock.speed = 30; return window.world.clock.t + s; }, sec); const t0 = Date.now(); while (Date.now() - t0 < 120000 && await page.evaluate(u => window.world.clock.t < u && !window.world.ui.gameOver, until)) await page.waitForTimeout(100); await page.evaluate(() => { window.world.clock.speed = 1; }); };
// Give player money and build an army + defenses
await page.evaluate(() => { const w = window.world, s = w.sim; s.crystals[0] = 3000; const b = w.entities.find(e => e.team === 0 && e.kind === 'barracks'); const f = w.entities.find(e => e.team === 0 && e.kind === 'factory'); for (let i = 0; i < 4; i++) s.enqueue(b, 'warden'); for (let i = 0; i < 2; i++) s.enqueue(f, 'tank'); s.enqueue(f, 'harvester'); w.defense.buildDefense(0); });
await ff(120); console.log('after 2 min', JSON.stringify(await st()));
await page.evaluate(() => { const w = window.world; w.defense.buildDefense(0); w.camTarget.x = -45; w.camTarget.z = 20; });
await ff(150); console.log('after 4.5 min', JSON.stringify(await st()));
// Send all player combat units at the enemy base
await page.evaluate(() => { const w = window.world; for (const e of w.entities) if (e.team === 0 && (e.cls === 'inf' || e.cls === 'veh') && e.kind !== 'harvester') { e.dest = { x: 40, z: -20 }; e.state = 'move'; e.aggressive = true; } w.camTarget.x = 30; w.camTarget.z = -15; });
await ff(60); await page.waitForTimeout(1500); await snap('fight'); console.log('fight', JSON.stringify(await st()));
await page.evaluate(() => { window.world.setView('aerial'); }); await page.waitForTimeout(500); await snap('fight-aerial');
// Enemy army / wave checks: track enemy combat units near the player CC (within 35u) every 250ms real time.
await page.evaluate(() => { window.__wave = { first: null, max: 0, peakArmy: 0 }; setInterval(() => { const w = window.world; const army = w.entities.filter(e => e.team === 1 && e.isUnit && e.dps > 0).length; if (w.clock.t <= 480 && army > window.__wave.peakArmy) window.__wave.peakArmy = army; const cc = w.entities.find(e => e.team === 0 && e.kind === 'cc'); if (!cc) return; const n = w.entities.filter(e => e.team === 1 && e.isUnit && e.dps > 0 && Math.hypot(e.x - cc.x, e.z - cc.z) < 35).length; if (n > 0 && window.__wave.first == null) window.__wave.first = Math.round(w.clock.t); if (n > window.__wave.max) window.__wave.max = n; }, 250); });
const ecombat = () => page.evaluate(() => window.world.entities.filter(e => e.team === 1 && e.isUnit && e.dps > 0).length);
const tnow = () => page.evaluate(() => window.world.clock.t);
await ff(480 - await tnow()); console.log('enemy at ~8 min', JSON.stringify({ t: Math.round(await tnow()), enemyCombat: await ecombat(), peak5to8min: await page.evaluate(() => window.__wave.peakArmy) }));
await ff(600 - await tnow()); console.log('wave by ~10 min', JSON.stringify({ t: Math.round(await tnow()), ...(await page.evaluate(() => window.__wave)) }));
await ff(100); console.log('after ~11 min', JSON.stringify(await st()));
await page.evaluate(() => { const w = window.world; w.camTarget.x = -55; w.camTarget.z = 25; w.setView('tactical'); }); await page.waitForTimeout(800); await snap('base-late');
await page.evaluate(() => { const w = window.world; w.camTarget.x = 55; w.camTarget.z = -25; }); await page.waitForTimeout(800); await snap('enemy-late');
await browser.close(); server.close();
if (errors.length) { console.error('ERRORS:\n' + errors.slice(0, 10).join('\n')); process.exit(1); } console.log('OK play');
