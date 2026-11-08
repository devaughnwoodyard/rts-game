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
await page.goto(`http://127.0.0.1:${port}/`); await page.waitForFunction(() => window.world?.sim && window.world?.econ, null, { timeout: 120000 }); await page.waitForTimeout(1500);
fs.mkdirSync(path.join(root, 'test/out'), { recursive: true });
const snap = async (n) => page.screenshot({ path: path.join(root, `test/out/play-${n}.png`) });

// Instrumentation: damage matrix attackerTeam->victimTeam, first AI hit on team 0, wave log, perf maxima.
await page.evaluate(() => {
  const w = window.world;
  window.__m = { dmg: {}, firstHitOnPlayer: null, waves: [], maxStep: 0, maxFog: 0, nan: 0 };
  w.bus.addEventListener('hit', ev => { const d = ev.detail, a = d.attacker?.team, v = d.victim?.team; if (a == null || v == null) return; const k = a + '>' + v; window.__m.dmg[k] = (window.__m.dmg[k] || 0) + d.dmg; if (v === 0 && a > 0 && window.__m.firstHitOnPlayer == null) window.__m.firstHitOnPlayer = Math.round(w.clock.t); });
  w.bus.addEventListener('wave', ev => window.__m.waves.push({ t: Math.round(w.clock.t), ...ev.detail }));
  // ECON chain instrumentation: claim -> extractor -> haul/deposit -> currency, per team
  const ec = window.__m.econ = {}; const E = (t) => ec[t] || (ec[t] = { claim: 0, claimed: 0, ext: 0, depP: 0, depS: 0, depA: 0, razed: 0, pulses: 0 });
  w.bus.addEventListener('claim', ev => E(ev.detail.team).claim++);
  w.bus.addEventListener('claimed', ev => E(ev.detail.team).claimed++);
  w.bus.addEventListener('extractor', ev => E(ev.detail.team).ext++);
  w.bus.addEventListener('razed', ev => E(ev.detail.team).razed++);
  w.bus.addEventListener('pulse', ev => E(ev.detail.entity.team).pulses++);
  w.bus.addEventListener('deposit', ev => { const d = ev.detail, x = E(d.team); if (d.aether) x.depA += d.amount; if (d.kind === 'primary') x.depP += d.amount; else x.depS += d.amount; });
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

const counts = () => page.evaluate(() => { const w = window.world, out = {}; for (const e of w.entities) if (e.isUnit) out[e.team] = (out[e.team] || 0) + 1; const tiers = w.defense?._state?.map(s => s.tier); return { t: Math.round(w.clock.t), units: out, tiers, primary: w.sim.crystals.map(Math.round), alive: w.ui.teamsAlive, over: w.ui.gameOver }; });
// Fast-forward: headless rendering is far too slow on a shared box, so pause the engine clock (speed 0 => sim/defense
// see dt 0 from the frame loop) and step sim + defense directly at 0.1s game steps, timing each sim step.
const ff = async (sec) => { let left = sec; while (left > 0 && !(await page.evaluate(() => window.world.ui.gameOver))) { const chunk = Math.min(30, left); left -= chunk; await page.evaluate(n => { const w = window.world; w.clock.speed = 0; for (let i = 0; i < n && !w.ui.gameOver; i++) { w.clock.t += 0.1; const t0 = performance.now(); w.sim.update(0.1); w.defense?.update?.(0.1); window.__m.maxStep = Math.max(window.__m.maxStep, performance.now() - t0); window.__m.sumStep = (window.__m.sumStep || 0) + performance.now() - t0; window.__m.nStep = (window.__m.nStep || 0) + 1; window.__m.maxFog = Math.max(window.__m.maxFog, w.sim.perf.fogMs); } }, Math.round(chunk * 10)); } };
const tnow = () => page.evaluate(() => window.world.clock.t);
const econSnap = () => page.evaluate(() => { const w = window.world, ec = w.econ, out = [];
  for (let t = 0; t < 4; t++) { const s = ec.stats(t), h = w.entities.filter(e => e.team === t && e.harv).length;
    out.push(`T${t} ${w.factions[t]}: ${s.names.primary} ${Math.round(s.primary)} (+${Math.round(s.incPrimary)}/m) ${s.names.secondary} ${Math.round(s.secondary)} (+${Math.round(s.incSecondary)}/m) supply ${s.supply}/${s.supplyCap} plots ${s.plots}${s.claiming ? '+' + s.claiming : ''} ext ${s.extractors} proc ${s.processors} harv ${h}`); }
  return out.join('\n  '); });

// Player econ path via the public API: claim the nearest claimable plot now, build its extractor when claimed.
const pClaim = await page.evaluate(() => { const ec = window.world.econ, cc = window.world.sim.hq[0]; const c = ec.claimables(0).sort((a, b) => Math.hypot(a.x - cc.x, a.z - cc.z) - Math.hypot(b.x - cc.x, b.z - cc.z))[0]; window.__pPlot = c; const acts = ec.plotActions(c).map(a => a.label + (a.enabled ? '' : ' [x]')); const r = c ? ec.claim(0, c) : { ok: false }; return { ok: r.ok, res: c?.res, acts }; });
console.log('player claim', JSON.stringify(pClaim));
// Player: some units + two defense tiers (checks the ring keeps the field lane clear).
await page.evaluate(() => { const w = window.world, s = w.sim; s.crystals[0] = 3000; const b = w.entities.find(e => e.team === 0 && e.kind === 'barracks'); const f = w.entities.find(e => e.team === 0 && e.kind === 'factory'); for (let i = 0; i < 4; i++) s.enqueue(b, 'warden'); const ec = w.econ, cc = s.hq[0]; for (let k = 0; k < 16; k++) { const a = k * 0.8, r = ec.build(0, 'housing', cc.x - 14 * Math.cos(a), cc.z + 14 * Math.sin(a)); if (r.ok) break; } for (let i = 0; i < 2; i++) s.enqueue(f, 'tank'); s.enqueue(f, 'harvester'); w.defense.buildDefense(0); });
await ff(30);
console.log('player build extractor', JSON.stringify(await page.evaluate(() => { const ec = window.world.econ, p = window.__pPlot; const a = ec.plotActions(p).find(x => x.id === 'extract'); const r = a?.enabled ? a.run() : { ok: false, reason: a?.reason || 'no action' }; return { ok: r.ok, reason: r.reason, owner: p.owner }; })));
await ff(50); await page.evaluate(() => window.world.defense.buildDefense(0));
for (const min of [3, 5, 6, 10, 15]) {
  await ff(min * 60 - await tnow());
  if (min === 3 || min === 6 || min === 10) console.log(`econ ${min}m\n  ` + await econSnap());
  if (min === 5 || min === 10 || min === 15) console.log(`min ${min}`, JSON.stringify(await counts()));
  if (min === 5) {
    // tap-attack on a hidden enemy must be ignored (becomes a move)
    const r = await page.evaluate(() => { const w = window.world; const hid = w.entities.find(e => e.team > 0 && e.hidden); const u = w.entities.find(e => e.team === 0 && e.isUnit && e.dps > 0); if (!hid || !u) return 'n/a'; w.input.selected.clear(); w.input.selected.add(u); w.input.command = { type: 'attack', x: hid.x, z: hid.z, target: hid }; w.sim.update(0.01); const ok = u.target !== hid; w.input.selected.clear(); u.state = 'idle'; u.dest = null; return ok ? 'ignored' : 'TARGETED'; });
    console.log('hidden-target tap:', r);
    // field lane check: no wall/turret of any team within the cc->field keep-out
    const lane = await page.evaluate(() => { const w = window.world; let bad = 0; for (let t = 0; t < 4; t++) { const b = w.sim.bases[t]; if (!b) continue; const f = b.field; for (const e of w.entities) if (e.team === t && e.def && Math.hypot(e.x - f.x, e.z - f.z) < f.r + 2) bad++; } return bad; });
    console.log('defenses on base fields:', lane);
  }
}
await page.evaluate(() => { for (const e of window.world.entities) if (!Number.isFinite(e.x) || !Number.isFinite(e.z) || !Number.isFinite(e.hp)) window.__m.nan++; });
const m = await page.evaluate(() => window.__m);
// end-to-end chain per faction: claimed land, built an extractor, hauled primary to a processor, banked secondary
const chain = await page.evaluate(() => { const w = window.world, out = []; for (let t = 0; t < 4; t++) { const x = window.__m.econ[t] || {}; const st = w.econ.stats(t); x.earnedP = st.earnedPrimary; x.earnedS = st.earnedSecondary; const ok = x.claimed > 0 && x.ext > 0 && x.depP > 0 && st.earnedSecondary > 0; out.push(`${w.factions[t]}:${ok ? 'OK' : 'FAIL'} ${JSON.stringify(x, (k, v) => typeof v === 'number' ? Math.round(v) : v)}`); } return out; });
console.log('econ chain\n  ' + chain.join('\n  '));
console.log('unmanned defenses', await page.evaluate(() => window.world.entities.filter(e => e.unmanned).length), 'crewed', await page.evaluate(() => window.world.entities.filter(e => e.crew > 0).map(e => e.kind + ':' + e.crew).slice(0, 8).join(' ')));
const aiVsAi = Object.entries(m.dmg).filter(([k]) => { const [a, v] = k.split('>').map(Number); return a > 0 && v > 0 && a !== v; }).map(([k, d]) => `${k}:${Math.round(d)}`);
console.log('AI-vs-AI damage', aiVsAi.join(' ') || 'NONE');
console.log('dmg on player', Object.entries(m.dmg).filter(([k]) => k.endsWith('>0')).map(([k, d]) => `${k}:${Math.round(d)}`).join(' '), 'firstHitOnPlayer(s)', m.firstHitOnPlayer);
console.log('waves', m.waves.slice(0, 12).map(w => `${w.t}s ${w.team}->${w.target} x${w.size}`).join(', '));
console.log('perf', JSON.stringify({ maxFogMs: +m.maxFog.toFixed(3), nanEntities: m.nan, avgSimStepMs: +(m.sumStep / m.nStep).toFixed(3), maxSimStepMs: +m.maxStep.toFixed(2), paths: await page.evaluate(() => window.world.sim.perf.paths) }));
await page.evaluate(() => { window.world.clock.speed = 1; });
await page.evaluate(() => { const w = window.world; w.camTarget.x = -185; w.camTarget.z = 100; w.setView('aerial'); }); await page.waitForTimeout(800); await snap('base-late');
await browser.close(); server.close();
if (errors.length) { console.error('ERRORS:\n' + errors.slice(0, 10).join('\n')); process.exit(1); } console.log('OK play');
