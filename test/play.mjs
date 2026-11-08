// Scripted 4-team playthrough (SIM-v2): builds a player army + defenses, fast-forwards to ~15 game-min and reports
// per-team unit counts at 5/10/15 min, AI-vs-AI fighting, first AI attack on the player, fog visible fraction,
// NaN check and sim/fog timings. If the engine still ships the old small map, the harness forces 512x320.
import { chromium } from 'playwright';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };
const server = http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
await new Promise(r => server.listen(0, r)); const port = server.address().port;
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
// Force the v2 map size before createSim runs (main.js sets window.world right after createEngine).
await ctx.addInitScript(() => {
  let w; Object.defineProperty(window, 'world', { configurable: true, get() { return w; },
    set(v) { if (v?.map && v.map.w < 512) { v.map.w = 512; v.map.h = 320; window.__forcedMap = true; } w = v; } });
});
const page = await ctx.newPage();
// Optional modules owned by other workers may not exist yet; their 404s aren't sim errors.
const optional = /roster\.js|abilities\.js|abilitybar\.js|heroes\.js|404 \(Not Found\)/;
const errors = []; page.on('console', m => { if (m.type() === 'error' && !optional.test(m.text() + (m.location()?.url || ''))) errors.push(m.text()); }); page.on('pageerror', e => errors.push(String(e)));
await page.goto(`http://127.0.0.1:${port}/`); await page.waitForTimeout(4000);
fs.mkdirSync(path.join(root, 'test/out'), { recursive: true });
const snap = async (n) => page.screenshot({ path: path.join(root, `test/out/play-${n}.png`) });

// Instrumentation: damage matrix attackerTeam->victimTeam, first AI hit on team 0, wave log, perf maxima.
await page.evaluate(() => {
  const w = window.world;
  window.__m = { dmg: {}, firstHitOnPlayer: null, waves: [], maxStep: 0, maxFog: 0, nan: 0 };
  w.bus.addEventListener('hit', ev => { const d = ev.detail, a = d.attacker?.team, v = d.victim?.team; if (a == null || v == null) return; const k = a + '>' + v; window.__m.dmg[k] = (window.__m.dmg[k] || 0) + d.dmg; if (v === 0 && a > 0 && window.__m.firstHitOnPlayer == null) window.__m.firstHitOnPlayer = Math.round(w.clock.t); });
  w.bus.addEventListener('wave', ev => window.__m.waves.push({ t: Math.round(w.clock.t), ...ev.detail }));
  setInterval(() => { const p = w.sim.perf; window.__m.maxFog = Math.max(window.__m.maxFog, p.fogMs); for (const e of w.entities) if (!Number.isFinite(e.x) || !Number.isFinite(e.z) || !Number.isFinite(e.hp)) window.__m.nan++; }, 500);
});
const start = await page.evaluate(() => {
  const w = window.world, f = w.fog; let v = 0; for (let i = 0; i < f.visible.length; i++) v += f.visible[i];
  const hiddenEnemies = w.entities.filter(e => e.team > 0 && e.hidden).length, enemies = w.entities.filter(e => e.team > 0).length;
  const ccs = w.entities.filter(e => e.kind === 'cc').map(e => [e.team, Math.round(e.x), Math.round(e.z)]);
  const crystals = w.entities.filter(e => e.kind === 'crystal').length;
  return { map: w.map, forced: !!window.__forcedMap, factions: w.factions, ccs, crystals, fogVisiblePct: +(100 * v / f.visible.length).toFixed(2), hiddenEnemies, enemies, obstacles: w.obstacles.length };
});
console.log('start', JSON.stringify(start));

const counts = () => page.evaluate(() => { const w = window.world, out = {}; for (const e of w.entities) if (e.isUnit) out[e.team] = (out[e.team] || 0) + 1; const tiers = w.defense?._state?.map(s => s.tier); return { t: Math.round(w.clock.t), units: out, tiers, crystals: w.sim.crystals.map(Math.round), alive: w.ui.teamsAlive, over: w.ui.gameOver }; });
// Fast-forward by game time (headless frames are slow; engine caps dt at 0.05*speed).
const ff = async (sec) => { const until = await page.evaluate(s => { window.world.clock.speed = 40; return window.world.clock.t + s; }, sec); const t0 = Date.now(); while (Date.now() - t0 < 300000 && await page.evaluate(u => window.world.clock.t < u && !window.world.ui.gameOver, until)) await page.waitForTimeout(200); await page.evaluate(() => { window.world.clock.speed = 1; }); };
const tnow = () => page.evaluate(() => window.world.clock.t);

// Player: some units + two defense tiers (checks the ring keeps the field lane clear).
await page.evaluate(() => { const w = window.world, s = w.sim; s.crystals[0] = 3000; const b = w.entities.find(e => e.team === 0 && e.kind === 'barracks'); const f = w.entities.find(e => e.team === 0 && e.kind === 'factory'); for (let i = 0; i < 4; i++) s.enqueue(b, 'warden'); for (let i = 0; i < 2; i++) s.enqueue(f, 'tank'); s.enqueue(f, 'harvester'); w.defense.buildDefense(0); });
await ff(80); await page.evaluate(() => window.world.defense.buildDefense(0));
for (const min of [5, 10, 15]) {
  await ff(min * 60 - await tnow());
  console.log(`min ${min}`, JSON.stringify(await counts()));
  if (min === 5) {
    // tap-attack on a hidden enemy must be ignored (becomes a move)
    const r = await page.evaluate(() => { const w = window.world; const hid = w.entities.find(e => e.team > 0 && e.hidden); const u = w.entities.find(e => e.team === 0 && e.isUnit && e.dps > 0); if (!hid || !u) return 'n/a'; w.input.selected.clear(); w.input.selected.add(u); w.input.command = { type: 'attack', x: hid.x, z: hid.z, target: hid }; w.sim.update(0.01); const ok = u.target !== hid; w.input.selected.clear(); u.state = 'idle'; u.dest = null; return ok ? 'ignored' : 'TARGETED'; });
    console.log('hidden-target tap:', r);
    // field lane check: no wall/turret of any team within the cc->field keep-out
    const lane = await page.evaluate(() => { const w = window.world; let bad = 0; for (let t = 0; t < 4; t++) { const b = w.sim.bases[t]; if (!b) continue; const f = b.field; for (const e of w.entities) if (e.team === t && e.def && Math.hypot(e.x - f.x, e.z - f.z) < f.r + 2) bad++; } return bad; });
    console.log('defenses on base fields:', lane);
  }
}
const m = await page.evaluate(() => window.__m);
const aiVsAi = Object.entries(m.dmg).filter(([k]) => { const [a, v] = k.split('>').map(Number); return a > 0 && v > 0 && a !== v; }).map(([k, d]) => `${k}:${Math.round(d)}`);
console.log('AI-vs-AI damage', aiVsAi.join(' ') || 'NONE');
console.log('dmg on player', Object.entries(m.dmg).filter(([k]) => k.endsWith('>0')).map(([k, d]) => `${k}:${Math.round(d)}`).join(' '), 'firstHitOnPlayer(s)', m.firstHitOnPlayer);
console.log('waves', m.waves.slice(0, 12).map(w => `${w.t}s ${w.team}->${w.target} x${w.size}`).join(', '));
console.log('perf', JSON.stringify({ maxFogMs: +m.maxFog.toFixed(3), nanEntities: m.nan, lastStepMs: await page.evaluate(() => +window.world.sim.perf.stepMs.toFixed(2)) }));
await page.evaluate(() => { const w = window.world; w.camTarget.x = -185; w.camTarget.z = 100; w.setView('aerial'); }); await page.waitForTimeout(800); await snap('base-late');
await browser.close(); server.close();
if (errors.length) { console.error('ERRORS:\n' + errors.slice(0, 10).join('\n')); process.exit(1); } console.log('OK play');
