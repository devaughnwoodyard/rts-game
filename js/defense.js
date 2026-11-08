// defense.js — turrets, walls, moat, gate, artillery, siege, 10 defense tiers, enemy defense AI.
// Owner: Defense worker. Exports createDefense(sim, world) -> { update, buildDefense, tierInfo }.
// Also sets world.defense to the returned object.
//
// TODO.md (stubs / assumptions):
// - Tunables live in the local DEF table below; if sim exposes sim.config.defense, its keys override
//   (shallow merge per key). Integrator may move them into config.js.
// - RPS multipliers applied HERE before sim.damage() (sim.damage applies dmg as given and emits `hit`).
// - All defense entities are spawned with external:true so sim skips their targeting; we use our own
//   cooldown field (e.dcd) because sim decrements e.cooldown for every entity.
// - Meshes face local +X (engine). Buildings aren't re-synced by sim, so we set mesh rotation/position here;
//   turret aim rotates mesh.userData.turret. Tall turrets raise the whole mesh by 1.5.
// - Gate obstacle carries {team}, but sim currently treats every world.obstacles entry as blocking all teams.
//   Workaround: the gate "opens" (its obstacle is pulled) while a friendly unit is near and no enemy is.
// - world.defense.hasSurveillance(team) and world.defense.reserveFor(team) are read by sim (enemyReserve = team 1).
// v2 (SIM-v2): 4 teams. Tier state, AI tier buying (teams 1..3), surveillance etc. are per team. Rings are centered
// on each team's cc and face the map center (works in all 4 corners, off-map segments skipped). Keep-out: nothing
// is placed on the base crystal field or in the lane cc->field (sim.bases[t]); turrets slide sideways away from
// the field. Ring 2 (R38) encloses the base field so the field is inside the defenses, ring 1 (R22) has the field
// lane as its front opening. Turret target scans use sim.near (spatial hash) when available.

import { CONFIG } from './config.js';

const ATTACK = {
  turret_mg:     { inf: 1.8, veh: 0.5, bld: 0 },
  turret_cannon: { inf: 0.6, veh: 1.8, bld: 0 },
  artillery:     { inf: 1.2, veh: 1.2, bld: 0.8 },
  siege:         { inf: 1.0, veh: 1.0, bld: 1.5 },
};

const DEF = {
  turret_mg:     { hp: 500,  range: 22, dps: 20,  cooldown: 0.25, r: 1.5 },
  turret_cannon: { hp: 800,  range: 26, dps: 32,  cooldown: 1.5,  r: 1.5 },
  artillery:     { hp: 600,  range: 45, dps: 14,  cooldown: 4,    r: 1.5, splash: 6, minRange: 6 },
  siege:         { hp: 1500, range: 60, dps: 75,  cooldown: 8,    r: 2.4, scale: 1.6 },
  wall:          { hp: 700,  r: 2.2 },
  gate:          { hp: 2000, r: 2.5, regen: 10, blockR: 4.2 },
  ring1: 22, ring2: 38, segLen: 4, laneClear: 4,
  tallRange: 1.4, tallY: 1.5,
  nightPenalty: 0.2,
  aiStart: 120, aiInterval: 240, aiReserveLead: 150, aiMinInterval: 120, aiAheadScale: 0.15,
};

const TAU = Math.PI * 2;
const angDiff = (a, b) => { let d = (a - b) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return Math.abs(d); };
const fin = (v, d = 0) => (Number.isFinite(v) ? v : d);

// Pull shared tunables from config.js (single source of truth); local DEF is the fallback.
for (const k of ['turret_mg', 'turret_cannon', 'artillery', 'wall', 'gate']) {
  const c = CONFIG?.defenses?.[k]; if (!c) continue;
  for (const f of ['hp', 'r', 'range', 'dps', 'cooldown', 'splash', 'minRange']) if (Number.isFinite(c[f]) && (c[f] > 0 || f === 'minRange')) DEF[k][f] = c[f];
  if (k === 'wall') DEF.wall.r = Math.max(DEF.wall.r, 2.2);
}
for (const k in ATTACK) if (CONFIG?.rps?.[k]) ATTACK[k] = { ...ATTACK[k], ...CONFIG.rps[k] };
if (CONFIG?.defenses?.siege) Object.assign(DEF.siege, CONFIG.defenses.siege);
if (CONFIG?.dayNight?.nightTurretRangeMul) DEF.nightPenalty = 1 - CONFIG.dayNight.nightTurretRangeMul;

export function createDefense(sim, world) {
  if (sim?.config?.defense) for (const k in sim.config.defense) {
    const v = sim.config.defense[k];
    DEF[k] = (v && typeof v === 'object' && DEF[k] && typeof DEF[k] === 'object') ? { ...DEF[k], ...v } : v;
  }
  world.obstacles = world.obstacles || [];
  world.ui = world.ui || {};
  const NT = sim?.teamCount || world.teams?.count || 4;
  world.ui.surveillanceBy = world.ui.surveillanceBy || {};
  for (let t = 0; t < NT; t++) if (world.ui.surveillanceBy[t] == null) world.ui.surveillanceBy[t] = false;
  world.ui.enemyTiers = world.ui.enemyTiers || new Array(NT).fill(0);
  if (world.ui.defenseTier == null) world.ui.defenseTier = 0;
  if (world.ui.enemyTier == null) world.ui.enemyTier = 0;
  world.ui.defenseBuild = null;

  const defs = new Set();               // live defense entities we drive
  const T = Array.from({ length: NT }, (_, team) => ({
    team, tier: 0, building: null,      // building: {tier, name, t, total}
    tall: false, lastTierAt: DEF.aiStart - DEF.aiInterval,
    base: null,                         // {x, z, face}
  }));

  const emit = (name, detail) => { try { world.bus?.dispatchEvent(new CustomEvent(name, { detail })); } catch (e) { /* no bus */ } };
  const now = () => fin(world.clock?.t);
  const alive = e => e && e.hp > 0 && e.state !== 'dead';
  const ents = () => world.entities || sim?.entities || [];

  // ---------- base geometry ----------
  function baseOf(team) {
    const st = T[team];
    const cc = ents().find(e => e.kind === 'cc' && e.team === team && alive(e));
    if (cc) st.base = { x: cc.x, z: cc.z, face: Math.atan2(-cc.z, -cc.x), cc };
    if (!st.base) {
      const q = CONFIG.teams?.quad?.[team] || [team === 0 ? -1 : 1, 0];
      const x = q[0] * (world.map?.w ?? 160) * 0.39, z = q[1] * (world.map?.h ?? 100) * 0.34;
      st.base = { x, z, face: Math.atan2(-z, -x), cc: null };
    }
    if (!Number.isFinite(st.base.face) || (st.base.x === 0 && st.base.z === 0)) st.base.face = team === 0 ? 0 : Math.PI;
    return st.base;
  }
  // Base crystal field (from sim) as {x, z, r}; null if unknown.
  function fieldOf(team) {
    const b = sim?.bases?.[team];
    if (!b) return null;
    const live = (b.fieldEnts || []).filter(c => c && c.state !== 'dead');
    if (!live.length) return b.field || null;
    let x = 0, z = 0; for (const c of live) { x += c.x; z += c.z; } x /= live.length; z /= live.length;
    let r = 0; for (const c of live) r = Math.max(r, Math.hypot(c.x - x, c.z - z) + (c.r || 1.8));
    return { x, z, r: Math.max(r, b.field?.r || 0) };
  }
  // Inside the keep-out (crystal field + lane from cc to field)? r = footprint radius of the thing placed.
  function inKeepOut(team, x, z, r) {
    const f = fieldOf(team), b = baseOf(team);
    if (!f) return false;
    const pad = f.r + DEF.laneClear + r;
    if (Math.hypot(x - f.x, z - f.z) < pad + 1) return true;
    const dx = f.x - b.x, dz = f.z - b.z, L2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - b.x) * dx + (z - b.z) * dz) / L2));
    return Math.hypot(x - (b.x + dx * t), z - (b.z + dz * t)) < pad;
  }
  const inMap = (x, z, m = 1) => Math.abs(x) <= (world.map?.w ?? 160) / 2 - m && Math.abs(z) <= (world.map?.h ?? 100) / 2 - m;
  function blockedBy(x, z, r, ignoreWalls) {
    for (const e of ents()) {
      if (!alive(e) && e.kind !== 'crystal') continue;
      if (e.cls !== 'bld' && e.kind !== 'crystal') continue;
      if (ignoreWalls && (e.kind === 'wall' || e.kind === 'gate')) continue;
      const d = Math.hypot(e.x - x, e.z - z);
      if (d < (e.r || 1) + r) return true;
    }
    for (const o of world.obstacles) if (!o.team && o.owner == null && Math.hypot(o.x - x, o.z - z) < o.r + r) return true;
    return false;
  }
  function freeSpot(x, z, r) {
    if (!blockedBy(x, z, r) && inMap(x, z, r)) return { x, z };
    for (let ring = 1; ring <= 6; ring++) for (let k = 0; k < 8 * ring; k++) {
      const a = (k / (8 * ring)) * TAU, nx = x + Math.cos(a) * ring * 1.5, nz = z + Math.sin(a) * ring * 1.5;
      if (!blockedBy(nx, nz, r) && inMap(nx, nz, r)) return { x: nx, z: nz };
    }
    return { x, z };
  }

  // ---------- spawning ----------
  function spawnDef(kind, team, x, z, opts = {}) {
    if (!sim?.spawn) return null;
    const statKey = opts.siege ? 'siege' : kind;
    const s = DEF[statKey];
    const e = sim.spawn(kind, team, x, z);
    if (!e) return null;
    e.cls = 'bld'; e.team = team; e.x = x; e.z = z;
    e.hp = e.hpMax = s.hp; e.r = s.r; e.def = true; e.defenseRPS = true;
    e.external = true; e.dcd = 0; e.state = 'idle'; e.target = null;
    if (opts.siege) { e.siege = true; if (e.mesh?.scale) e.mesh.scale.multiplyScalar?.(s.scale); }
    if (s.range) {
      e.baseRange = s.range; e.range = s.range; e.dps = s.dps; e.fireCd = s.cooldown;
      e.atkKey = statKey;
      e.canHitAir = kind === 'turret_mg'; e.canHitGround = true;   // MG doubles as AA; cannons/artillery can't hit air
      if (T[team].tall && !opts.siege) makeTall(e);
    }
    // mesh faces +X: rotation.y = -angle (world angle measured atan2(z, x))
    const ry = opts.rot != null ? opts.rot : -baseOf(team).face;
    e.rot = ry; if (e.mesh?.rotation) e.mesh.rotation.y = ry;
    if (kind === 'wall' || kind === 'gate') {
      const o = { x, z, r: kind === 'gate' ? s.blockR : s.r, owner: e };
      if (kind === 'gate') o.team = team;
      e._obs = o; world.obstacles.push(o);
    }
    defs.add(e);
    emit('built', { entity: e });
    return e;
  }
  function makeTall(e) {
    if (e.tall) return;
    e.tall = true; e.baseRange *= DEF.tallRange; e.yOff = (e.yOff || 0) + DEF.tallY;
    if (e.mesh?.position) e.mesh.position.y += DEF.tallY;
  }
  function removeObs(e) {
    if (!e?._obs) return;
    const i = world.obstacles.indexOf(e._obs);
    if (i >= 0) world.obstacles.splice(i, 1);
    e._obs = null;
  }
  world.bus?.addEventListener?.('died', ev => {
    const e = ev.detail?.entity; if (!e) return;
    removeObs(e); defs.delete(e);
  });

  // ring of walls with gaps (gaps: array of absolute angles, gapHalf in radians)
  function wallRing(team, R, gaps) {
    const b = baseOf(team);
    const n = Math.max(8, Math.round(TAU * R / DEF.segLen));
    const gapHalf = (DEF.segLen * 1.5) / R; // skip ~2-3 segments per gap → ~8 units clear
    const made = [];
    for (let i = 0; i < n; i++) {
      const a = b.face + (i / n) * TAU;
      if (gaps.some(g => angDiff(a, g) < gapHalf)) continue;
      const x = b.x + Math.cos(a) * R, z = b.z + Math.sin(a) * R;
      if (!inMap(x, z, 1)) continue;
      if (inKeepOut(team, x, z, 2.2)) continue;
      if (blockedBy(x, z, 1.6, true)) continue;
      const w = spawnDef('wall', team, x, z, { rot: -a - Math.PI / 2 });
      if (w) { w.ringR = R; w.ringA = a; made.push(w); }
    }
    return made;
  }
  // fill a gap arc on ring R centered at angle g
  function fillGap(team, R, g) {
    const b = baseOf(team);
    const n = Math.max(8, Math.round(TAU * R / DEF.segLen));
    const gapHalf = (DEF.segLen * 1.5) / R;
    for (let i = 0; i < n; i++) {
      const a = b.face + (i / n) * TAU;
      if (angDiff(a, g) >= gapHalf) continue;
      const x = b.x + Math.cos(a) * R, z = b.z + Math.sin(a) * R;
      if (!inMap(x, z, 1)) continue;
      if (inKeepOut(team, x, z, 2.2)) continue;
      if (blockedBy(x, z, 1.6, true)) continue;
      const w = spawnDef('wall', team, x, z, { rot: -a - Math.PI / 2 });
      if (w) { w.ringR = R; w.ringA = a; }
    }
  }
  // Polar spot around the cc; slides sideways (away from the field direction) out of the keep-out.
  const polar = (team, R, da) => {
    const b = baseOf(team), sgn = da >= 0 ? 1 : -1;
    for (let k = 0; k < 24; k++) {
      const a = b.face + da + sgn * k * 0.12;
      const x = b.x + Math.cos(a) * R, z = b.z + Math.sin(a) * R;
      if (inKeepOut(team, x, z, 2) || !inMap(x, z, 3)) continue;
      const p = freeSpot(x, z, 2);
      if (!inKeepOut(team, p.x, p.z, 2)) return p;
    }
    const a = b.face + da; return freeSpot(b.x + Math.cos(a) * R, b.z + Math.sin(a) * R, 2);
  };
  const place = (kind, team, R, da, opts) => { const p = polar(team, R, da); return spawnDef(kind, team, p.x, p.z, opts); };

  // ---------- tiers ----------
  const G1 = [0, TAU / 3, -TAU / 3], G2 = [0, Math.PI];
  const TIERS = [
    { name: 'MG Turrets',       cost: 250,  buildTime: 60,  apply: t => { place('turret_mg', t, 17, 0.6); place('turret_mg', t, 17, -0.6); } },
    { name: 'Wall Ring',        cost: 350,  buildTime: 75,  apply: t => { const f = baseOf(t).face; wallRing(t, DEF.ring1, G1.map(g => f + g)); } },
    { name: 'Cannon Turrets',   cost: 450,  buildTime: 90,  apply: t => { place('turret_cannon', t, 15, 0.9); place('turret_cannon', t, 15, -0.9); } },
    { name: 'Extended Wall',    cost: 550,  buildTime: 100, apply: t => { const f = baseOf(t).face; wallRing(t, DEF.ring2, G2.map(g => f + g)); } },
    { name: 'Moat',             cost: 650,  buildTime: 110, apply: t => { const f = baseOf(t).face; fillGap(t, DEF.ring1, f + G1[1]); fillGap(t, DEF.ring1, f + G1[2]); fillGap(t, DEF.ring2, f + G2[1]); } },
    { name: 'Tall Turrets',     cost: 750,  buildTime: 120, apply: t => { T[t].tall = true; for (const e of defs) if (e.team === t && e.baseRange && !e.siege) makeTall(e); } },
    { name: 'Artillery Battery',cost: 900,  buildTime: 135, apply: t => { place('artillery', t, 12, Math.PI / 2); place('artillery', t, 12, -Math.PI / 2); } },
    { name: 'Surveillance',     cost: 1000, buildTime: 145, apply: t => { world.ui.surveillanceBy[t] = true; if (t === 0) world.ui.surveillance = true; } },
    { name: 'Shield Gate',      cost: 1200, buildTime: 160, apply: t => { const b = baseOf(t); const g = spawnDef('gate', t, b.x + Math.cos(b.face) * DEF.ring2, b.z + Math.sin(b.face) * DEF.ring2, { rot: -b.face }); if (g) g.regen = DEF.gate.regen; } },
    { name: 'Siege Cannon',     cost: 1400, buildTime: 180, apply: t => { place('artillery', t, 11, Math.PI, { siege: true }); } },
  ];

  function buildDefense(team = 0) {
    const st = T[team];
    if (!st) return { ok: false, reason: 'bad team' };
    if (st.building) return { ok: false, reason: 'busy' };
    if (st.tier >= TIERS.length) return { ok: false, reason: 'maxed' };
    const td = TIERS[st.tier];
    if (!sim?.spendCrystals?.(team, td.cost)) return { ok: false, reason: 'crystals' };
    st.building = { tier: st.tier + 1, name: td.name, t: 0, total: td.buildTime };
    if (team === 0) world.ui.defenseBuild = { tier: st.tier + 1, name: td.name, progress: 0 };
    return { ok: true };
  }

  function tierInfo(team = 0) {
    const st = T[team]; if (!st) return null;
    const td = TIERS[st.tier];
    return {
      current: st.tier,
      next: td ? { tier: st.tier + 1, name: td.name, cost: td.cost, buildTime: td.buildTime } : null,
      building: st.building ? { tier: st.building.tier, name: st.building.name,
        progress: st.building.t / st.building.total, remaining: Math.max(0, st.building.total - st.building.t) } : null,
    };
  }

  function stepBuild(st, dt) {
    const b = st.building; if (!b) return;
    b.t += dt;
    if (st.team === 0) world.ui.defenseBuild = { tier: b.tier, name: b.name, progress: Math.min(1, b.t / b.total) };
    if (b.t < b.total) return;
    st.building = null;
    try { TIERS[b.tier - 1].apply(st.team); } catch (e) { console.warn('[defense] tier apply failed', e); }
    st.tier = b.tier; st.lastTierAt = now();
    if (st.team === 0) { world.ui.defenseTier = st.tier; world.ui.defenseBuild = null; }
    else { world.ui.enemyTiers[st.team] = st.tier; world.ui.enemyTier = Math.max(...T.slice(1).map(s => s.tier)); }
    emit('tier', { team: st.team, tier: st.tier, name: b.name });
    if (st.team === 0) emit('message', { text: `Defense tier ${st.tier}: ${b.name} online`, ms: 2500 });
  }

  function stepAI() {
    for (let t = 1; t < NT; t++) {
      const st = T[t];
      if (st.building || st.tier >= TIERS.length || now() < DEF.aiStart) continue;
      if (!ents().some(e => e.kind === 'cc' && e.team === t && alive(e))) continue;  // eliminated
      let top = 0; for (const o of T) if (o !== st) top = Math.max(top, o.tier);
      const ahead = Math.max(0, top - st.tier);
      const interval = Math.max(DEF.aiMinInterval, DEF.aiInterval / (1 + DEF.aiAheadScale * ahead));
      if (now() - st.lastTierAt < interval) continue;
      buildDefense(t);
    }
  }

  // ---------- combat ----------
  function effRange(e) {
    const night = fin(world.ui?.nightFactor);
    const pen = world.ui.surveillanceBy[e.team] ? 0 : DEF.nightPenalty * Math.max(0, Math.min(1, night));
    return e.baseRange * (1 - pen);
  }
  const isUnit = v => (v.cls === 'inf' || v.cls === 'veh');
  const isEnemy = (e, v) => v.team !== e.team && v.team !== -1 && v.team != null && alive(v) && (sim?.canHit ? sim.canHit(e, v) : true);
  const qBuf = [];
  const around = (e, range) => (sim?.near ? sim.near(e.x, e.z, range, qBuf) : ents());
  function acquire(e, range, allowBld) {
    let best = null, bd = Infinity;
    const cand = around(e, range);
    for (const v of cand) {
      if (!isEnemy(e, v) || !isUnit(v)) continue;
      const d = Math.hypot(v.x - e.x, v.z - e.z);
      if (d <= range && d < bd && d >= (DEF[e.atkKey].minRange || 0)) { bd = d; best = v; }
    }
    if (!best && allowBld) for (const v of cand) {
      if (!isEnemy(e, v) || v.cls !== 'bld') continue;
      const d = Math.hypot(v.x - e.x, v.z - e.z) - (v.r || 0);
      if (d <= range && d < bd) { bd = d; best = v; }
    }
    return best;
  }
  function hitOne(e, v, base) {
    const mult = ATTACK[e.atkKey]?.[v.cls] ?? 1;
    const dmg = base * mult;
    if (!(dmg > 0)) return;
    sim.damage?.(v, e, dmg);
  }
  function fire(e, v) {
    const base = e.dps * e.fireCd;
    const y0 = 2.2 + (e.yOff || 0);
    emit('shot', { from: { x: e.x, z: e.z, y: y0 }, to: { x: v.x, z: v.z, y: v.cls === 'bld' ? 1.5 : 1 }, kind: e.siege ? 'siege' : e.kind });
    if (e.kind === 'artillery' && !e.siege) {
      const R = DEF.artillery.splash, tx = v.x, tz = v.z;
      const cand = (sim?.near ? sim.near(tx, tz, R, []) : ents().slice());
      for (const u of cand) if (isEnemy(e, u) && Math.hypot(u.x - tx, u.z - tz) <= R + (u.cls === 'bld' ? (u.r || 0) : 0)) hitOne(e, u, base);
    } else hitOne(e, v, base);
  }
  function stepTurret(e, dt) {
    e.dcd = Math.max(0, fin(e.dcd) - dt);
    const range = effRange(e); e.range = range;
    const allowBld = (e.team !== 0 && e.kind === 'artillery'); // enemy artillery + siege hit player buildings when idle
    let v = e.target;
    const valid = v && alive(v) && isEnemy(e, v) && Math.hypot(v.x - e.x, v.z - e.z) - (v.cls === 'bld' ? v.r || 0 : 0) <= range && (isUnit(v) || allowBld);
    // prefer units: if locked on a building, recheck for units
    if (!valid || (v.cls === 'bld' && e.dcd <= 0)) v = acquire(e, range, allowBld);
    e.target = v || null;
    e.state = v ? 'attack' : 'idle';
    if (!v) return;
    const aim = Math.atan2(-(v.z - e.z), v.x - e.x); // +X-forward yaw
    const tur = e.mesh?.userData?.turret;
    if (tur?.rotation) tur.rotation.y = aim - (e.mesh.rotation?.y || 0);
    else if (e.mesh?.rotation) { e.mesh.rotation.y = aim; e.rot = aim; }
    if (e.dcd <= 0) { e.dcd = e.fireCd; fire(e, v); }
  }

  const qGate = [];
  function stepGate(g, dt) {
    if (g.regen) g.hp = Math.min(g.hpMax, g.hp + g.regen * dt);
    let friend = false, foe = false;
    for (const u of (sim?.near ? sim.near(g.x, g.z, 9, qGate) : ents())) {
      if (!isUnit(u) || !alive(u)) continue;
      const d = Math.hypot(u.x - g.x, u.z - g.z);
      if (d > 9) continue;
      if (u.team === g.team) friend = true; else if (u.team !== -1) foe = true;
    }
    const open = friend && !foe;
    if (open && g._obs) { g._closedObs = g._obs; removeObs(g); }
    else if (!open && !g._obs && g._closedObs) { g._obs = g._closedObs; world.obstacles.push(g._obs); }
    g.open = open;
  }

  function update(dt) {
    dt = fin(dt, fin(world.clock?.dt));
    if (dt <= 0) return;
    for (const st of T) stepBuild(st, dt);
    stepAI();
    for (const e of defs) {
      if (!alive(e)) { removeObs(e); e._closedObs = null; defs.delete(e); continue; }
      if (e.kind === 'gate') stepGate(e, dt);
      if (e.baseRange) stepTurret(e, dt);
    }
  }

  function reserveFor(team) {
    const st = T[team]; if (!st || team === 0) return 0;
    const td = TIERS[st.tier];
    if (!td || st.building) return 0;
    const due = Math.max(DEF.aiStart, st.lastTierAt + DEF.aiInterval);
    return now() >= due - DEF.aiReserveLead ? td.cost : 0;
  }

  const api = {
    update, buildDefense, tierInfo, tiers: TIERS, _state: T, _defs: defs,
    hasSurveillance: team => !!world.ui.surveillanceBy[team],
    // crystals the enemy army AI should keep banked so tiers stay affordable (sim reads this)
    reserveFor,
    get enemyReserve() { return reserveFor(1); },
  };
  world.defense = api;
  return api;
}
