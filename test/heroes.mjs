// Hero test: trains all 4 heroes, stages each next to enemies, casts its ability, screenshots test/out/hero-*.png,
// asserts damage / status / heal, then exercises generic roster ability + projectile FX. Fails on console errors.
// Usage: node test/heroes.mjs
import { chromium } from 'playwright';
import fs from 'node:fs'; import path from 'node:path';
import { serve, root } from '../tools/serve.mjs';
const { server, url } = await serve();
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await (await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true })).newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));
const fails = [];
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails.push(msg); };
const out = (n) => path.join(root, `test/out/hero-${n}.png`);
fs.mkdirSync(path.join(root, 'test/out'), { recursive: true });

await page.goto(url + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.world?.heroes && window.world?.sim, null, { timeout: 90000 });
await page.waitForTimeout(1500);
await page.evaluate(() => { const w = window.world; w.fog && (w.fog.enabled = false); for (let t = 0; t < w.sim.crystals.length; t++) w.sim.crystals[t] = 3000; });

// player trains via the HUD button (select the cc first so it shows)
await page.evaluate(() => { const w = window.world, cc = w.entities.find(e => e.kind === 'cc' && e.team === 0); w.input.selected.clear(); w.input.selected.add(cc); });
await page.waitForTimeout(400);
check(await page.isVisible('.v-hero.on button'), 'hero button visible when cc selected');
const box = await page.locator('.v-hero button').boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(300);
const r0 = await page.evaluate(() => ({ st: window.world.heroes.state[0].state, cr: window.world.sim.crystals[0] }));
check(r0.st === 'training' && r0.cr === 2400, `button starts training and spends 600 (${JSON.stringify(r0)})`);
await page.screenshot({ path: out('hud-training') });
const nTeams = await page.evaluate(() => window.world.heroes.state.length);
await page.evaluate(() => { for (let t = 1; t < window.world.heroes.state.length; t++) window.world.heroes.train(t); });
// fast-forward 60s of training
console.log('states', JSON.stringify(await page.evaluate(() => window.world.heroes.state.map(s => [s.state, Math.round(s.t)]))));
await page.evaluate(() => { for (const s of window.world.heroes.state) if (s.state === 'training') s.t = s.total - 0.5; });
await page.waitForFunction(() => window.world.heroes.state.every(s => s.state === 'alive'), null, { timeout: 60000 }).catch(async () => console.log('states', JSON.stringify(await page.evaluate(() => window.world.heroes.state.map(s => [s.state, s.t, s.total])))));
const heroes = await page.evaluate(() => window.world.heroes.list().map(h => ({ team: h.team, faction: h.faction, kind: h.kind, hp: h.hp, isUnit: h.isUnit, stats: !!h.stats, name: h.heroName })));
console.log(JSON.stringify(heroes));
check(heroes.length === nTeams && heroes.every(h => h.kind === 'hero' && h.isUnit && h.stats), 'all heroes trained as hero units');

// centre the low camera on (x, z) at a zoom factor (relative to default)
const frame = (x, z, zf = 1) => page.evaluate(({ x, z, zf }) => {
  const w = window.world; w.input.selected.clear(); w.setView('low');
  w.__z0 ??= w.views?.low?.zoom; if (w.views?.low && w.__z0) { w.views.low.min = Math.min(w.views.low.min, w.__z0 * zf); w.views.low.zoom = w.__z0 * zf; w.zoomBy(1); }
  w.jumpTo(x, z);
  for (let i = 0; i < 3; i++) { const { w: W, h: H } = w.size(); const c = w.groundAt(W / 2, H * 0.6); if (!c) break; w.jumpTo(w.camTarget.x + x - c.x, w.camTarget.z + z - c.z); }
}, { x, z, zf });
const FAC = ['vanguard', 'storm', 'volcanic', 'earth'];
const MAP = await page.evaluate(() => window.world.map);
const SPOT = { vanguard: [-0.1, 0.32], storm: [0.1, 0.32], volcanic: [-0.1, -0.32], earth: [0.1, -0.32] };
for (const k in SPOT) SPOT[k] = await page.evaluate(([fx, fz]) => { // nearest spot with 14u of clear ground
  const w = window.world, clear = (x, z) => (w.obstacles || []).every(o => Math.hypot(o.x - x, o.z - z) > o.r + 14) && w.entities.every(e => e.cls !== 'bld' || Math.hypot(e.x - x, e.z - z) > (e.r || 2) + 14);
  const x0 = fx * w.map.w, z0 = fz * w.map.h;
  for (let r = 0; r < 60; r += 3) for (let a = 0; a < 6.28; a += 0.4) { const x = x0 + Math.cos(a) * r, z = z0 + Math.sin(a) * r; if (Math.abs(x) < w.map.w / 2 - 15 && Math.abs(z) < w.map.h / 2 - 8 && clear(x, z)) return [x, z]; }
  return [x0, z0];
}, SPOT[k]);
console.log('map', JSON.stringify(MAP));
for (const fac of FAC) {
  const [sx, sz] = SPOT[fac];
  // stage: hero at spot, 3 enemy wardens 6-9u away, one damaged ally next to the hero; freeze time for a clean setup
  const setup = await page.evaluate(({ fac, sx, sz }) => {
    const w = window.world, s = w.sim, h = w.heroes.list().find(e => e.faction === fac);
    if (!h) return null;
    w.clock.speed = 0;
    h.x = sx; h.z = sz; h.state = 'idle'; h.target = null; h.dest = null; h.hp = h.hpMax; h.mesh.position.set(sx, 0, sz);
    const foe = (h.team + 1) % w.heroes.state.length;
    const enemies = [];
    for (let i = 0; i < 3; i++) { const e = s.spawn('warden', foe, sx + 7 + i * 1.5, sz + (i - 1) * 2.5); e.hp = e.hpMax = 2000; enemies.push(e.id); }
    const ally = s.spawn('warden', h.team, sx - 2.5, sz + 1.5); ally.hp = 30; ally.hpMax = 400;
    h.rot = 0;
    w.heroes.state[h.team].cdUntil = 0;
    return { hero: h.id, enemies, ally: ally.id };
  }, { fac, sx, sz });
  if (!setup) { check(false, `${fac} hero exists`); continue; }
  await frame(sx, sz, 0.3); await page.waitForTimeout(600);
  await page.screenshot({ path: out(`${fac}-close`) });
  await frame(sx + 4, sz, 0.6); await page.waitForTimeout(300);
  const res = await page.evaluate(({ setup }) => {
    const w = window.world, by = (id) => w.entities.find(e => e.id === id);
    const h = by(setup.hero), en = setup.enemies.map(by);
    const before = en.map(e => e.hp);
    let evs = 0; const L = () => evs++; w.bus.addEventListener('ability', L);
    w.clock.speed = 1;
    w.heroes.state[h.team].cdUntil = 0;
    const ok = w.heroes.cast(h);
    w.bus.removeEventListener('ability', L);
    const t = w.clock.t;
    return { ok, evs, dmg: en.map((e, i) => before[i] - e.hp), status: en.map(e => e.status ? { ...e.status } : null), t,
      heroStatus: h.status ? { ...h.status } : null, targets: en.map(e => e.target === h), cd: w.heroes.state[h.team].cdUntil - t };
  }, { setup });
  await page.waitForTimeout(fac === 'volcanic' ? 350 : fac === 'earth' ? 450 : 30);
  await page.screenshot({ path: out(fac) });
  console.log(fac, JSON.stringify(res));
  check(res.ok && res.evs === 1 && res.cd > 10, `${fac}: cast ok, ability event, cooldown set`);
  if (fac === 'vanguard') check(res.heroStatus?.dmgMul === 0.3 && res.targets.every(Boolean), 'Bulwark: dmgMul 0.3 + enemies retarget');
  if (fac === 'storm') check(res.dmg.filter(d => d > 0).length >= 3 && res.dmg[0] + res.dmg[1] + res.dmg[2] > 400 && res.status.every(s => s?.stunned > res.t), `Chain Lightning: chained damage + stun (${res.dmg.map(Math.round)})`);
  if (fac === 'volcanic') check(res.dmg.some(d => d >= 250), `Eruption Slash: 250 cone damage (${res.dmg.map(Math.round)})`);
  if (fac === 'earth') check(res.status.every(s => s?.rooted > res.t), 'Rootbind: enemies rooted');
  // after the effect: patch burn / heal / root position hold
  await page.waitForTimeout(1500);
  const after = await page.evaluate(({ setup, fac }) => {
    const w = window.world, by = (id) => w.entities.find(e => e.id === id);
    const a = by(setup.ally);
    return { allyHp: a?.hp, patches: w.heroes.patches.length, fx: w.fx?._abilityStats?.() };
  }, { setup, fac });
  console.log(' after', JSON.stringify(after));
  if (fac === 'earth') check(after.allyHp > 60, `Rootbind heals allies (ally hp ${Math.round(after.allyHp)})`);
  if (fac === 'volcanic') check(after.patches >= 1, 'Eruption leaves a fire patch');
  // tidy: remove staged units
  await page.evaluate(({ setup }) => { const w = window.world; for (const id of [...setup.enemies, setup.ally]) { const e = w.entities.find(x => x.id === id); if (e) w.sim.kill(e); } }, { setup });
}

// passive: Ironclad takes 0.75x
const pas = await page.evaluate(() => {
  const w = window.world, h = w.heroes.list().find(e => e.faction === 'vanguard'); h._bulwarkUntil = 0; w.heroes.update(0.0001);
  w.clock.t += 0.001; w.heroes.update(0); const hp = h.hp; w.sim.damage(h, null, 100); return hp - h.hp;
});
check(Math.abs(pas - 75) < 0.01, `Ironclad passive x0.75 (took ${pas})`);
// HUD in ability mode
check(await page.evaluate(() => document.querySelector('.v-hero')?.classList.contains('on') && /Bulwark/.test(document.querySelector('.v-hero .lbl')?.textContent)), 'HUD shows ability button while hero alive');

// generic roster ability kinds + projectile shots
await page.evaluate(() => {
  const w = window.world, cx = 0, cz = 40;
  w.clock.speed = 1; w.setView('tactical'); w.jumpTo(cx, cz);
  const E = (n, d) => w.bus.dispatchEvent(new CustomEvent(n, { detail: d }));
  const u = { x: cx - 14, z: cz, team: 2, r: 1.2, rot: 0, state: 'idle' };
  const tg = [{ x: cx - 4, z: cz + 3, r: 1.2, state: 'idle' }, { x: cx - 2, z: cz - 3, r: 1.2, state: 'idle' }];
  const kinds = ['rain', 'flood', 'erupt', 'burrow', 'burn', 'stun', 'heal', 'shield', 'speed', 'charge', 'lightning', 'aoe'];
  kinds.forEach((k, i) => E('ability', { unit: { ...u, x: cx - 22 + (i % 6) * 9, z: cz - 6 + Math.floor(i / 6) * 12, team: i % 4 }, id: k, kind: k,
    x: cx - 22 + (i % 6) * 9, z: cz - 6 + Math.floor(i / 6) * 12, r: 3.5, duration: 4, targets: i === 11 ? [] : [{ ...tg[0], x: cx - 22 + (i % 6) * 9 + 2, z: cz - 6 + Math.floor(i / 6) * 12 }],
    from: { x: cx - 22 + (i % 6) * 9 - 4, z: cz - 6 + Math.floor(i / 6) * 12 }, to: { x: cx - 22 + (i % 6) * 9 + 3, z: cz - 6 + Math.floor(i / 6) * 12 } }));
  const sk = ['arrow', 'spear', 'minimissile', 'ironball', 'bullet', 'laser', 'lightning', 'slug'];
  window.__shots = setInterval(() => sk.forEach((k, i) => E('shot', { from: { x: cx - 24, y: 1.4, z: cz - 14 + i * 4 }, to: { x: cx + 18, y: 1, z: cz - 14 + i * 4 }, kind: k })), 400);
});
await page.waitForTimeout(900);
await page.screenshot({ path: out('fx-generic') });
await page.evaluate(() => window.world.zoomBy(0.5));
await page.waitForTimeout(700);
await page.screenshot({ path: out('fx-generic-close') });
const gs = await page.evaluate(() => { clearInterval(window.__shots); return window.world.fx?._abilityStats?.(); });
console.log('generic fx', JSON.stringify(gs));
check(gs && gs.projectiles > 0, 'projectiles pooled + rendered');

// death + respawn timer
const dr = await page.evaluate(() => { const w = window.world, h = w.heroes.list().find(e => e.team === 0); w.sim.damage(h, null, 1e6); return true; });
await page.waitForTimeout(600);
const ds = await page.evaluate(() => ({ st: window.world.heroes.state[0].state, left: window.world.heroes.state[0].respawnAt - window.world.clock.t }));
check(ds.st === 'dead' && ds.left > 80, `hero death → respawn timer (${JSON.stringify(ds)})`);
await page.evaluate(() => { const st = window.world.heroes.state[0]; st.respawnAt = window.world.clock.t; });
await page.waitForTimeout(800);
check(await page.evaluate(() => window.world.heroes.state[0].state === 'alive'), 'hero respawns at cc');

await browser.close(); server.close();
if (errors.length) { console.error('CONSOLE ERRORS:\n' + errors.slice(0, 10).join('\n')); fails.push('console errors'); }
if (fails.length) { console.error('FAILED: ' + fails.join('; ')); process.exit(1); }
console.log('OK heroes');
