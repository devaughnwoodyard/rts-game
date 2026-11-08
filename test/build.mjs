// BASE BUILDING v3 test: build mode UI -> 6-segment wall, widen 4, 2 MG turrets on slots, buy tech; asserts costs,
// obstacles, slots, crew gating of fire. Screenshots test/out/build-*.png. Usage: node test/build.mjs
import { chromium } from 'playwright';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.glb': 'model/gltf-binary', '.hdr': 'application/octet-stream' };
const server = http.createServer((q, r) => { let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
await new Promise(r => server.listen(0, r));
const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await (await b.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1 })).newPage();
const errs = []; page.on('pageerror', e => errs.push(String(e))); page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
fs.mkdirSync(path.join(root, 'test/out'), { recursive: true });
const shot = n => page.screenshot({ path: path.join(root, `test/out/build-${n}.png`) });
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.waitForTimeout(9000);
await page.waitForFunction(() => window.world?.buildMode && window.world?.defense, null, { timeout: 30000 });

// rich wallet, aerial view, find a free 24u wall spot in front of the cc, centre the camera on it
const spot = await page.evaluate(() => {
  const w = window.world, d = w.defense, s = w.sim;
  w.clock.speed = 0.0001;                                // freeze the battle while we build
  if (s.crystals) s.crystals[0] = 99999;
  try { w.econ?.add?.(0, { primary: 99999, secondary: 99999 }); } catch (e) {}
  w.setView('aerial');
  const cc = w.entities.find(e => e.kind === 'cc' && e.team === 0);
  const face = Math.atan2(-cc.z, -cc.x);
  for (const R of [16, 20, 24, 28, 14, 32]) for (const da of [0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2]) {
    const a = face + da, cx = cc.x + Math.cos(a) * R, cz = cc.z + Math.sin(a) * R;
    const tx = -Math.sin(a), tz = Math.cos(a);
    const p = d.planWall(0, cx - tx * 12, cz - tz * 12, cx + tx * 12, cz + tz * 12);
    if (p.ok && p.n === 6) { w.jumpTo(cx, cz); w.zoomBy?.(0.6); return { x0: cx - tx * 12, z0: cz - tz * 12, x1: cx + tx * 12, z1: cz + tz * 12 }; }
  }
  return null;
});
ok(!!spot, 'found a free 6-segment wall spot');
await page.waitForTimeout(800);
const scr = (x, z, y = 0) => page.evaluate(([x, y, z]) => window.world.project(x, y, z), [x, y, z]);
const bal = () => page.evaluate(() => window.world.defense.balance(0).secondary);
const click = sel => page.click(`[data-bm="${sel}"]`);

await click('build');
ok(await page.evaluate(() => window.world.input.mode === 'build'), 'Build button enters build mode (input.mode=build)');
await click('tool-wall');
const nObs0 = await page.evaluate(() => window.world.obstacles.length);
const b0 = await bal();
const a = await scr(spot.x0, spot.z0), c = await scr(spot.x1, spot.z1);
await page.mouse.move(a.x, a.y); await page.mouse.down();
for (let i = 1; i <= 12; i++) await page.mouse.move(a.x + (c.x - a.x) * i / 12, a.y + (c.y - a.y) * i / 12);
await page.mouse.up();
await page.waitForTimeout(400);
const info = await page.textContent('#bm-info');
ok(/6 seg/.test(info), 'live wall preview shows 6 segments: ' + info);
await shot('wall-preview');
await click('ok'); await page.waitForTimeout(300);
const wall = await page.evaluate(() => { const L = [...window.world.defense._lines.values()].filter(l => l.team === 0).pop(); return L && { id: L.id, segs: L.segs.map(s => ({ x: s.x, z: s.z, id: s.id })) }; });
ok(wall?.segs.length === 6, 'wall line has 6 segments');
const b1 = await bal();
ok(b0 - b1 === 60, `wall cost deducted (${b0 - b1} == 60)`);
ok(await page.evaluate(n => window.world.obstacles.length - n, nObs0) === 6, 'six wall obstacles registered');

// widen 4 segments via tap -> contextual "Widen"
await click('tool-wall'); // toggle tool off -> tap mode
for (let i = 0; i < 4; i++) {
  const p = await scr(wall.segs[i].x, wall.segs[i].z, 1);
  await page.mouse.click(p.x, p.y); await page.waitForTimeout(150);
  await click('act-widen'); await page.waitForTimeout(100);
}
const slots = await page.evaluate(id => window.world.defense._lines.get(id).slots.map(s => ({ x: s.x, z: s.z })), wall.id);
ok(slots.length === 2, `4 widened segments -> ${slots.length} turret slots (want 2)`);
const b2 = await bal();
ok(b1 - b2 === 120, `widen cost deducted (${b1 - b2} == 4x30)`);
ok(await page.evaluate(id => window.world.defense._lines.get(id).segs.slice(0, 4).every(s => s._obs.r >= 3), wall.id), 'widened walls have thicker obstacles');
await shot('widened');

// buy a tech (MG Turrets) in the Tech tab
await click('back').catch(() => {});
await click('tab-tech');
const mgCost = await page.evaluate(() => window.world.defense.tierInfo(0).list[0].cost);
await click('tech-mg'); await page.waitForTimeout(150);
const b3 = await bal();
ok(b2 - b3 === mgCost, `tech cost deducted (${b2 - b3} == ${mgCost})`);
await shot('tech');
await page.evaluate(() => window.world.defense.update(60));    // finish research
ok(await page.evaluate(() => window.world.defense.unlocked(0, 'turret_mg')), 'MG turret unlocked by tech');

// place 2 MG turrets onto slots (ghost snaps)
await click('tab-build'); await click('tool-turret_mg');
for (const s of slots) {
  const p = await scr(s.x + 1.2, s.z + 0.8, 0);
  await page.mouse.move(p.x - 30, p.y); await page.mouse.down(); await page.mouse.move(p.x - 10, p.y); await page.mouse.move(p.x, p.y); await page.mouse.up();
  await page.waitForTimeout(200);
  if (s === slots[0]) await shot('turret-ghost');
  await click('ok'); await page.waitForTimeout(200);
}
const turrets = await page.evaluate(() => [...window.world.defense._defs].filter(e => e.team === 0 && e.kind === 'turret_mg').map(e => ({ id: e.id, onWall: !!e.onWall, y: e.mesh?.position?.y, x: e.x, z: e.z, range: e.baseRange })));
ok(turrets.length === 2 && turrets.every(t => t.onWall && t.y >= 2), `2 turrets on wall slots at y+2 (${JSON.stringify(turrets.map(t => [t.onWall, t.y]))})`);
const b4 = await bal();
ok(b3 - b4 === 120, `turret cost deducted (${b3 - b4} == 2x60)`);

// crew gating: no crew -> no fire; crew -> fire
const fire = await page.evaluate((ids) => {
  const w = window.world, d = w.defense, s = w.sim;
  const t = [...d._defs].find(e => e.id === ids[0]);
  const kind = Object.keys(s.roster || {}).find(k => s.roster[k].faction === w.factions?.[1] && s.roster[k].role === 'heavy') || 'tank';
  const foe = s.spawn(kind, 1, t.x + 6, t.z + 4); foe.hp = foe.hpMax = 1e6;
  let shots = 0; const h = ev => { if (ids.includes(ev.detail?.shooter?.id)) shots++; };
  w.bus.addEventListener('shot', h);
  d.crewOverride[0] = 0;
  for (let i = 0; i < 30; i++) d.update(0.1);
  const noCrew = shots, unmanned = [...d._defs].filter(e => ids.includes(e.id)).every(e => e.unmanned);
  delete d.crewOverride[0];
  if (s.crystals) s.crystals[0] = s.crystals[0];
  for (let i = 0; i < 30; i++) d.update(0.1);
  w.bus.removeEventListener('shot', h);
  return { noCrew, unmanned, withCrew: shots - noCrew, pool: d.crewPool(0) };
}, turrets.map(t => t.id));
ok(fire.unmanned && fire.noCrew === 0, `unmanned turrets do not fire (${fire.noCrew} shots)`);
ok(fire.withCrew > 0, `crewed turrets fire (${fire.withCrew} shots, pool ${fire.pool})`);
await page.evaluate(() => { window.world.defense.crewOverride[0] = 0; window.world.defense.update(0.6); });
await page.waitForTimeout(400);
await shot('needs-crew');
await page.evaluate(() => { delete window.world.defense.crewOverride[0]; });

// wall dies -> turret on it dies
const cascade = await page.evaluate((id) => {
  const w = window.world, d = w.defense, L = d._lines.get(id), seg = L.segs[0];
  const t = L.slots[0].turret; w.sim.kill(seg); w.sim.update(0.02); w.sim.update(0.02);
  return { turretDead: t.state === 'dead', slots: L.slots.length };
}, wall.id);
ok(cascade.turretDead && cascade.slots === 1, 'turret on a wall dies with its segment');
await click('build');
ok(await page.evaluate(() => !window.world.buildMode.state.open && window.world.input.mode !== 'build'), 'second tap of Build closes build mode');
await shot('closed');
console.log('ERRORS', errs.length, errs.slice(0, 5).join('\n'));
await b.close(); server.close();
if (fails || errs.length) process.exit(1);
console.log('OK build test');
