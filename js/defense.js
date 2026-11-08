// defense.js — BASE BUILDING v3: player-built walls/gates/turrets, wall widening + turret slots, crew, defense TECH
// unlocks (bought with SECONDARY at the cc), faction tech abilities (thornwall/spikes/minefield/sandstorm/...), AI auto-planner.
// Owner: BUILDER worker. Exports createDefense(sim, world) -> api (also world.defense). UI lives in js/buildmode.js.
//
// TODO.md (stubs / assumptions):
// - ECONOMY v3 (world.econ) is read defensively. Assumed shapes: econ.canAfford(team, {primary, secondary}) -> bool,
//   econ.spend(team, {primary, secondary}) -> bool, econ.refund|add(team, {primary, secondary}), econ.requestCrew(entity,
//   n) -> bool|undefined (undefined = econ manages entity.unmanned itself), econ.releaseCrew(entity),
//   econ.plotActions(plot) -> [{id,label,cost,enabled,run()}], econ.placeBuilding(team, kind, x, z) -> entity,
//   econ.currencyName(team, 'secondary'). Without econ everything is paid with sim.spendCrystals and crew comes from
//   free supply (supplyCap - unit supply).
// - RPS multipliers applied HERE before sim.damage(). Defense entities are external:true (sim skips their targeting);
//   own cooldown field e.dcd.
// - Meshes face local +X; wall length = local X, thickness = local Z (widened walls scale.z = 2). Turrets on widened
//   walls sit at y = DEF.wallTop (mesh.position.y). Buildings aren't re-synced by sim, so we position meshes here.
// - Gates: team-tagged world.obstacles circle (sim + pathing let own team through).
// - Walls never go on land plots / extractors / processors / housing; a segment crossing a harvester lane (owned
//   extractor -> nearest processor/cc) is auto-built as a free gate (own harvesters pass).
// - Moats removed (CONTRACT update): Earth T5 = Thornwall (team-tagged root barrier ring, contact dmg+slow), Volcanic T5 =
//   Obsidian Spike Field (non-blocking spike patches, dmg+slow), Vanguard T5 = Hardened Bunkers (turrets +40% hp),
//   Storm T5 = Sandstorm Wall; Vanguard T7 = Minefield Belt. world.ui.baseLevel[team] (0-3) + 'baselevel' bus event.
// - Tech list per faction keeps the v2 tier names. For the PLAYER, techs only unlock things (wall grades, turret
//   types, gates) or trigger abilities (thornwall / spike field / minefield / sandstorm / tall turrets / surveillance). The AI
//   auto-planner places walls/turrets with the same placement functions the player uses.
// - Housing / Processor: econ.placeBuilding when present, else a local fallback (primary cost, barracks/factory mesh).

import { CONFIG } from './config.js';

const ATTACK = {
  turret_mg:     { inf: 1.8, veh: 0.5, bld: 0 },
  turret_cannon: { inf: 0.6, veh: 1.8, bld: 0 },
  turret_aa:     { inf: 0, veh: 0, bld: 0, air: 1.6 },
  artillery:     { inf: 1.2, veh: 1.2, bld: 0.8 },
  siege:         { inf: 1.0, veh: 1.0, bld: 1.5 },
};

const DEF = {
  turret_mg:     { hp: 500,  range: 22, dps: 20,  cooldown: 0.25, r: 1.5 },
  turret_cannon: { hp: 800,  range: 26, dps: 32,  cooldown: 1.5,  r: 1.5 },
  turret_aa:     { hp: 600,  range: 28, dps: 34,  cooldown: 0.5,  r: 1.5 },
  artillery:     { hp: 600,  range: 45, dps: 14,  cooldown: 4,    r: 1.5, splash: 6, minRange: 6 },
  siege:         { hp: 1500, range: 60, dps: 75,  cooldown: 8,    r: 2.4, scale: 1.6 },
  wall:          { hp: 700,  r: 2.2 },
  gate:          { hp: 1000, r: 2.5, blockR: 2.4 },
  shieldGate:    { hp: 2000, regen: 10 },
  ring1: 22, ring2: 38, segLen: 4, grid: 2, laneClear: 4,
  wideR: 3.0, wallTop: 2.0, slotRange: 1.3, buildRadius: 75,
  tallRange: 1.4, tallY: 1.5,
  nightPenalty: 0.2,
  // SECONDARY costs (primary for housing/processor)
  cost: { wall: 10, widenMul: 3, gate: 25, turret_mg: 60, turret_cannon: 90, turret_aa: 80, artillery: 140, siege: 300,
          housing: 120, processor: 220 },
  crew: { turret_mg: 2, turret_cannon: 3, turret_aa: 3, artillery: 4, siege: 6 },
  grades: [{ name: 'Basic', hp: 1 }, { name: 'Reinforced', hp: 1.6 }, { name: 'Fortified', hp: 2.4 }],
  techCostMul: 0.4, techTimeMul: 0.5,
  aiStart: 120, aiInterval: 240, aiReserveLead: 150, aiMinInterval: 120, aiAheadScale: 0.15, aiPlanEvery: 2,
};
const SEC_NAME = { vanguard: 'Fuel', volcanic: 'Pressure', earth: 'Wind', storm: 'Water' };
const PRI_NAME = { vanguard: 'Steel', volcanic: 'Ore', earth: 'Sunlight', storm: 'Charge' };
const AA_NAME = { vanguard: 'Flak Turret', volcanic: 'Ash Flak', earth: 'Thorn Spire', storm: 'Arc Mast' };
const ARTILLERY_FACTIONS = new Set(['volcanic']);
const CREWED = new Set(['turret_mg', 'turret_cannon', 'turret_aa', 'artillery']);

const TAU = Math.PI * 2;
const angDiff = (a, b) => { let d = (a - b) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return Math.abs(d); };
const fin = (v, d = 0) => (Number.isFinite(v) ? v : d);

for (const k of ['turret_mg', 'turret_cannon', 'artillery', 'wall', 'gate']) {
  const c = CONFIG?.defenses?.[k]; if (!c) continue;
  for (const f of ['hp', 'r', 'range', 'dps', 'cooldown', 'splash', 'minRange']) if (Number.isFinite(c[f]) && (c[f] > 0 || f === 'minRange')) DEF[k][f] = c[f];
  if (k === 'wall') DEF.wall.r = Math.max(DEF.wall.r, 2.2);
}
for (const k in ATTACK) if (CONFIG?.rps?.[k]) ATTACK[k] = { ...ATTACK[k], ...CONFIG.rps[k] };
if (CONFIG?.defenses?.siege) Object.assign(DEF.siege, CONFIG.defenses.siege);
if (CONFIG?.dayNight?.nightTurretRangeMul) DEF.nightPenalty = 1 - CONFIG.dayNight.nightTurretRangeMul;
// ECONOMY v3 prices/crew (CONFIG.econ) are the source of truth when present.
{
  const ec = CONFIG?.econ?.costs || {};
  for (const k of ['wall', 'gate', 'turret_mg', 'turret_cannon', 'turret_aa', 'artillery', 'siege']) if (Number.isFinite(ec[k]?.secondary)) DEF.cost[k] = ec[k].secondary;
  if (Number.isFinite(ec.wallWidenMul)) DEF.cost.widenMul = ec.wallWidenMul;
  for (const k of ['housing', 'processor']) if (ec[k]) DEF.cost[k] = ec[k].primary ?? DEF.cost[k];
  const cr = CONFIG?.econ?.crew || {};
  for (const k in DEF.crew) if (Number.isFinite(cr[k])) DEF.crew[k] = cr[k];
}

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

  const defs = new Set();               // live defense entities we drive (walls, gates, turrets)
  const lines = new Map();              // lineId -> {id, team, segs:[wall|gate|null], slots:[{i,x,z,rot,turret}]}
  let nextLine = 1;
  const T = Array.from({ length: NT }, (_, team) => ({
    team, researched: new Set(), building: null, tall: false, lastTierAt: DEF.aiStart - DEF.aiInterval,
    base: null, unlocks: new Set(['wall', 'widen', 'housing', 'processor']), grade: 1, wallRegen: 0, staticCoils: false,
    shieldGates: false, ai: team > 0 ? { q: [], started: false, nextPlan: 0, rings: {} } : null,
  }));
  const crewOverride = {};              // tests: crewOverride[team] = n forces the crew pool

  const emit = (name, detail) => { try { world.bus?.dispatchEvent(new CustomEvent(name, { detail })); } catch (e) { /* no bus */ } };
  const now = () => fin(world.clock?.t);
  const alive = e => e && e.hp > 0 && e.state !== 'dead';
  const ents = () => world.entities || sim?.entities || [];
  const factionOf = (team) => world.factions?.[team] || CONFIG.teams?.factions?.[team];
  const isUnit = v => (v.cls === 'inf' || v.cls === 'veh');

  // ---------- economy bridge (ECONOMY v3, defensive) ----------
  const E = () => world.econ;
  const C = (secondary = 0, primary = 0) => ({ primary, secondary });
  const total = c => fin(c.primary) + fin(c.secondary);
  function canPay(team, c) {
    const ec = E();
    if (typeof ec?.canAfford === 'function') { try { return !!ec.canAfford(team, c); } catch (e) { /* fallthrough */ } }
    return fin(sim?.crystals?.[team]) >= total(c);
  }
  function pay(team, c, cat = 'defense') {
    if (total(c) <= 0) return true;
    const ec = E();
    if (team > 0 && typeof ec?.aiCanSpend === 'function' && !ec.aiCanSpend(team, c, cat)) return false;
    if (typeof ec?.spend === 'function') { try { return !!ec.spend(team, c, cat); } catch (e) { return false; } }
    return !!sim?.spendCrystals?.(team, total(c));
  }
  function refund(team, c) {
    const ec = E();
    if (typeof ec?.add === 'function') {   // econ.add(team, kind, n, isIncome)
      try { if (c.primary > 0) ec.add(team, 'primary', c.primary, false); if (c.secondary > 0) ec.add(team, 'secondary', c.secondary, false); return; } catch (e) { /* fallthrough */ }
    }
    if (sim?.crystals) sim.crystals[team] = fin(sim.crystals[team]) + total(c);
  }
  function balance(team) {
    const ec = E();
    const b = ec?.res?.[team];
    if (b && (b.secondary != null || b.primary != null)) return { primary: fin(b.primary), secondary: fin(b.secondary) };
    const c = fin(sim?.crystals?.[team]);
    return { primary: c, secondary: c, single: true };
  }
  function currencyName(team, which = 'secondary') {
    const n = E()?.names?.(team)?.[which];
    if (n) return n;
    if (!E()) return 'Crystals';
    return (which === 'primary' ? PRI_NAME : SEC_NAME)[factionOf(team)] || which;
  }

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
  function fieldOf(team) {
    const b = sim?.bases?.[team];
    if (!b) return null;
    const live = (b.fieldEnts || []).filter(c => c && c.state !== 'dead');
    if (!live.length) return b.field || null;
    let x = 0, z = 0; for (const c of live) { x += c.x; z += c.z; } x /= live.length; z /= live.length;
    let r = 0; for (const c of live) r = Math.max(r, Math.hypot(c.x - x, c.z - z) + (c.r || 1.8));
    return { x, z, r: Math.max(r, b.field?.r || 0) };
  }
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
  const ECON_BLOCK = new Set(['plot', 'extractor', 'processor', 'housing']);
  function blockedBy(x, z, r, ignoreWalls, ignore) {
    for (const e of ents()) {
      if (e === ignore) continue;
      if (e.isPlot || ECON_BLOCK.has(e.kind) || e.extractor || e.processor) {   // land plots + econ buildings
        if (e.state !== 'dead' && Math.hypot(e.x - x, e.z - z) < (e.r || 3) + r) return true;
        continue;
      }
      if (!alive(e) && e.kind !== 'crystal') continue;
      if (e.cls !== 'bld' && e.kind !== 'crystal') continue;
      if (e.untargetable && !e._obs) continue;            // sandstorm / mines don't block placement
      if (ignoreWalls && (e.kind === 'wall' || e.kind === 'gate')) continue;
      if (e.onWall) continue;
      const d = Math.hypot(e.x - x, e.z - z);
      if (d < (e.kind === 'wall' && e.widened ? DEF.wideR : (e.r || 1)) + r) return true;
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
    return null;
  }
  // Harvester lanes: straight line from each owned hauled extractor (and the cc fallback) to its nearest processor.
  // A wall segment within LANE of a lane becomes a gate automatically (own harvesters pass, enemies don't).
  const LANE = 3.2;
  function lanes(team) {
    const ec = E(); if (!ec?.extractors) return [];
    const procs = (ec.processors || []).filter(p => p.team === team && alive(p));
    const cc = ents().find(e => e.kind === 'cc' && e.team === team && alive(e));
    if (cc) procs.push(cc);
    const out = [];
    for (const x of ec.extractors) {
      if (x.team !== team || !alive(x) || x.res === 'secondary') continue;
      let best = null, bd = Infinity;
      for (const p of procs) { const d = Math.hypot(p.x - x.x, p.z - x.z); if (d < bd) { bd = d; best = p; } }
      if (best) out.push([x.x, x.z, best.x, best.z]);
    }
    return out;
  }
  function onLane(team, x, z) {
    for (const [ax, az, bx, bz] of lanes(team)) {
      const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
      if (Math.hypot(x - (ax + dx * t), z - (az + dz * t)) < LANE) return true;
    }
    return false;
  }
  // Own territory: within buildRadius of an own non-wall structure.
  function inTerritory(team, x, z) {
    for (const e of ents()) {
      if (e.team !== team || e.cls !== 'bld' || !alive(e) || e.kind === 'wall' || e.kind === 'gate' || e.untargetable) continue;
      if (Math.hypot(e.x - x, e.z - z) < DEF.buildRadius) return true;
    }
    return false;
  }

  // ---------- spawning ----------
  function spawnDef(kind, team, x, z, opts = {}) {
    if (!sim?.spawn) return null;
    const statKey = opts.siege ? 'siege' : kind;
    const s = DEF[statKey];
    const meshKind = kind === 'turret_aa' ? 'turret_mg' : kind;
    const e = sim.spawn(meshKind, team, x, z);
    if (!e) return null;
    e.kind = kind;
    e.cls = 'bld'; e.team = team; e.x = x; e.z = z;
    e.hp = e.hpMax = s.hp; e.r = s.r; e.def = true; e.defenseRPS = true;
    e.external = true; e.dcd = 0; e.state = 'idle'; e.target = null;
    e.spent = opts.spent || C(0);
    if (opts.siege) { e.siege = true; if (e.mesh?.scale) e.mesh.scale.multiplyScalar?.(s.scale); }
    if (s.range) {
      e.baseRange = s.range; e.range = s.range; e.dps = s.dps; e.fireCd = s.cooldown;
      e.atkKey = statKey;
      e.canHitAir = kind === 'turret_mg' || kind === 'turret_aa'; e.canHitGround = kind !== 'turret_aa';
      if (kind === 'turret_aa') { e.sight = 30; if (e.mesh?.scale) e.mesh.scale.set(1.1, 1.35, 1.1); }
      e.crewNeed = DEF.crew[opts.siege ? 'siege' : kind] || 0;   // econ.requestCrew sets e.crew when manned
      e.unmanned = e.crewNeed > 0;
      if (opts.slot) {
        e.onWall = true; e.slot = opts.slot; opts.slot.turret = e;
        e.baseRange *= DEF.slotRange; e.yOff = DEF.wallTop;
        if (e.mesh?.position) e.mesh.position.y = DEF.wallTop;
      }
      if (T[team].tall && !opts.siege) makeTall(e);
      if (T[team].hardened) { e.hpMax = Math.round(e.hpMax * 1.4); e.hp = e.hpMax; }
    }
    if (kind === 'wall' || kind === 'gate') e.sight = 6;   // walls aren't watchtowers (fog cost)
    const ry = opts.rot != null ? opts.rot : -baseOf(team).face;
    e.rot = ry; if (e.mesh?.rotation) e.mesh.rotation.y = ry;
    if (kind === 'wall' || kind === 'gate') {
      const o = { x, z, r: kind === 'gate' ? s.blockR : s.r, owner: e };
      if (kind === 'gate') { o.team = team; e.hp = e.hpMax = T[team].shieldGates ? DEF.shieldGate.hp : s.hp; if (T[team].shieldGates) e.regen = DEF.shieldGate.regen; }
      e._obs = o; world.obstacles.push(o);
      if (kind === 'wall') { e.grade = 1; e.hp = e.hpMax = Math.round(s.hp * DEF.grades[0].hp); }
    }
    defs.add(e);
    if (e.crewNeed) assignCrew(e);
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
    if (e.crewNeed && e.crew > 0 && typeof E()?.releaseCrew === 'function') { try { if (!E().onDeath) E().releaseCrew(e); } catch (err) { /* econ optional */ } }
    if (e.line) {
      const L = lines.get(e.line);
      if (L) { if (L.segs[e.lineIdx] === e) L.segs[e.lineIdx] = null; recomputeSlots(L); if (!L.segs.some(Boolean)) lines.delete(L.id); }
    }
    if (e.slot && e.slot.turret === e) e.slot.turret = null;
  });

  // ---------- walls: lines, widening, slots ----------
  const segCost = () => DEF.cost.wall;
  const snap = v => Math.round(v / DEF.grid) * DEF.grid;
  // Plan a straight wall from (x0,z0) toward (x1,z1): snapped to the grid, 4u segments. Pure (no side effects).
  function planWall(team, x0, z0, x1, z1, maxSeg = 40) {
    const ax = snap(x0), az = snap(z0), bx = snap(x1), bz = snap(z1);
    let dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz);
    if (len < 1e-3) { dx = 1; dz = 0; len = DEF.segLen; }
    const ux = dx / len, uz = dz / len;
    const n = Math.max(1, Math.min(maxSeg, Math.round(len / DEF.segLen)));
    const rot = -Math.atan2(uz, ux);
    const segs = [];
    let ok = true, reason = null;
    for (let i = 0; i < n; i++) {
      const x = ax + ux * (i + 0.5) * DEF.segLen, z = az + uz * (i + 0.5) * DEF.segLen;
      let r = null;
      if (!inMap(x, z, 2)) r = 'Off map';
      else if (blockedBy(x, z, 1.6, false)) r = 'Blocked';
      else if (team === 0 && !inTerritory(team, x, z)) r = 'Too far from base';
      segs.push({ x, z, rot, ok: !r, reason: r, lane: !r && onLane(team, x, z) });
      if (r) { ok = false; reason = reason || r; }
    }
    const cost = C(n * segCost());
    if (ok && !canPay(team, cost)) { ok = false; reason = 'Need ' + cost.secondary + ' ' + currencyName(team); }
    return { team, x0: ax, z0: az, x1: ax + ux * n * DEF.segLen, z1: az + uz * n * DEF.segLen, segs, n, cost, ok, reason, rot };
  }
  function newLine(team) { const L = { id: nextLine++, team, segs: [], slots: [] }; lines.set(L.id, L); return L; }
  function placeSeg(L, i, p, spentEach) {
    const w = spawnDef('wall', L.team, p.x, p.z, { rot: p.rot, spent: C(spentEach) });
    if (!w) return null;
    w.line = L.id; w.lineIdx = i; L.segs[i] = w;
    if (p.lane ?? onLane(L.team, p.x, p.z)) { convertGate(w, { free: true }); w.laneGate = true; }
    if (p.a != null) { w.ringA = p.a; w.ringR = p.R; }
    return w;
  }
  // Player/AI: build a planned straight wall. Returns {ok, line, reason}.
  function buildWall(team, x0, z0, x1, z1) {
    const plan = planWall(team, x0, z0, x1, z1);
    if (!plan.ok) return { ok: false, reason: plan.reason || 'Blocked' };
    if (!pay(team, plan.cost)) return { ok: false, reason: 'Not enough ' + currencyName(team) };
    const L = newLine(team);
    plan.segs.forEach((p, i) => placeSeg(L, i, p, segCost()));
    emit('message', team === 0 ? { text: `Wall built (${plan.n} segments)`, ms: 1500 } : null);
    return { ok: true, line: L, plan };
  }
  const isWide = (L, i) => { const s = L.segs[i]; return !!(s && alive(s) && s.kind === 'wall' && s.widened); };
  function recomputeSlots(L) {
    const keep = [], used = new Set();
    for (const s of L.slots) {
      if (isWide(L, s.i) && isWide(L, s.i + 1)) { keep.push(s); used.add(s.i); used.add(s.i + 1); }
      else if (s.turret && alive(s.turret)) sim.kill?.(s.turret);   // turret falls with its wall
    }
    for (let i = 0; i + 1 < L.segs.length; i++) {
      if (used.has(i) || used.has(i + 1) || !isWide(L, i) || !isWide(L, i + 1)) continue;
      const a = L.segs[i], b = L.segs[i + 1];
      keep.push({ line: L.id, i, x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, rot: a.rot, turret: null, team: L.team });
      used.add(i); used.add(i + 1);
    }
    L.slots = keep.sort((p, q) => p.i - q.i);
  }
  const widenCost = () => C(segCost() * DEF.cost.widenMul);
  function widenWall(w) {
    if (!w || !alive(w) || w.kind !== 'wall') return { ok: false, reason: 'Not a wall' };
    if (w.widened) return { ok: false, reason: 'Already widened' };
    const c = widenCost();
    if (!pay(w.team, c)) return { ok: false, reason: 'Not enough ' + currencyName(w.team) };
    w.widened = true;
    w.spent = C(fin(w.spent?.secondary) + c.secondary, fin(w.spent?.primary));
    w.hpMax = Math.round(w.hpMax * 1.5); w.hp = Math.min(w.hpMax, w.hp * 1.5);
    if (w._obs) {
      // replace the obstacle object so sim's obstacle hash/grid signature refreshes
      const i = world.obstacles.indexOf(w._obs);
      const o = { ...w._obs, r: DEF.wideR };
      if (i >= 0) world.obstacles.splice(i, 1);
      w._obs = o; world.obstacles.push(o);
    }
    if (w.mesh?.scale) w.mesh.scale.z = 2;
    const L = lines.get(w.line); if (L) recomputeSlots(L);
    return { ok: true };
  }
  function widenLine(w) {
    const L = lines.get(w?.line); if (!L) return widenWall(w);
    let n = 0;
    for (const s of L.segs) if (s && alive(s) && s.kind === 'wall' && !s.widened) { if (!widenWall(s).ok) break; n++; }
    return { ok: n > 0, n, reason: n ? null : 'Not enough ' + currencyName(w.team) };
  }
  const maxGrade = team => T[team].grade;
  const upgradeCost = w => C(segCost() * 2 * (w.grade || 1) * (w.widened ? 2 : 1));
  function upgradeWall(w) {
    if (!w || !alive(w) || w.kind !== 'wall') return { ok: false, reason: 'Not a wall' };
    if ((w.grade || 1) >= maxGrade(w.team)) return { ok: false, reason: (w.grade || 1) >= DEF.grades.length ? 'Max grade' : 'Needs tech' };
    const c = upgradeCost(w);
    if (!pay(w.team, c)) return { ok: false, reason: 'Not enough ' + currencyName(w.team) };
    const g0 = DEF.grades[(w.grade || 1) - 1], g1 = DEF.grades[w.grade || 1];
    w.grade = (w.grade || 1) + 1;
    const k = g1.hp / g0.hp; w.hpMax = Math.round(w.hpMax * k); w.hp = Math.min(w.hpMax, w.hp * k);
    w.spent = C(fin(w.spent?.secondary) + c.secondary);
    if (w.mesh?.scale) w.mesh.scale.y = 1 + 0.12 * (w.grade - 1);
    return { ok: true, grade: w.grade, name: g1.name };
  }
  function demolish(e) {
    if (!e || !alive(e) || !defs.has(e)) return { ok: false, reason: 'Nothing to demolish' };
    const sp = e.spent || C(0);
    const back = C(Math.floor(fin(sp.secondary) * 0.5), Math.floor(fin(sp.primary) * 0.5));
    refund(e.team, back);
    e.demolished = true;
    sim.kill?.(e);
    return { ok: true, refund: back };
  }
  function convertGate(w, opts = {}) {
    if (!w || !alive(w) || w.kind !== 'wall') return { ok: false, reason: 'Not a wall' };
    if (!opts.free && !T[w.team].unlocks.has('gate')) return { ok: false, reason: 'Needs tech' };
    if (w.widened) return { ok: false, reason: 'Widened walls cannot be gates' };
    const c = C(opts.free ? 0 : DEF.cost.gate);
    if (!pay(w.team, c)) return { ok: false, reason: 'Not enough ' + currencyName(w.team) };
    // in-place swap: same entity, new kind/mesh/obstacle
    w.kind = 'gate';
    const st = T[w.team];
    w.hp = w.hpMax = st.shieldGates ? DEF.shieldGate.hp : DEF.gate.hp;
    if (st.shieldGates) w.regen = DEF.shieldGate.regen;
    w.spent = C(fin(w.spent?.secondary) + c.secondary);
    if (w.mesh) {
      world.scene?.remove?.(w.mesh);
      try {
        const m = world.makeMesh?.('gate', w.team);
        if (m) { m.userData = m.userData || {}; m.userData.entity = w; m.position.set(w.x, 0, w.z); m.rotation.y = w.rot; world.scene?.add?.(m); w.mesh = m; }
      } catch (err) { console.warn('[defense] gate mesh failed', err?.message); }
    }
    removeObs(w);
    const o = { x: w.x, z: w.z, r: DEF.gate.blockR, owner: w, team: w.team };
    w._obs = o; world.obstacles.push(o);
    const L = lines.get(w.line); if (L) recomputeSlots(L);
    return { ok: true };
  }

  // ---------- turrets & buildings ----------
  const turretCost = (kind) => C(DEF.cost[kind] ?? 80);
  const slotsOf = team => { const out = []; for (const L of lines.values()) if (L.team === team) for (const s of L.slots) out.push(s); return out; };
  function findSlot(team, x, z, maxD = 3.5) {
    let best = null, bd = maxD;
    for (const s of slotsOf(team)) {
      if (s.turret && alive(s.turret)) continue;
      const d = Math.hypot(s.x - x, s.z - z);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }
  const turretKinds = (team) => {
    const f = factionOf(team);
    const out = [
      { kind: 'turret_mg', name: 'MG Turret' },
      { kind: 'turret_cannon', name: 'Cannon Turret' },
      { kind: 'turret_aa', name: AA_NAME[f] || 'AA Turret' },
    ];
    if (ARTILLERY_FACTIONS.has(f)) out.push({ kind: 'artillery', name: 'Artillery' });
    if (T[team].unlocks.has('siege')) out.push({ kind: 'siege', name: 'Siege Gun' });
    return out;
  };
  function planTurret(team, kind, x, z) {
    const slot = kind === 'siege' ? null : findSlot(team, x, z);
    const px = slot ? slot.x : snap(x), pz = slot ? slot.z : snap(z);
    const cost = turretCost(kind);
    let reason = null;
    if (!T[team].unlocks.has(kind)) reason = 'Needs tech: ' + (techFor(team, kind)?.name || '?');
    else if (!slot && !inMap(px, pz, 2)) reason = 'Off map';
    else if (!slot && blockedBy(px, pz, kind === 'siege' ? 2.4 : 1.6, false)) reason = 'Blocked';
    else if (!slot && team === 0 && !inTerritory(team, px, pz)) reason = 'Too far from base';
    else if (!canPay(team, cost)) reason = 'Need ' + cost.secondary + ' ' + currencyName(team);
    const s = DEF[kind === 'siege' ? 'siege' : kind];
    let range = s.range * (slot ? DEF.slotRange : 1) * (T[team].tall && kind !== 'siege' ? DEF.tallRange : 1);
    return { team, kind, x: px, z: pz, slot, cost, crew: DEF.crew[kind] || 0, range, ok: !reason, reason };
  }
  function placeTurret(team, kind, x, z, opts = {}) {
    const p = opts.plan || planTurret(team, kind, x, z);
    if (opts.slot && !(opts.slot.turret && alive(opts.slot.turret))) { p.slot = opts.slot; p.x = opts.slot.x; p.z = opts.slot.z; }
    if (!p.ok) return { ok: false, reason: p.reason };
    if (!pay(team, p.cost)) return { ok: false, reason: 'Not enough ' + currencyName(team) };
    const siege = kind === 'siege';
    const e = spawnDef(siege ? 'artillery' : kind, team, p.x, p.z, { slot: p.slot, siege, spent: p.cost, rot: p.slot ? p.slot.rot : undefined });
    if (!e) { refund(team, p.cost); return { ok: false, reason: 'Spawn failed' }; }
    return { ok: true, entity: e, slot: p.slot };
  }
  const BLD_MESH = { housing: ['barracks', 0.55], processor: ['factory', 0.6] };
  function planBuilding(team, kind, x, z) {
    const ecC = CONFIG?.econ?.costs?.[kind];
    const px = snap(x), pz = snap(z), cost = ecC ? C(fin(ecC.secondary), fin(ecC.primary)) : C(0, DEF.cost[kind] ?? 150);
    let reason = null;
    if (!inMap(px, pz, 5)) reason = 'Off map';
    else if (blockedBy(px, pz, 3.5, false)) reason = 'Blocked';
    else if (team === 0 && !inTerritory(team, px, pz)) reason = 'Too far from base';
    else if (!canPay(team, cost)) reason = 'Need ' + cost.primary + ' ' + currencyName(team, 'primary') + (cost.secondary ? ` + ${cost.secondary} ${currencyName(team)}` : '');
    return { team, kind, x: px, z: pz, cost, ok: !reason, reason, r: 3.5 };
  }
  function placeBuilding(team, kind, x, z) {
    const ec = E();
    const fnB = ec?.placeBuilding || ec?.build;
    if (typeof fnB === 'function') {
      const p = planBuilding(team, kind, x, z);
      if (!p.ok) return { ok: false, reason: p.reason };
      try { const r = fnB.call(ec, team, kind, p.x, p.z, { cat: 'expand' }); if (r) return r.ok === false ? r : { ok: true, entity: r.entity || r }; }
      catch (err) { console.warn('[defense] econ.build failed', err?.message); }
    }
    const p = planBuilding(team, kind, x, z);
    if (!p.ok) return { ok: false, reason: p.reason };
    if (!pay(team, p.cost)) return { ok: false, reason: 'Not enough ' + currencyName(team, 'primary') };
    const e = sim.spawn?.(kind, team, p.x, p.z, { cls: 'bld', hp: kind === 'housing' ? 900 : 1600, hpMax: kind === 'housing' ? 900 : 1600, r: 3.5 });
    if (!e) { refund(team, p.cost); return { ok: false, reason: 'Spawn failed' }; }
    const [mk, sc] = BLD_MESH[kind] || ['barracks', 0.6];
    const hasModel = e.mesh && e.mesh.children?.length;
    if (!hasModel || !e.mesh.userData?.kind || e.mesh.userData.kind === kind) {
      try {
        const m = world.makeMesh?.(mk, team);
        if (m) {
          if (e.mesh) world.scene?.remove?.(e.mesh);
          m.userData = m.userData || {}; m.userData.entity = e; m.scale.setScalar(sc); m.position.set(e.x, 0, e.z); m.rotation.y = e.rot || 0;
          world.scene?.add?.(m); e.mesh = m;
        }
      } catch (err) { /* keep whatever mesh sim made */ }
    }
    e.spent = p.cost; e.supplyBonus = kind === 'housing' ? 8 : 0; e.processor = kind === 'processor';
    emit('built', { entity: e });
    return { ok: true, entity: e };
  }

  // ---------- crew ----------
  function unitSupply(team) { let s = 0; for (const e of ents()) if (e.team === team && e.isUnit && alive(e)) s += fin(e.supply); return s; }
  function crewPool(team) {
    if (crewOverride[team] != null) return crewOverride[team];
    const ec = E();
    if (typeof ec?.supplyCap === 'function' && typeof ec?.supplyUsed === 'function') return Math.max(0, ec.supplyCap(team) - ec.supplyUsed(team));
    const cap = team === 0 && Number.isFinite(world.ui?.supplyCap) && world.ui.supplyCap > 0 ? world.ui.supplyCap : fin(CONFIG.supplyCap, 40);
    let bonus = 0; for (const e of ents()) if (e.team === team && e.supplyBonus && alive(e) && !E()) bonus += e.supplyBonus;
    return Math.max(0, Math.min(200, cap + bonus) - unitSupply(team));
  }
  const econCrew = () => typeof E()?.requestCrew === 'function';
  function assignCrew(e) {
    if (!econCrew()) return;                     // local pool pass handles it
    let r;
    try { r = E().requestCrew(e, e.crewNeed); } catch (err) { r = false; }
    if (typeof r === 'boolean') e.unmanned = !r;
    else if (r && typeof r === 'object' && 'ok' in r) e.unmanned = !r.ok;
  }
  let crewT = 0, crewRetry = 0;
  function stepCrew(dt) {
    crewT -= dt; if (crewT > 0) return; crewT = 0.5;
    const needs = [0, 0];
    if (econCrew()) {
      crewRetry -= 0.5;
      if (crewRetry <= 0) { crewRetry = 2; for (const e of defs) if (e.crewNeed && e.unmanned && alive(e)) assignCrew(e); }
    } else {
      const byTeam = new Map();
      for (const e of defs) if (e.crewNeed && alive(e)) { if (!byTeam.has(e.team)) byTeam.set(e.team, []); byTeam.get(e.team).push(e); }
      for (const [team, list] of byTeam) {
        list.sort((a, b) => a.id - b.id);
        let free = crewPool(team), used = 0;
        for (const e of list) { if (free >= e.crewNeed) { free -= e.crewNeed; used += e.crewNeed; e.unmanned = false; e.crew = e.crewNeed; } else { e.unmanned = true; e.crew = 0; } }
        if (team === 0) world.ui.crewUsed = used;
      }
    }
    for (const e of defs) if (e.team === 0 && e.crewNeed && e.unmanned && alive(e)) { needs[0]++; needs[1] += e.crewNeed; }
    world.ui.needsCrew = needs[0]; world.ui.needsCrewSupply = needs[1];
  }

  // ---------- faction tech extras: mines, thornwall, spikes, sandstorm ----------
  const zones = new Set();
  function ringPoints(team, R, spacing, gapA, gapArc) {
    const b = baseOf(team), n = Math.max(8, Math.round(TAU * R / spacing)), out = [];
    for (let i = 0; i < n; i++) {
      const a = b.face + (i / n) * TAU;
      if (gapA != null && angDiff(a, gapA) * R < gapArc) continue;
      const x = b.x + Math.cos(a) * R, z = b.z + Math.sin(a) * R;
      if (!inMap(x, z, 2) || inKeepOut(team, x, z, 2)) continue;
      out.push({ x, z, a });
    }
    return out;
  }
  function spawnZone(kind, team, x, z, r, opts = {}) {
    if (!sim?.spawn) return null;
    const e = sim.spawn(kind, team, x, z, { cls: 'bld', untargetable: true, noSight: true, hp: 1e6, hpMax: 1e6, r, ...opts });
    if (!e) return null;
    zones.add(e);
    emit('built', { entity: e });
    return e;
  }
  // Earth Thornwall: ring of root-barrier segments (team-tagged obstacle: blocks other teams; contact = dmg + slow)
  function thornwallRing(team) {
    const b = baseOf(team), R = DEF.ring2 + 6;
    for (const p of ringPoints(team, R, 4.5, b.face, 6)) {
      if (blockedBy(p.x, p.z, 2, false)) continue;
      const e = spawnZone('thornwall', team, p.x, p.z, 2.6, { zone: 'thorn', rot: -p.a - Math.PI / 2 });
      if (!e) continue;
      const o = { x: p.x, z: p.z, r: 2.6, team, owner: e, thorn: true };
      e._obs = o; world.obstacles.push(o);
    }
  }
  // Volcanic Obsidian Spike Field: patches of spikes (non-blocking) that damage + slow ground attackers
  function spikeField(team) {
    const R = DEF.ring2 + 7;
    for (const p of ringPoints(team, R, 6, null, 0)) {
      if (blockedBy(p.x, p.z, 2, false)) continue;
      spawnZone('obsidian_spikes', team, p.x, p.z, 3.5, { zone: 'spikes', rot: -p.a });
    }
  }
  function sandstormRing(team) {
    const R = DEF.ring2 + 7;
    for (const p of ringPoints(team, R, 7, null, 0)) spawnZone('sandstorm', team, p.x, p.z, 5, { zone: 'sandstorm', rot: -p.a });
  }
  function minefield(team) {
    const R = DEF.ring2 + 7, pts = ringPoints(team, R, 2, null, 0);
    const step = Math.max(1, Math.floor(pts.length / 20));
    let n = 0;
    for (let i = 0; i < pts.length && n < 20; i += step) {
      const p = pts[i];
      if (blockedBy(p.x, p.z, 1.2, false)) continue;
      if (spawnZone('vanguard_mine', team, p.x, p.z, 0.8, { trap: true, hp: 1, hpMax: 1 })) n++;
    }
  }
  const qZone = [];
  let zoneT = 0;
  function stepZones(dt) {
    zoneT -= dt;
    if (zoneT > 0) return;
    const step = 0.25 - zoneT; zoneT = 0.25;
    const t = now();
    for (const z of zones) {
      if (!alive(z)) { removeObs(z); zones.delete(z); continue; }
      const cand = sim?.near ? sim.near(z.x, z.z, z.r + 3, qZone) : ents();
      if (z.trap) {
        for (const u of cand) {
          if (!isUnit(u) || u.team === z.team || u.team < 0 || !alive(u) || u.air || u.burrowed) continue;
          if (Math.hypot(u.x - z.x, u.z - z.z) > 2.5 + (u.r || 0) * 0.5) continue;
          for (const v of (sim?.near ? sim.near(z.x, z.z, 4, []) : ents()).slice()) {
            if (!isUnit(v) || v.team === z.team || v.team < 0 || !alive(v) || v.air || v.burrowed) continue;
            if (Math.hypot(v.x - z.x, v.z - z.z) > 4) continue;
            sim.damage?.(v, null, 160);
            v.env = { slow: 0.5, sight: 1, until: t + 3 };
          }
          emit('shot', { from: { x: z.x, z: z.z, y: 0.2 }, to: { x: z.x, z: z.z, y: 0 }, kind: 'mine' });
          sim.kill?.(z); zones.delete(z);
          break;
        }
      } else if (z.zone === 'thorn' || z.zone === 'spikes') {
        const reach = z.zone === 'thorn' ? z.r + 1.5 : z.r, dps = z.zone === 'thorn' ? 18 : 14;
        for (const u of cand.slice()) {
          if (!isUnit(u) || u.team === z.team || u.team < 0 || !alive(u) || u.air || u.burrowed) continue;
          if (Math.hypot(u.x - z.x, u.z - z.z) - (u.r || 0) > reach) continue;
          sim.damage?.(u, null, dps * step);
          if (alive(u) && !(u.env && u.env.slow < 0.55 && u.env.until > t)) u.env = { slow: 0.55, sight: 1, until: t + 0.6 };
        }
      } else if (z.zone === 'sandstorm') {
        for (const u of cand) {
          if (!isUnit(u) || u.team === z.team || u.team < 0 || !alive(u)) continue;
          if (Math.hypot(u.x - z.x, u.z - z.z) > z.r) continue;
          if (!(u.env && u.env.slow < 0.6 && u.env.until > t)) u.env = { slow: 0.6, sight: 0.5, until: t + 0.5 };
        }
      }
    }
  }

  // ---------- TECH (v2 tier names kept; unlocks + abilities instead of auto-placement) ----------
  const unlock = (t, ...ks) => { for (const k of ks) T[t].unlocks.add(k); };
  const TECH = [
    { id: 'mg', name: 'MG Turrets', cost: 250, buildTime: 60, desc: 'Unlocks MG turrets', apply: t => unlock(t, 'turret_mg') },
    { id: 'wallring', name: 'Wall Ring', cost: 350, buildTime: 75, desc: 'Unlocks gates + Reinforced walls', apply: t => { unlock(t, 'gate'); T[t].grade = Math.max(T[t].grade, 2); } },
    { id: 'cannon', name: 'Cannon Turrets', cost: 450, buildTime: 90, desc: 'Unlocks cannon turrets', apply: t => unlock(t, 'turret_cannon') },
    { id: 'extwall', name: 'Extended Wall', cost: 550, buildTime: 100, desc: 'Fortified walls + AA turret', apply: t => { T[t].grade = Math.max(T[t].grade, 3); unlock(t, 'turret_aa'); } },
    { id: 'bunkers', name: 'Hardened Bunkers', cost: 650, buildTime: 110, desc: 'Turrets +40% hp', apply: t => { T[t].hardened = true; for (const e of defs) if (e.team === t && e.baseRange) { e.hpMax = Math.round(e.hpMax * 1.4); e.hp *= 1.4; } } },
    { id: 'tall', name: 'Tall Turrets', cost: 750, buildTime: 120, desc: '+40% turret range', apply: t => { T[t].tall = true; for (const e of defs) if (e.team === t && e.baseRange && !e.siege) makeTall(e); } },
    { id: 'artillery', name: 'Artillery Battery', cost: 900, buildTime: 135, desc: 'Unlocks artillery (crew 4)', apply: t => unlock(t, 'artillery') },
    { id: 'surv', name: 'Surveillance', cost: 1000, buildTime: 145, desc: 'Sight +50%, no night penalty', apply: t => { world.ui.surveillanceBy[t] = true; if (t === 0) world.ui.surveillance = true; } },
    { id: 'shield', name: 'Shield Gate', cost: 1200, buildTime: 160, desc: 'Gates 2000hp + regen', apply: t => { T[t].shieldGates = true; for (const e of defs) if (e.team === t && e.kind === 'gate') { e.hpMax = DEF.shieldGate.hp; e.hp = Math.max(e.hp, e.hpMax * 0.5); e.regen = DEF.shieldGate.regen; } } },
    { id: 'siege', name: 'Siege Cannon', cost: 1400, buildTime: 180, desc: 'Unlocks one siege gun (crew 6)', apply: t => unlock(t, 'siege') },
  ];
  const OVERRIDES = {
    vanguard: { 6: { id: 'mines', name: 'Minefield Belt', cost: 900, buildTime: 135, desc: 'Lays a ring of AP mines', apply: t => minefield(t) } },
    earth:    { 4: { id: 'thornwall', name: 'Thornwall', cost: 650, buildTime: 110, desc: 'Root barrier ring: blocks, slows + damages attackers', apply: t => thornwallRing(t) },
                6: { id: 'regrow', name: 'Rootwall Regrowth', cost: 850, buildTime: 130, desc: 'Walls regrow 4 hp/s', apply: t => { T[t].wallRegen = 4; } } },
    volcanic: { 4: { id: 'spikes', name: 'Obsidian Spike Field', cost: 700, buildTime: 115, desc: 'Spike ring: damage + slow', apply: t => spikeField(t) } },
    storm:    { 4: { id: 'sandstorm', name: 'Sandstorm Wall', cost: 600, buildTime: 100, desc: 'Slowing, blinding sand ring', apply: t => sandstormRing(t) },
                6: { id: 'coils', name: 'Static Coils', cost: 850, buildTime: 130, desc: 'Turret hits slow targets', apply: t => { T[t].staticCoils = true; } } },
  };
  const tiersFor = (team) => {
    const o = OVERRIDES[factionOf(team)] || {};
    return TECH.map((td, i) => {
      const x = o[i] || td;
      return { ...x, index: i, cost: Math.round(x.cost * DEF.techCostMul / 5) * 5, buildTime: Math.round(x.buildTime * DEF.techTimeMul) };
    });
  };
  for (const st of T) st.tiers = tiersFor(st.team);
  function techFor(team, unlockKey) {
    const id = { turret_mg: 'mg', gate: 'wallring', turret_cannon: 'cannon', turret_aa: 'extwall', artillery: 'artillery', siege: 'siege' }[unlockKey];
    return T[team].tiers.find(x => x.id === id) || null;
  }

  function researchTech(team = 0, index) {
    const st = T[team];
    if (!st) return { ok: false, reason: 'bad team' };
    if (st.building) return { ok: false, reason: 'busy' };
    if (index == null) index = st.tiers.findIndex(x => !st.researched.has(x.index));
    const td = st.tiers[index];
    if (!td) return { ok: false, reason: 'maxed' };
    if (st.researched.has(index)) return { ok: false, reason: 'done' };
    const c = C(td.cost);
    if (!pay(team, c, 'tech')) return { ok: false, reason: 'crystals', need: c };
    st.building = { tier: index + 1, index, name: td.name, t: 0, total: td.buildTime };
    if (team === 0) world.ui.defenseBuild = { tier: index + 1, name: td.name, progress: 0 };
    return { ok: true };
  }
  const buildDefense = (team = 0) => researchTech(team);
  // Base look level 0-3 from techs owned (0-2 -> 0, 3-5 -> 1, 6-8 -> 2, 9-10 -> 3); models/FX listen to 'baselevel'.
  world.ui.baseLevel = world.ui.baseLevel || new Array(NT).fill(0);
  function updateBaseLevel(team) {
    const n = T[team].researched.size, lvl = n >= 9 ? 3 : n >= 6 ? 2 : n >= 3 ? 1 : 0;
    if (world.ui.baseLevel[team] === lvl) return;
    world.ui.baseLevel[team] = lvl;
    emit('baselevel', { team, level: lvl });
  }
  function tierInfo(team = 0) {
    const st = T[team]; if (!st) return null;
    const ni = st.tiers.findIndex(x => !st.researched.has(x.index));
    const td = st.tiers[ni];
    return {
      current: st.researched.size, faction: factionOf(team), currency: currencyName(team),
      list: st.tiers.map((x, i) => ({ tier: i + 1, id: x.id, name: x.name, desc: x.desc, cost: x.cost, buildTime: x.buildTime, done: st.researched.has(i) })),
      next: td ? { tier: ni + 1, name: td.name, cost: td.cost, buildTime: td.buildTime } : null,
      building: st.building ? { tier: st.building.tier, index: st.building.index, name: st.building.name,
        progress: st.building.t / st.building.total, remaining: Math.max(0, st.building.total - st.building.t) } : null,
    };
  }
  function stepBuild(st, dt) {
    const b = st.building; if (!b) return;
    b.t += dt;
    if (st.team === 0) world.ui.defenseBuild = { tier: b.tier, name: b.name, progress: Math.min(1, b.t / b.total) };
    if (b.t < b.total) return;
    st.building = null;
    const td = st.tiers[b.index];
    try { td.apply(st.team); } catch (e) { console.warn('[defense] tech apply failed', e); }
    st.researched.add(b.index); st.lastTierAt = now();
    if (st.ai) aiOnTech(st, td);
    updateBaseLevel(st.team);
    if (st.team === 0) { world.ui.defenseTier = st.researched.size; world.ui.defenseBuild = null; }
    else { world.ui.enemyTiers[st.team] = st.researched.size; world.ui.enemyTier = Math.max(...T.slice(1).map(s => s.researched.size)); }
    emit('tier', { team: st.team, tier: st.researched.size, name: b.name, id: td.id });
    if (st.team === 0) emit('message', { text: `Tech researched: ${b.name}`, ms: 2500 });
  }

  // ---------- AI auto-planner (same placement functions as the player) ----------
  const G1 = [0, TAU / 3, -TAU / 3], G2 = [0, Math.PI];
  // contiguous ring arcs (skipping gaps / keep-out / blocked) -> arrays of segment placements
  function ringArcs(team, R, gaps) {
    const b = baseOf(team);
    const n = Math.max(8, Math.round(TAU * R / DEF.segLen));
    const gapHalf = (DEF.segLen * 1.5) / R;
    const arcs = []; let cur = null;
    // start right after the front gap so arcs don't wrap
    for (let k = 0; k < n; k++) {
      const a = b.face + gapHalf + (k / n) * TAU;
      const x = b.x + Math.cos(a) * R, z = b.z + Math.sin(a) * R;
      const skip = gaps.some(g => angDiff(a, b.face + g) < gapHalf) || !inMap(x, z, 2) || inKeepOut(team, x, z, 2.2) || blockedBy(x, z, 1.6, false);
      if (skip) { cur = null; continue; }
      if (!cur) { cur = []; arcs.push(cur); }
      cur.push({ x, z, rot: -a - Math.PI / 2, a, R });
    }
    return arcs.filter(a => a.length);
  }
  function aiRing(team, R, gaps) {
    let arcs = null; const made = [];
    return () => {
      if (!arcs) arcs = ringArcs(team, R, gaps).map(pts => ({ pts, L: newLine(team), i: 0 }));
      for (const A of arcs) while (A.i < A.pts.length) {
        if (!pay(team, C(segCost()))) return false;
        const w = placeSeg(A.L, A.i, A.pts[A.i], segCost()); A.i++;
        if (w) made.push(w);
      }
      T[team].ai.rings[R] = made;
      return true;
    };
  }
  // widen the n wall segments nearest the front gap (chokepoint toward the map center)
  function aiWiden(team, R, n) {
    return () => {
      const b = baseOf(team);
      const segs = (T[team].ai.rings[R] || []).filter(w => alive(w) && w.kind === 'wall').sort((p, q) => angDiff(p.ringA, b.face) - angDiff(q.ringA, b.face));
      let k = 0;
      for (const w of segs) { if (k >= n) break; if (w.widened) { k++; continue; } if (!widenWall(w).ok) return false; k++; }
      return true;
    };
  }
  function aiTurret(team, kind, n, R = 17, spread = 0.6) {
    let placed = 0;
    return () => {
      const b = baseOf(team);
      while (placed < n) {
        if (!canPay(team, turretCost(kind))) return false;
        let r = null;
        if (kind !== 'artillery' && kind !== 'siege') {
          const free = slotsOf(team).filter(s => !(s.turret && alive(s.turret))).sort((p, q) => angDiff(Math.atan2(p.z - b.z, p.x - b.x), b.face) - angDiff(Math.atan2(q.z - b.z, q.x - b.x), b.face));
          if (free[0]) r = placeTurret(team, kind, free[0].x, free[0].z, { slot: free[0] });
        }
        if (!r?.ok) {
          const da = (placed % 2 ? -1 : 1) * spread * (1 + Math.floor(placed / 2) * 0.5);
          const p = polar(team, R, da);
          if (p) r = placeTurret(team, kind, p.x, p.z);
        }
        placed++;                        // never retry forever on a bad spot
      }
      return true;
    };
  }
  function aiGate(team, R) {
    return () => {
      const b = baseOf(team);
      const x = b.x + Math.cos(b.face) * R, z = b.z + Math.sin(b.face) * R;
      if (!canPay(team, C(segCost() + DEF.cost.gate))) return false;
      if (blockedBy(x, z, 1.6, false)) return true;
      const L = newLine(team);
      pay(team, C(segCost()));
      const w = placeSeg(L, 0, { x, z, rot: -b.face - Math.PI / 2 }, segCost());
      if (w) convertGate(w);
      return true;
    };
  }
  const polar = (team, R, da) => {
    const b = baseOf(team), sgn = da >= 0 ? 1 : -1;
    for (let k = 0; k < 24; k++) {
      const a = b.face + da + sgn * k * 0.12;
      const x = b.x + Math.cos(a) * R, z = b.z + Math.sin(a) * R;
      if (inKeepOut(team, x, z, 2) || !inMap(x, z, 3)) continue;
      const p = freeSpot(x, z, 2);
      if (p && !inKeepOut(team, p.x, p.z, 2)) return p;
    }
    return null;
  };
  function aiOnTech(st, td) {
    const t = st.team, q = st.ai.q;
    if (td.id === 'mg') q.push(aiTurret(t, 'turret_mg', 2));
    else if (td.id === 'cannon') q.push(aiTurret(t, 'turret_cannon', 2, 15, 0.9));
    else if (td.id === 'extwall') q.push(aiRing(t, DEF.ring2, G2), aiWiden(t, DEF.ring2, 4), aiTurret(t, 'turret_aa', 1, 14, 1.4));
    else if (td.id === 'artillery') q.push(aiTurret(t, 'artillery', 2, 12, Math.PI / 2));
    else if (td.id === 'shield') q.push(aiGate(t, DEF.ring2));
    else if (td.id === 'siege') q.push(aiTurret(t, 'siege', 1, 11, Math.PI));
  }
  function stepAI(dt) {
    for (let t = 1; t < NT; t++) {
      const st = T[t];
      if (now() < DEF.aiStart) continue;
      if (!ents().some(e => e.kind === 'cc' && e.team === t && alive(e))) continue;  // eliminated
      const ai = st.ai;
      if (!ai.started) { ai.started = true; ai.q.push(aiRing(t, DEF.ring1, G1), aiWiden(t, DEF.ring1, 4)); }
      ai.nextPlan -= dt;
      if (ai.nextPlan <= 0) {
        ai.nextPlan = DEF.aiPlanEvery;
        if (ai.q.length) { let done = false; try { done = ai.q[0](); } catch (e) { console.warn('[defense] AI plan step failed', e); done = true; } if (done) ai.q.shift(); }
      }
      if (st.building || st.researched.size >= st.tiers.length || ai.q.length > 1) continue;
      let top = 0; for (const o of T) if (o !== st) top = Math.max(top, o.researched.size);
      const ahead = Math.max(0, top - st.researched.size);
      const interval = Math.max(DEF.aiMinInterval, DEF.aiInterval / (1 + DEF.aiAheadScale * ahead));
      if (now() - st.lastTierAt < interval) continue;
      researchTech(t);
    }
  }

  // ---------- combat ----------
  function effRange(e) {
    const night = fin(world.ui?.nightFactor);
    const pen = world.ui.surveillanceBy[e.team] ? 0 : DEF.nightPenalty * Math.max(0, Math.min(1, night));
    return e.baseRange * (1 - pen);
  }
  const isEnemy = (e, v) => v.team !== e.team && v.team !== -1 && v.team != null && alive(v) && !v.untargetable && !v.trap && (sim?.canHit ? sim.canHit(e, v) : true);
  const qBuf = [];
  const around = (e, range) => (sim?.near ? sim.near(e.x, e.z, range, qBuf) : ents());
  function acquire(e, range, allowBld) {
    let best = null, bd = Infinity;
    const cand = around(e, range);
    const minR = DEF[e.atkKey]?.minRange || 0;
    for (const v of cand) {
      if (!isEnemy(e, v) || !isUnit(v)) continue;
      if (e.kind === 'turret_aa' && !v.air) continue;
      const d = Math.hypot(v.x - e.x, v.z - e.z);
      if (d <= range && d < bd && d >= minR) { bd = d; best = v; }
    }
    if (!best && allowBld) for (const v of cand) {
      if (!isEnemy(e, v) || v.cls !== 'bld') continue;
      const d = Math.hypot(v.x - e.x, v.z - e.z) - (v.r || 0);
      if (d <= range && d < bd) { bd = d; best = v; }
    }
    return best;
  }
  function hitOne(e, v, base) {
    const A = ATTACK[e.atkKey] || {};
    const mult = v.air && A.air != null ? A.air : (A[v.cls] ?? 1);
    const dmg = base * mult;
    if (!(dmg > 0)) return;
    sim.damage?.(v, e, dmg);
    if (T[e.team]?.staticCoils && isUnit(v) && alive(v)) v.env = { slow: 0.7, sight: 1, until: now() + 1 };
  }
  function fire(e, v) {
    const base = e.dps * e.fireCd;
    const y0 = 2.2 + (e.yOff || 0);
    emit('shot', { from: { x: e.x, z: e.z, y: y0 }, to: { x: v.x, z: v.z, y: v.air ? (v.y || 8) : v.cls === 'bld' ? 1.5 : 1 }, kind: e.siege ? 'siege' : e.kind === 'turret_aa' ? 'turret_mg' : e.kind, shooter: e });
    if (e.kind === 'artillery' && !e.siege) {
      const R = DEF.artillery.splash, tx = v.x, tz = v.z;
      const cand = (sim?.near ? sim.near(tx, tz, R, []) : ents().slice());
      for (const u of cand) if (isEnemy(e, u) && Math.hypot(u.x - tx, u.z - tz) <= R + (u.cls === 'bld' ? (u.r || 0) : 0)) hitOne(e, u, base);
    } else hitOne(e, v, base);
  }
  function stepTurret(e, dt) {
    e.dcd = Math.max(0, fin(e.dcd) - dt);
    if (e.unmanned) { e.target = null; e.state = 'idle'; return; }
    const range = effRange(e); e.range = range;
    const allowBld = (e.team !== 0 && e.kind === 'artillery');
    let v = e.target;
    const valid = v && alive(v) && isEnemy(e, v) && Math.hypot(v.x - e.x, v.z - e.z) - (v.cls === 'bld' ? v.r || 0 : 0) <= range && (isUnit(v) || allowBld);
    if (!valid || (v.cls === 'bld' && e.dcd <= 0)) v = acquire(e, range, allowBld);
    e.target = v || null;
    e.state = v ? 'attack' : 'idle';
    if (!v) return;
    const aim = Math.atan2(-(v.z - e.z), v.x - e.x);
    const tur = e.mesh?.userData?.turret;
    if (tur?.rotation) tur.rotation.y = aim - (e.mesh.rotation?.y || 0);
    else if (e.mesh?.rotation) { e.mesh.rotation.y = aim; e.rot = aim; }
    if (e.dcd <= 0) { e.dcd = e.fireCd; fire(e, v); }
  }

  function update(dt) {
    dt = fin(dt, fin(world.clock?.dt));
    if (dt <= 0) return;
    for (const st of T) stepBuild(st, dt);
    stepAI(dt);
    stepCrew(dt);
    for (const e of defs) {
      if (!alive(e)) { removeObs(e); defs.delete(e); continue; }
      if (e.regen) e.hp = Math.min(e.hpMax, e.hp + e.regen * dt);
      else if (e.kind === 'wall' && T[e.team]?.wallRegen) e.hp = Math.min(e.hpMax, e.hp + T[e.team].wallRegen * dt);
      if (e.baseRange) stepTurret(e, dt);
    }
    stepZones(dt);
  }

  function reserveFor(team) {
    const st = T[team]; if (!st || team === 0) return 0;
    if (E()) return 0;                                   // secondary currency is separate from unit money
    const next = st.tiers.find(x => !st.researched.has(x.index));
    if (!next || st.building) return 0;
    const due = Math.max(DEF.aiStart, st.lastTierAt + DEF.aiInterval);
    return now() >= due - DEF.aiReserveLead ? next.cost : 0;
  }

  const api = {
    update, buildDefense, researchTech, tierInfo, tiers: T[0].tiers, tiersFor, _state: T, _defs: defs, _zones: zones, _lines: lines,
    hasSurveillance: team => !!world.ui.surveillanceBy[team],
    reserveFor,
    get enemyReserve() { return reserveFor(1); },
    // BASE BUILDING v3 API (buildmode.js + AI planner)
    DEF, planWall, buildWall, widenWall, widenLine, widenCost, upgradeWall, upgradeCost, demolish, convertGate,
    planTurret, placeTurret, turretKinds, findSlot, slotsOf, planBuilding, placeBuilding,
    canPay, pay, refund, balance, currencyName, unlocked: (team, k) => T[team]?.unlocks.has(k), maxGrade,
    grades: DEF.grades, techFor, crewPool, crewOverride, isDefense: e => defs.has(e), lineOf: e => lines.get(e?.line),
    hasArtillery: team => ARTILLERY_FACTIONS.has(factionOf(team)), factionOf,
  };
  world.defense = api;
  return api;
}
