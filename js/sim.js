// Vanguard — simulation (owner: SIM). v2: 512x320 map, 4-team free-for-all, fog of war.
// Entities, movement/steering, RPS combat, harvesting economy, build queues,
// AI army + waves for every non-player team, day/night, fog (team 0), win/lose. All numbers come from config.js.
//
// TODO.md (stubs / assumptions):
//  - e.rot is the mesh's rotation.y; models face local +X, so rot = atan2(-vz, vx) (= -atan2(vz, vx)). Turret aim is
//    local to the hull and relaxes to forward out of combat.
//  - Map size is read from world.map once at createSim (engine sets it before). Base spots come from
//    CONFIG.map.baseFrac * half-extents; any spot overlapping a world.obstacles circle is nudged toward center.
//  - Movement: coarse grid A* (CONFIG.nav.cell, per team, path budget per step) + steering; units boxed in with no
//    path briefly 'ghost' through their own/neutral structures (never another team's). Crystals block with blockR.
//  - Perf: one uniform spatial hash (CONFIG.hash.cell) over live entities, rebuilt each substep, serves target scans,
//    splash, unit avoidance and unit-unit separation. A second hash bins obstacles + static structures (rebuilt on
//    change). sim.near(x, z, r, out) is exported for defense.js.
//  - damage(victim, attacker, dmg) applies dmg AS GIVEN (already RPS-multiplied). Use sim.mul(attackerKind, victim)
//    to compute the multiplier when calling from defense.js.
//  - Entities flagged `external:true` are skipped by sim targeting/firing (for defense.js to drive itself).
//  - Night turret range penalty skipped when world.defense.hasSurveillance(team) returns true or e.noNightPenalty.
//  - AI team t keeps world.defense.reserveFor(t) (fallback enemyReserve / CONFIG.pacing.enemyReserve) banked.
//  - world.obstacles entries with a `team` (gates) block only the other team.
//  - Depleted crystals are removed silently (no `died` event).
//  - Fog (team 0 only): world.fog per CONTRACT v2. Neutral crystals are never `hidden` (the overlay darkens them);
//    only teams 1..3 get hidden flags. Attack commands on hidden targets become a move to the tapped point.
//  - Base crystal fields are tagged `home: team`; other teams' harvesters don't mine them. Center fields are
//    `rich` (CONFIG.economy.richMul carry).
//  - Heroes (CONTRACT Heroes): spawn('hero', team, x, z, { stats:{hp,speed,range,dps,cooldown,r,sight}, ... }) needs no
//    CONFIG entry. Any entity with e.stats has speed/range/dps/cooldown/r re-synced from it every step (so heroes.js
//    may change stats live) and fog sight from stats.sight. Heroes cost no supply unless opts.supply is given.
//  - e.status = { rooted, stunned, dmgMul, until }: a flag is active if `true` or a number > clock.t (timestamp);
//    the whole status is cleared once clock.t > until. rooted/stunned = no movement, stunned = no attacks,
//    dmgMul scales incoming damage in sim.damage. slowMul / speedMul (numbers) multiply move speed.
//  - ROSTER (js/roster.js, optional, loaded via guarded dynamic import): unit stats = ROSTER[kind] ?? CONFIG.units[kind].
//    Assumed entry fields: { faction, building:'barracks'|'factory'|'cc' (or array), role:'inf'|'light'|'heavy'|
//    'harvester'|'special'|'air'|'aa', hp, speed, range, dps, cooldown, cost, buildTime, supply, r, cls, light, air,
//    canHitAir, canHitGround, armor, sight, rps:{inf,veh,bld,light,air} }. A building of team t produces the roster
//    kinds with matching `building` and faction world.factions[t], plus the legacy CONFIG kinds (fallback).
//    Harvester = role 'harvester' | harvester:true | kind ends with 'harvester'.
//  - Unit flags: air (y=8, ignores ground obstacles/walls/pathing, only hit by canHitAir), canHitGround:false,
//    burrowed (untargetable, always hidden from the player when enemy, no attacks, 0.7x speed), armor (fractional
//    reduction applied after status.dmgMul). Defense turrets: turret_mg canHitAir (defense.js uses sim.canHit).
import { CONFIG } from './config.js';

// Optional faction roster (ROSTER worker). Missing file => legacy CONFIG.units only.
let ROSTER = {};
try {
  const m = await import('./roster.js');
  ROSTER = m.ROSTER || m.default || m.roster || {};
} catch (err) { console.warn('[sim] roster.js not loaded, using CONFIG.units:', err?.message); }

const COMBAT_KINDS = ['warden', 'raider', 'tank'];
const PRODUCES = { barracks: ['warden', 'raider'], factory: ['tank', 'harvester'], cc: ['harvester'] }; // cc: fallback when factory is lost
const TWO_PI = Math.PI * 2;
const TURRETS = new Set(['turret_mg', 'turret_cannon', 'artillery']);

export function createSim(world) {
  const C = CONFIG;
  const unitDef = (kind) => ROSTER[kind] ?? C.units[kind];
  const isHarvKind = (kind) => { const r = ROSTER[kind]; return !!(r && (r.role === 'harvester' || r.harvester)) || /harvester$/.test(kind); };
  const ents = world.entities || (world.entities = []);
  const ui = world.ui || (world.ui = {});
  const bus = world.bus;
  const MW = world.map?.w ?? 160, MH = world.map?.h ?? 100;
  const NT = C.teams.count;

  // ---- team metadata on world (engine may already set teams/colors; only fill what's missing)
  world.teams = world.teams || {};
  if (world.teams.P == null) world.teams.P = 0;
  world.teams.count = NT;
  world.colors = world.colors || {};
  for (let t = 0; t < NT; t++) if (world.colors[t] == null) world.colors[t] = C.teams.colors[t];
  world.factions = C.teams.factions.slice(0, NT);

  const crystals = [];
  for (let t = 0; t < NT; t++) crystals[t] = t === 0 ? C.economy.startCrystals : C.economy.enemyStartCrystals;
  const queues = new Map();      // building.id -> [{kind, progress, t, total, team}]
  const byId = new Map();
  let nextId = 1;
  let T = 0;                     // accumulated sim seconds (mirrors clock.t)
  let pendingDead = [];
  const hq = new Array(NT).fill(null);   // command centers by team
  const AI = [];                 // per-team AI state (index = team; [0] unused)
  for (let t = 1; t < NT; t++) AI[t] = { think: t * 0.3, nextWave: C.pacing.firstWave + (t - 1) * 11, waveNo: 0, alive: true, defendAt: 0, target: null };
  let staticObs = [];
  let lastCmd = null;
  let staticVer = 0;
  const counts = Array.from({ length: NT }, () => ({ units: 0, army: 0, harv: 0, warden: 0, raider: 0, tank: 0, inf: 0, veh: 0, air: 0, armored: 0 }));
  // per-team production lists from the roster (+ legacy fallback)
  const producesFor = (b) => {
    const f = world.factions?.[b.team];
    const out = [];
    for (const k in ROSTER) {
      const r = ROSTER[k];
      if (!r || (r.faction && r.faction !== f)) continue;
      const bl = Array.isArray(r.building) ? r.building : [r.building];
      if (bl.includes(b.kind)) out.push(k);
    }
    for (const k of PRODUCES[b.kind] || []) if (!out.includes(k)) out.push(k);
    if (b.kind === 'cc') { const hk = harvKindFor(b.team); if (!out.includes(hk)) out.push(hk); }
    return out;
  };
  const harvKindFor = (team) => {
    const f = world.factions?.[team];
    for (const k in ROSTER) if (ROSTER[k]?.faction === f && isHarvKind(k)) return k;
    return 'harvester';
  };
  const perf = { stepMs: 0, fogMs: 0, paths: 0 };

  const emit = (name, detail) => { try { bus?.dispatchEvent(new CustomEvent(name, { detail })); } catch (_) {} };
  const message = (text, ms = 2500) => { ui.message = text; emit('message', { text, ms }); };
  const teamName = (t) => C.teams.names[t] || `Team ${t}`;

  // ---------------------------------------------------------------- spatial hash (live entities)
  const HC = C.hash.cell, HCOLS = Math.ceil(MW / HC) + 1, HROWS = Math.ceil(MH / HC) + 1;
  const hcells = Array.from({ length: HCOLS * HROWS }, () => []);
  const hused = [];
  let hMaxR = 8;
  const hcx = (x) => { const c = Math.floor((x + MW / 2) / HC); return c < 0 ? 0 : c >= HCOLS ? HCOLS - 1 : c; };
  const hcz = (z) => { const c = Math.floor((z + MH / 2) / HC); return c < 0 ? 0 : c >= HROWS ? HROWS - 1 : c; };
  function hashRebuild() {
    for (let i = 0; i < hused.length; i++) hcells[hused[i]].length = 0;
    hused.length = 0;
    let mr = 0;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (e.state === 'dead' || e.kind === 'crystal') continue;
      const k = hcz(e.z) * HCOLS + hcx(e.x);
      if (!hcells[k].length) hused.push(k);
      hcells[k].push(e);
      if (e.r > mr) mr = e.r;
    }
    hMaxR = mr + 2; // +2: units move a little within a substep after the rebuild
  }
  // Candidates within r of (x,z) (caller still tests exact distance). `out` is reused by the caller.
  function near(x, z, r, out) {
    out = out || [];
    out.length = 0;
    const R = r + hMaxR;
    const x0 = hcx(x - R), x1 = hcx(x + R), z0 = hcz(z - R), z1 = hcz(z + R);
    for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) {
      const c = hcells[cz * HCOLS + cx];
      for (let i = 0; i < c.length; i++) out.push(c[i]);
    }
    return out;
  }
  const qTarget = [], qSplash = [], qSteer = [], qCol = [], qDef = [];

  // ---------------------------------------------------------------- obstacle hash (world.obstacles + structures)
  const ocells = Array.from({ length: HCOLS * HROWS }, () => []);
  const oused = [];
  let oSig = '', oAt = -99, oQ = 1;
  function obsHash() {
    const obs = world.obstacles || [];
    const sig = obs.length + '|' + staticVer;
    if (sig === oSig && T - oAt < 1) return;
    oSig = sig; oAt = T;
    for (let i = 0; i < oused.length; i++) ocells[oused[i]].length = 0;
    oused.length = 0;
    const put = (o) => {
      const x0 = hcx(o.x - o.r), x1 = hcx(o.x + o.r), z0 = hcz(o.z - o.r), z1 = hcz(o.z + o.r);
      for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) {
        const k = cz * HCOLS + cx;
        if (!ocells[k].length) oused.push(k);
        ocells[k].push(o);
      }
    };
    for (const o of obs) put({ x: o.x, z: o.z, r: o.r, team: o.team, owner: o.owner, ent: null, q: 0 });
    for (const o of staticObs) put({ x: o.x, z: o.z, r: o.blockR ?? o.r, team: null, owner: null, ent: o, q: 0 });
  }
  // Calls fn(o) once per obstacle entry whose circle may come within r of (x,z).
  function eachObs(x, z, r, fn) {
    const q = ++oQ;
    const x0 = hcx(x - r), x1 = hcx(x + r), z0 = hcz(z - r), z1 = hcz(z + r);
    for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) {
      const c = ocells[cz * HCOLS + cx];
      for (let i = 0; i < c.length; i++) { const o = c[i]; if (o.q === q) continue; o.q = q; fn(o); }
    }
  }

  // ---------------------------------------------------------------- spawn
  function spawn(kind, team, x, z, opts) {
    const hero = kind === 'hero';
    const u = unitDef(kind) || (hero ? { cls: 'inf', supply: 0 } : null), b = C.buildings[kind], d = C.defenses[kind];
    const base = u || b || d || {};
    const os = opts?.stats;
    const s = os ? { ...base, ...os } : base;
    const e = {
      id: nextId++, kind, team,
      x, z, rot: Math.atan2(z, -x) || 0,     // face the map center
      r: s.r ?? 2, hp: s.hp ?? 100, hpMax: s.hp ?? 100,
      cls: s.cls ?? 'bld', light: !!s.light,
      mesh: null, state: 'idle', target: null, dest: null,
      cooldown: 0, range: s.range ?? 0, dps: s.dps ?? 0, speed: s.speed ?? 0,
      fireRate: s.cooldown ?? 1, carry: 0,
      supply: u ? u.supply : 0, isUnit: !!u, splash: s.splash ?? 0, minRange: s.minRange ?? 0,
      aggressive: false, autoTarget: false, scan: Math.random() * C.aggro.scanInterval,
      harvT: 0, field: null, idleT: 0, manual: false, stall: 0, stallRef: null,
      hidden: false,
      harv: !!u && isHarvKind(kind), air: !!s.air, canHitAir: !!s.canHitAir, canHitGround: s.canHitGround !== false,
      armor: s.armor ?? 0, burrowed: !!s.burrowed, y: s.air ? 8 : 0,
    };
    if (s.sight != null) e.sight = s.sight;
    if (s.faction) e.faction = s.faction; else if (team >= 0) e.faction = world.factions?.[team];
    if (kind === 'crystal') { e.amount = b.amount; e.blockR = b.blockR ?? e.r; }
    if (opts) Object.assign(e, opts);
    e.y = e.air ? (e.y || 8) : 0;
    if (hero) { e.hero = true; if (!e.cls || e.cls === 'bld') e.cls = 'inf'; }
    if (e.hpMax < e.hp) e.hpMax = e.hp;
    try {
      e.mesh = world.makeMesh ? world.makeMesh(kind, team) : null;
    } catch (err) { console.warn('[sim] makeMesh failed', kind, err?.message); }
    if (e.mesh) {
      e.mesh.userData = e.mesh.userData || {};
      e.mesh.userData.entity = e;
      e.mesh.position?.set?.(x, e.y, z);
      if (e.mesh.rotation) e.mesh.rotation.y = e.rot;
      world.scene?.add?.(e.mesh);
    }
    ents.push(e);
    byId.set(e.id, e);
    if (kind === 'cc' && team >= 0 && team < NT) hq[team] = e;
    if (!e.isUnit) rebuildStaticObs();
    // fog: a freshly spawned enemy is hidden until the next recompute says otherwise
    if (team > 0 && fog?.enabled) e.hidden = !visibleAt(e);
    return e;
  }

  function rebuildStaticObs() {
    // Buildings/crystals block movement. Walls/gates come via world.obstacles (defense.js).
    staticObs = ents.filter(e => !e.isUnit && e.state !== 'dead' && e.kind !== 'wall' && e.kind !== 'gate');
    staticVer++;
  }

  // ---------------------------------------------------------------- fog of war (team 0)
  const FC = C.fog.cell, FCOLS = Math.ceil(MW / FC), FROWS = Math.ceil(MH / FC), FN = FCOLS * FROWS;
  const prevFog = world.fog;
  const fog = world.fog = {
    enabled: prevFog?.enabled ?? true, cell: FC, cols: FCOLS, rows: FROWS,
    explored: new Uint8Array(FN), visible: new Uint8Array(FN), version: 0,
  };
  const fogCur = new Uint8Array(FN);
  const discs = new Map();   // radius*2 (rounded) -> Int16Array [dx,dz,...]
  let fogT = 0, fogWasEnabled = fog.enabled;
  function disc(rc) {
    const key = Math.round(rc * 2);
    let d = discs.get(key);
    if (d) return d;
    const R = key / 2, n = Math.ceil(R), out = [];
    for (let dz = -n; dz <= n; dz++) for (let dx = -n; dx <= n; dx++) if (dx * dx + dz * dz <= R * R) out.push(dx, dz);
    d = new Int16Array(out); discs.set(key, d);
    return d;
  }
  function sightOf(e) {
    const S = C.fog.sight;
    let s;
    if (e.stats?.sight > 0) s = e.stats.sight + (e.isUnit ? 0 : e.r);
    else if (e.sight > 0) s = e.sight + (e.isUnit ? 0 : e.r);
    else if (e.isUnit) s = e.harv ? S.harvester : e.cls === 'inf' ? S.inf : S.veh;
    else if (TURRETS.has(e.kind) || e.siege) s = S.turret * (e.tall ? C.fog.tallMul : 1) + e.r;
    else s = S.bld + e.r;
    if (world.defense?.hasSurveillance?.(0)) s *= C.fog.survMul;
    return s;
  }
  const fogIdx = (x, z) => {
    const cx = Math.floor((x + MW / 2) / FC), cz = Math.floor((z + MH / 2) / FC);
    if (cx < 0 || cz < 0 || cx >= FCOLS || cz >= FROWS) return -1;
    return cz * FCOLS + cx;
  };
  function visibleAt(e) {
    const v = fog.visible;
    let i = fogIdx(e.x, e.z);
    if (i >= 0 && v[i]) return true;
    if (e.r >= 2) { // big things: any footprint corner visible
      const k = e.r * 0.7;
      if ((i = fogIdx(e.x + k, e.z)) >= 0 && v[i]) return true;
      if ((i = fogIdx(e.x - k, e.z)) >= 0 && v[i]) return true;
      if ((i = fogIdx(e.x, e.z + k)) >= 0 && v[i]) return true;
      if ((i = fogIdx(e.x, e.z - k)) >= 0 && v[i]) return true;
    }
    return false;
  }
  function fogRecompute() {
    const t0 = performance.now();
    fogCur.fill(0);
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (e.team !== 0 || e.state === 'dead') continue;
      const d = disc(sightOf(e) / FC);
      const cx = Math.floor((e.x + MW / 2) / FC), cz = Math.floor((e.z + MH / 2) / FC);
      for (let k = 0; k < d.length; k += 2) {
        const x = cx + d[k], z = cz + d[k + 1];
        if (x < 0 || z < 0 || x >= FCOLS || z >= FROWS) continue;
        fogCur[z * FCOLS + x] = 1;
      }
    }
    const vis = fog.visible, exp = fog.explored;
    let changed = false;
    for (let i = 0; i < FN; i++) {
      const c = fogCur[i];
      if (vis[i] !== c) { vis[i] = c; changed = true; }
      if (c && !exp[i]) exp[i] = 1;
    }
    if (changed) fog.version++;
    applyHidden();
    perf.fogMs = performance.now() - t0;
  }
  function applyHidden() {
    const on = !!fog.enabled;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      e.hidden = e.team > 0 && (e.burrowed || (on && !visibleAt(e)));
    }
  }
  function fogTick(dt) {
    if (fog.enabled !== fogWasEnabled) { fogWasEnabled = fog.enabled; fog.version++; applyHidden(); }
    fogT -= dt;
    if (fogT <= 0) { fogT = C.fog.interval; fogRecompute(); }
  }

  // ---------------------------------------------------------------- setup
  const M = C.map;
  const hw = MW / 2, hh = MH / 2;
  const toCenter = (x, z) => { const l = Math.hypot(x, z) || 1; return { x: -x / l, z: -z / l }; };
  // Free of terrain obstacles and existing structures? (r = footprint radius)
  function spotFree(x, z, r) {
    if (Math.abs(x) > hw - r - 1 || Math.abs(z) > hh - r - 1) return false;
    for (const o of world.obstacles || []) if (o.owner == null && Math.hypot(o.x - x, o.z - z) < o.r + r + 1) return false;
    for (const e of ents) if (!e.isUnit && e.state !== 'dead' && Math.hypot(e.x - x, e.z - z) < e.r + r + 0.5) return false;
    return true;
  }
  // Nudge (x,z) toward the map center until it's free (robust vs. engine-placed obstacles).
  function nudgeFree(x, z, r) {
    x = Math.max(-hw + r + 2, Math.min(hw - r - 2, x)); z = Math.max(-hh + r + 2, Math.min(hh - r - 2, z));
    for (let k = 0; k < 80; k++) {
      if (spotFree(x, z, r)) return { x, z };
      const c = toCenter(x, z), j = k % 3 === 2 ? 1.5 : 0; // small sideways jitter so we can slide around a rock
      x += c.x * 2 - c.z * j; z += c.z * 2 + c.x * j;
    }
    return { x, z };
  }
  // Crystal: push off obstacles/structures locally (fields stay compact).
  function crystalSpot(x, z) {
    const r = C.buildings.crystal.r;
    if (spotFree(x, z, r)) return { x, z };
    for (let ring = 1; ring <= 8; ring++) for (let k = 0; k < 8; k++) {
      const a = k / 8 * TWO_PI, nx = x + Math.cos(a) * ring * 1.5, nz = z + Math.sin(a) * ring * 1.5;
      if (spotFree(nx, nz, r)) return { x: nx, z: nz };
    }
    return nudgeFree(x, z, r);
  }
  function field(cx, cz, n, spread, opts) {
    const out = [];
    if (n >= 6) { const p = crystalSpot(cx, cz); out.push(spawn('crystal', -1, p.x, p.z, opts)); n--; }
    for (let i = 0; i < n; i++) {
      const a = i * TWO_PI / n + 0.5;
      const p = crystalSpot(cx + Math.cos(a) * spread, cz + Math.sin(a) * spread);
      out.push(spawn('crystal', -1, p.x, p.z, opts));
    }
    return out;
  }
  const bases = [];
  for (let t = 0; t < NT; t++) {
    const [qx, qz] = C.teams.quad[t];
    const bx = qx * hw * M.baseFrac.x, bz = qz * hh * M.baseFrac.z;
    const cc = nudgeFree(bx, bz, C.buildings.cc.r);
    const sx = -qx, sz = -qz;                      // toward center
    const ccE = spawn('cc', t, cc.x, cc.z);
    // v1 offsets (player SW): barracks (+10,+10), factory (+10,-10) -> mirrored: x toward center, z +-10
    const pb = nudgeFree(cc.x + sx * M.bldOff, cc.z - sz * M.bldOff, C.buildings.barracks.r);
    spawn('barracks', t, pb.x, pb.z);
    const pf = nudgeFree(cc.x + sx * M.bldOff, cc.z + sz * M.bldOff, C.buildings.factory.r);
    spawn('factory', t, pf.x, pf.z);
    const d = toCenter(cc.x, cc.z);
    const fx = cc.x + d.x * M.toField, fz = cc.z + d.z * M.toField;
    const fieldEnts = field(fx, fz, M.fieldCrystals, M.fieldSpread, { home: t });
    bases[t] = { cc: ccE, field: { x: fx, z: fz, r: M.fieldSpread + C.buildings.crystal.r } , fieldEnts };
  }
  for (const f of M.centerFields) field(f.fx * hw, f.fz * hh, M.centerCrystals, M.centerSpread, { home: -1, rich: true });
  for (let t = 0; t < NT; t++) spawnAtRally(byKind('factory', t) || hq[t], harvKindFor(t));

  function byKind(kind, team) { return ents.find(e => e.kind === kind && e.team === team && e.state !== 'dead'); }

  function rallyPoint(b) {
    const dx = -b.x, dz = -b.z, l = Math.hypot(dx, dz) || 1;
    const off = b.r + M.rallyOffset;
    return { x: b.x + dx / l * off + (Math.random() - 0.5) * 3, z: b.z + dz / l * off + (Math.random() - 0.5) * 3 };
  }
  function spawnAtRally(b, kind) {
    if (!b) return null;
    const p = rallyPoint(b);
    const e = spawn(kind, b.team, p.x, p.z);
    e.rot = Math.atan2(b.z, -b.x);
    return e;
  }

  // ---------------------------------------------------------------- economy helpers
  function supplyUsed(team) {
    let s = 0;
    for (const e of ents) if (e.team === team && e.isUnit && e.state !== 'dead') s += e.supply;
    for (const [, q] of queues) for (const it of q) if (it.team === team) s += unitDef(it.kind)?.supply ?? 1;
    return s;
  }
  function totalUnits() {
    let n = 0;
    for (const e of ents) if (e.isUnit && e.state !== 'dead') n++;
    for (const [, q] of queues) n += q.length;
    return n;
  }
  function spendCrystals(team, n) {
    if (!(n >= 0) || !(crystals[team] >= n)) return false;
    crystals[team] -= n;
    return true;
  }

  function enqueue(building, kind) {
    if (typeof building === 'string') building = byKind(building, 0);
    const fail = (t) => { if (!building || building.team === 0) message(t); return false; };
    if (!building || building.state === 'dead') return fail('Building not available');
    const allowed = producesFor(building);
    if (!allowed.includes(kind) || !unitDef(kind)) return fail(`${building.kind} can't build ${kind}`);
    const team = building.team, u = unitDef(kind);
    let q = queues.get(building.id);
    if (!q) { q = []; queues.set(building.id, q); }
    if (q.length >= C.queueMax) return fail('Queue full');
    if (supplyUsed(team) + u.supply > C.supplyCap) return fail('Supply cap reached');
    if (totalUnits() >= C.unitCap) return fail('Battlefield unit limit reached');
    if (!spendCrystals(team, u.cost)) return fail('Not enough crystals');
    q.push({ kind, progress: 0, t: 0, total: u.buildTime, team });
    return true;
  }

  function updateQueues(dt) {
    for (const [id, q] of queues) {
      if (!q.length) continue;
      const b = byId.get(id);
      if (!b || b.state === 'dead') { q.length = 0; continue; }
      const it = q[0];
      it.t += dt;
      it.progress = Math.min(1, it.t / it.total);
      if (it.t >= it.total) {
        q.shift();
        const e = spawnAtRally(b, it.kind);
        emit('built', { entity: e });
        if (b.team === 0) { const nm = unitDef(it.kind)?.name || it.kind.replace(/^[a-z]+_/, ''); message(`${nm[0].toUpperCase() + nm.slice(1)} ready`, 1500); }
      }
    }
  }

  // ---------------------------------------------------------------- combat
  function mul(attackerKind, victim) {
    const t = ROSTER[attackerKind]?.rps || C.rps[attackerKind] || C.rpsDefault;
    if (victim.air && t.air != null) return t.air;
    if (victim.light && t.light != null) return t.light;
    return t[victim.cls] ?? 1;
  }
  // Can attacker a hit victim v at all? (air / ground / burrowed rules)
  function canHit(a, v) {
    if (!v || v.burrowed) return false;
    if (v.air) return !!a.canHitAir;
    return a.canHitGround !== false;
  }

  function damage(victim, attacker, dmg) {
    if (!victim || victim.state === 'dead' || victim.cls === 'neutral' || !(dmg > 0)) return;
    const vs = victim.status;
    if (vs && vs.dmgMul != null && Number.isFinite(vs.dmgMul) && !(vs.until != null && now() > vs.until)) dmg *= Math.max(0, vs.dmgMul);
    if (victim.armor > 0) dmg *= 1 - Math.min(0.9, victim.armor);
    if (!(dmg > 0)) return;
    victim.hp -= dmg;
    emit('hit', { x: victim.x, z: victim.z, attacker, victim, dmg, cls: victim.cls });
    // Retaliate: an idle/auto unit that gets shot engages its attacker.
    if (attacker && victim.isUnit && victim.dps > 0 && attacker.state !== 'dead' &&
        (victim.state === 'idle' || (victim.state === 'attack' && victim.autoTarget && victim.target?.cls === 'bld'))) {
      victim.state = 'attack'; victim.target = attacker; victim.autoTarget = true;
    }
    // AI base defense: idle home units rally to a building under attack.
    if (attacker && attacker.state !== 'dead' && victim.cls === 'bld' && victim.team > 0 && AI[victim.team] && T >= AI[victim.team].defendAt) {
      AI[victim.team].defendAt = T + 1.5;
      for (const o of near(victim.x, victim.z, 50, qDef)) {
        if (o.team === victim.team && o.isUnit && o.dps > 0 && o.state === 'idle' && !o.aggressive) {
          o.state = 'attack'; o.target = attacker; o.autoTarget = true;
        }
      }
    }
    if (victim.hp <= 0) kill(victim);
  }

  function kill(e) {
    if (e.state === 'dead') return;
    e.hp = 0; e.state = 'dead'; e.target = null;
    pendingDead.push(e);
  }

  function sweep() {
    if (!pendingDead.length) return;
    const dead = pendingDead; pendingDead = [];
    let structural = false;
    for (const e of dead) {
      const i = ents.indexOf(e);
      if (i >= 0) ents.splice(i, 1);
      byId.delete(e.id);
      if (e.mesh) world.scene?.remove?.(e.mesh);
      world.input?.selected?.delete?.(e);
      if (!e.isUnit) structural = true;
      if (queues.has(e.id)) { queues.get(e.id).length = 0; queues.delete(e.id); }
      if (e.depleted) continue;
      emit('died', { entity: e });
      if (e.kind === 'cc' && hq[e.team] === e) {
        hq[e.team] = null;
        if (ui.gameOver) continue;
        if (e.team === 0) { ui.gameOver = 'lose'; message('Defeat. Your command center has fallen', 8000); }
        else {
          if (AI[e.team]) AI[e.team].alive = false;
          const left = hq.some((h, t) => t > 0 && h && h.state !== 'dead');
          if (!left) { ui.gameOver = 'win'; message('Victory! All enemy command centers destroyed', 8000); }
          else message(`${teamName(e.team)} eliminated`, 4000);
        }
      }
    }
    if (structural) rebuildStaticObs();
  }

  const isEnemyOf = (a, b) => b.team !== a.team && b.team >= 0 && b.state !== 'dead' && b.cls !== 'neutral';
  const edgeDist = (a, b) => Math.hypot(b.x - a.x, b.z - a.z) - b.r;

  function effRange(e) {
    let r = e.range;
    if (!e.isUnit && e.cls === 'bld' && !e.noNightPenalty && !world.defense?.hasSurveillance?.(e.team)) {
      r *= 1 - (1 - C.dayNight.nightTurretRangeMul) * (ui.nightFactor || 0);
    }
    return r;
  }

  // Nearest enemy within radius; buildings scored worse so units are preferred.
  function findTarget(e, radius) {
    let best = null, bestScore = Infinity;
    const turret = e.kind === 'turret_mg' || e.kind === 'turret_cannon';
    const cand = near(e.x, e.z, radius, qTarget);
    for (let i = 0; i < cand.length; i++) {
      const o = cand[i];
      if (!isEnemyOf(e, o) || !canHit(e, o)) continue;
      if (turret && o.cls === 'bld') continue;
      const d = edgeDist(e, o);
      if (d > radius) continue;
      if (e.minRange && d < e.minRange) continue;
      const s = d + (o.cls === 'bld' ? C.aggro.bldPenalty : 0);
      if (s < bestScore) { bestScore = s; best = o; }
    }
    return best;
  }
  function nearestEnemyBuilding(e) {
    // local first (cheap), then global fallback over structures
    let best = null, bd = Infinity;
    for (const o of near(e.x, e.z, 60, qTarget)) {
      if (o.cls !== 'bld' || !isEnemyOf(e, o) || !canHit(e, o)) continue;
      const d = edgeDist(e, o);
      if (d < bd) { bd = d; best = o; }
    }
    if (best) return best;
    if (e.canHitGround === false) return null;
    for (const o of staticObs) {
      if (o.cls !== 'bld' || !isEnemyOf(e, o)) continue;
      const d = edgeDist(e, o);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }

  function fire(e, t) {
    const m = mul(e.kind, t);
    const gy = (e.air ? e.y : 0) + (C.gunY[e.cls] ?? 1.5), ty = t.air ? (t.y || 8) : t.cls === 'inf' ? 1 : t.cls === 'veh' ? 1.2 : 2;
    emit('shot', { from: { x: e.x, z: e.z, y: gy }, to: { x: t.x, z: t.z, y: ty }, kind: e.kind });
    const dmg = e.dps * e.fireRate * m;
    if (e.splash > 0) {
      const tx = t.x, tz = t.z, sr = e.splash;
      const cand = near(tx, tz, sr, qSplash).slice();
      for (const o of cand) {
        if (!isEnemyOf(e, o) || !canHit(e, o)) continue;
        if (Math.hypot(o.x - tx, o.z - tz) - o.r <= sr) damage(o, e, e.dps * e.fireRate * mul(e.kind, o));
      }
    } else if (dmg > 0) damage(t, e, dmg);
  }

  // ---------------------------------------------------------------- movement
  const half = { w: MW / 2 - 1, h: MH / 2 - 1 };

  // Steer toward (tx,tz); returns remaining distance. `ignore` = entity not steered around (our goal).
  // Ghosting (anti-softlock): a unit with no path may pass through its own team's buildings/walls and crystals,
  // never through another team's structures.
  const ghostSkips = (e, owner) => e.ghost > 0 && (!owner || owner.team === e.team || owner.team === -1);
  const LOOK = 6;
  let sE, sDx, sDz, sDist, sSx, sSz, sIgnore;
  function avoid(ox, oz, or) {
    const e = sE;
    const rx = ox - e.x, rz = oz - e.z;
    const along = rx * sDx + rz * sDz;
    if (along <= 0 || along > sDist) return;
    const clear = or + e.r + 0.5;
    const d = Math.hypot(rx, rz);
    if (d > clear + LOOK) return;
    const cross = rx * sDz - rz * sDx;
    if (Math.abs(cross) >= clear) return;
    const w = 1.6 * (1 - Math.max(0, d - clear) / LOOK);
    const sgn = cross >= 0 ? 1 : -1;
    sSx += -sDz * sgn * w; sSz += sDx * sgn * w;
  }
  function avoidObs(o) {
    const e = sE;
    if (o.ent) { if (o.ent !== sIgnore && !ghostSkips(e, o.ent)) avoid(o.x, o.z, o.r); return; }
    // Team-tagged obstacles (gates) only block the other team; untagged block everyone.
    if ((o.team == null || o.team !== e.team) && !(o.owner && ghostSkips(e, o.owner))) avoid(o.x, o.z, o.r);
  }
  function moveSpeed(e) {
    let v = e.speed;
    if (e.burrowed) v *= 0.7;
    const st = e.status;
    if (st) {
      if (Number.isFinite(st.slowMul)) v *= Math.max(0, st.slowMul);
      if (Number.isFinite(st.speedMul)) v *= Math.max(0, st.speedMul);
    }
    return v;
  }
  function steer(e, tx, tz, dt, ignore) {
    let dx = tx - e.x, dz = tz - e.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-4) return 0;
    if (e._noMove) return dist;          // rooted / stunned
    const spd = moveSpeed(e);
    dx /= dist; dz /= dist;
    sE = e; sDx = dx; sDz = dz; sDist = dist; sSx = dx; sSz = dz; sIgnore = ignore;
    if (!e.air) eachObs(e.x, e.z, LOOK + e.r + 1, avoidObs);   // flyers ignore ground obstacles/walls
    // Other units: avoid ones that aren't travelling with us (prevents head-on harvester deadlocks).
    const cand = near(e.x, e.z, 10, qSteer);
    for (let i = 0; i < cand.length; i++) {
      const o = cand[i];
      if (!o.isUnit || o === e || o === ignore || o.state === 'dead' || o.air !== e.air) continue;
      const ox = o.x - e.x, oz = o.z - e.z;
      if (ox * ox + oz * oz > 100) continue;
      if (o.state !== 'idle' && Math.cos(o.rot) * dx - Math.sin(o.rot) * dz > 0.5) continue;
      avoid(o.x, o.z, o.r * 0.8);
    }
    let sx = sSx, sz = sSz;
    // Stuck fallback: if we barely moved since the last steer call, sidestep for a moment.
    if (e._px != null) {
      const moved = Math.hypot(e.x - e._px, e.z - e._pz);
      if (moved < 0.2 * spd * dt) e.stuckT = (e.stuckT || 0) + dt; else e.stuckT = Math.max(0, (e.stuckT || 0) - dt);
      if (e.stuckT > 0.8 && !(e.detour > 0)) { e.detour = 1.2; e.detourSide = Math.random() < 0.5 ? -1 : 1; e.stuckT = 0; }
    }
    if (e.detour > 0) { e.detour -= dt; sx += -dz * e.detourSide * 1.8; sz += dx * e.detourSide * 1.8; }
    const sl = Math.hypot(sx, sz) || 1;
    const step = Math.min(spd * dt, dist);
    const vx = sx / sl, vz = sz / sl;
    e.x += vx * step; e.z += vz * step;
    e._px = e.x; e._pz = e.z;
    turnTo(e, Math.atan2(-vz, vx), dt);
    return dist - step;
  }

  // ---------------------------------------------------------------- pathfinding
  // Coarse grid per team (gates only block the other team). Units steer straight when the line is clear,
  // otherwise follow an A* path (string-pulled) so wall rings / moat gaps / crystal pockets don't trap them.
  // A per-step budget (CONFIG.nav.pathsPerStep) spreads A* calls; a unit waiting for its path steers directly.
  const NC = C.nav.cell;
  const GW = Math.ceil(MW / NC), GH = Math.ceil(MH / NC), GX0 = -MW / 2, GZ0 = -MH / 2;
  const NAV_INFL = C.nav.infl;
  const grids = [], gridSig = [], gridAt = [], gridVer = [];
  for (let t = 0; t < NT; t++) { grids[t] = null; gridSig[t] = ''; gridAt[t] = -99; gridVer[t] = 0; }
  let pathBudget = 0;
  const cellX = (x) => Math.max(0, Math.min(GW - 1, Math.floor((x - GX0) / NC)));
  const cellZ = (z) => Math.max(0, Math.min(GH - 1, Math.floor((z - GZ0) / NC)));
  function gridFor(team) {
    if (team < 0 || team >= NT) team = 0;
    const obs = world.obstacles || [];
    const sig = obs.length + '|' + staticVer;
    if (grids[team] && gridSig[team] === sig && T - gridAt[team] < 6) return grids[team];
    const g = grids[team] || (grids[team] = new Uint8Array(GW * GH));
    g.fill(0);
    const mark = (ox, oz, or) => {
      const rr = or + NAV_INFL;
      const x0 = cellX(ox - rr), x1 = cellX(ox + rr), z0 = cellZ(oz - rr), z1 = cellZ(oz + rr);
      for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) {
        const px = (cx + 0.5) * NC + GX0, pz = (cz + 0.5) * NC + GZ0;
        if ((px - ox) ** 2 + (pz - oz) ** 2 <= rr * rr) g[cz * GW + cx] = 1;
      }
    };
    for (const o of obs) if (o.team == null || o.team !== team) mark(o.x, o.z, o.r);
    for (const o of staticObs) mark(o.x, o.z, o.blockR ?? o.r);
    if (gridSig[team] !== sig) gridVer[team]++;
    gridSig[team] = sig; gridAt[team] = T;
    return g;
  }
  // Clear line on the grid? Cells within `skipR` of the end point are ignored (the goal may be a building).
  function losClear(g, x0, z0, x1, z1, skipR) {
    const L = Math.hypot(x1 - x0, z1 - z0), n = Math.ceil(L / (NC * 0.5));
    for (let i = 1; i <= n; i++) {
      const f = i / n, x = x0 + (x1 - x0) * f, z = z0 + (z1 - z0) * f;
      if (skipR > 0 && (1 - f) * L < skipR) break;
      if (g[cellZ(z) * GW + cellX(x)]) return false;
    }
    return true;
  }
  function nearestFree(g, cx, cz) {
    if (!g[cz * GW + cx]) return [cx, cz];
    for (let r = 1; r < 14; r++) {
      let best = null, bd = Infinity;
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const x = cx + dx, z = cz + dz;
        if (x < 0 || z < 0 || x >= GW || z >= GH || g[z * GW + x]) continue;
        const d = dx * dx + dz * dz;
        if (d < bd) { bd = d; best = [x, z]; }
      }
      if (best) return best;
    }
    return null;
  }
  const gScore = new Float32Array(GW * GH), came = new Int32Array(GW * GH), stamp = new Uint32Array(GW * GH);
  let stampN = 0;
  const heapI = [], heapF = [];
  function hPush(i, f) {
    let k = heapI.length; heapI.push(i); heapF.push(f);
    while (k > 0) { const p = (k - 1) >> 1; if (heapF[p] <= f) break; heapI[k] = heapI[p]; heapF[k] = heapF[p]; k = p; }
    heapI[k] = i; heapF[k] = f;
  }
  function hPop() {
    const top = heapI[0], li = heapI.pop(), lf = heapF.pop();
    if (heapI.length) {
      let k = 0; const n = heapI.length;
      for (;;) { let c = 2 * k + 1; if (c >= n) break; if (c + 1 < n && heapF[c + 1] < heapF[c]) c++; if (heapF[c] >= lf) break; heapI[k] = heapI[c]; heapF[k] = heapF[c]; k = c; }
      heapI[k] = li; heapF[k] = lf;
    }
    return top;
  }
  const NB = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
  function findPath(team, sx, sz, tx, tz) {
    perf.paths++;
    const g = gridFor(team);
    const s0 = nearestFree(g, cellX(sx), cellZ(sz)), t0 = nearestFree(g, cellX(tx), cellZ(tz));
    if (!s0 || !t0) return null;
    const si = s0[1] * GW + s0[0], ti = t0[1] * GW + t0[0];
    if (++stampN >= 0xfffffff0) { stamp.fill(0); stampN = 1; }
    heapI.length = 0; heapF.length = 0;
    const h = (i) => { const dx = Math.abs(i % GW - t0[0]), dz = Math.abs(((i / GW) | 0) - t0[1]); return Math.max(dx, dz) + 0.41421 * Math.min(dx, dz); };
    stamp[si] = stampN; gScore[si] = 0; came[si] = -1; hPush(si, h(si));
    let found = false, it = 0;
    while (heapI.length && it++ < C.nav.maxIter) {
      const cur = hPop();
      if (cur === ti) { found = true; break; }
      const cx = cur % GW, cz = (cur / GW) | 0, gc = gScore[cur];
      for (const [dx, dz, c] of NB) {
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= GW || nz >= GH) continue;
        const ni = nz * GW + nx;
        if (g[ni]) continue;
        if (dx && dz && (g[cz * GW + nx] || g[nz * GW + cx])) continue; // no corner cutting
        const ng = gc + c;
        if (stamp[ni] === stampN && gScore[ni] <= ng) continue;
        stamp[ni] = stampN; gScore[ni] = ng; came[ni] = cur; hPush(ni, ng + h(ni));
      }
    }
    if (!found) return null;
    const cells = [];
    for (let i = ti; i !== -1; i = came[i]) cells.push({ x: (i % GW + 0.5) * NC + GX0, z: (((i / GW) | 0) + 0.5) * NC + GZ0 });
    cells.reverse();
    // string-pull
    const out = []; let ax = sx, az = sz, k = 0;
    while (k < cells.length) {
      let j = cells.length - 1;
      while (j > k && !losClear(g, ax, az, cells[j].x, cells[j].z, 0)) j--;
      out.push(cells[j]); ax = cells[j].x; az = cells[j].z; k = j + 1;
    }
    return out;
  }
  // Move toward (tx,tz) via path if needed; returns remaining distance to (tx,tz).
  function nav(e, tx, tz, dt, ignore) {
    if (e.air) return steer(e, tx, tz, dt, ignore);
    const g = gridFor(e.team);
    let n = e._nav;
    const skip = ignore ? ignore.r + NAV_INFL + 1 : 1.5;
    const stale = !n || Math.abs(n.tx - tx) > 2 || Math.abs(n.tz - tz) > 2 || n.ver !== gridVer[e.team] ||
      (e.stuckT > 0.6 && T - n.at > 1.5) || (n.pts && T - n.at > 4);
    if (stale) {
      n = e._nav = { tx, tz, ver: gridVer[e.team], at: T, pts: null, need: !losClear(g, e.x, e.z, tx, tz, skip), chk: 0 };
    }
    if (n.need && pathBudget > 0) {
      pathBudget--; n.need = false;
      n.pts = findPath(e.team, e.x, e.z, tx, tz);
      if (!n.pts && e.stuckT > 0.3) e.ghost = 2.5;   // boxed in (e.g. a wall closed a pocket around us)
    }
    const pts = n.pts;
    if (pts && pts.length) {
      // drop reached waypoints; shortcut to the goal once it's in sight (LOS checks throttled)
      while (pts.length && Math.hypot(pts[0].x - e.x, pts[0].z - e.z) < 1.2) pts.shift();
      n.chk -= dt;
      if (n.chk <= 0) {
        n.chk = 0.25;
        if (pts.length > 1 && losClear(g, e.x, e.z, pts[1].x, pts[1].z, 0)) pts.shift();
        if (!pts.length || losClear(g, e.x, e.z, tx, tz, skip)) n.pts = null;
      } else if (!pts.length) n.pts = null;
    }
    if (n.pts && n.pts.length) {
      steer(e, n.pts[0].x, n.pts[0].z, dt, ignore);
      return Math.hypot(tx - e.x, tz - e.z);
    }
    return steer(e, tx, tz, dt, ignore);
  }

  function turnTo(e, ang, dt) {
    let d = ang - e.rot;
    d = ((d + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
    const max = 8 * dt;
    e.rot += Math.abs(d) <= max ? d : Math.sign(d) * max;
  }

  let pE = null;
  function pushObs(o) {
    const e = pE;
    if (o.ent) { if (!ghostSkips(e, o.ent)) pushOut(e, o.x, o.z, o.r); return; }
    if ((o.team == null || o.team !== e.team) && !(o.owner && ghostSkips(e, o.owner))) pushOut(e, o.x, o.z, o.r);
  }
  function resolveCollisions(units) {
    // unit-unit separation via the spatial hash (each pair once: lower id pushes)
    for (let i = 0; i < units.length; i++) {
      const a = units[i];
      const cand = near(a.x, a.z, a.r + 2.5, qCol);
      for (let j = 0; j < cand.length; j++) {
        const b = cand[j];
        if (!b.isUnit || b.id <= a.id || b.state === 'dead' || b.air !== a.air) continue;
        const dx = b.x - a.x, dz = b.z - a.z, rr = a.r + b.r;
        if (dx > rr || dx < -rr || dz > rr || dz < -rr) continue;
        const d2 = dx * dx + dz * dz;
        if (d2 >= rr * rr) continue;
        const d = Math.sqrt(d2) || 0.01, push = (rr - d) * 0.5;
        const nx = d2 ? dx / d : Math.random() - 0.5, nz = d2 ? dz / d : Math.random() - 0.5;
        a.x -= nx * push; a.z -= nz * push; b.x += nx * push; b.z += nz * push;
      }
    }
    // push out of obstacles/buildings and clamp to map
    for (const e of units) {
      if (e.ghost > 0) e.ghost -= lastDt;
      pE = e;
      if (!e.air) eachObs(e.x, e.z, e.r + 0.5, pushObs);
      if (e.x > half.w) e.x = half.w; else if (e.x < -half.w) e.x = -half.w;
      if (e.z > half.h) e.z = half.h; else if (e.z < -half.h) e.z = -half.h;
      if (!Number.isFinite(e.x) || !Number.isFinite(e.z)) { e.x = e._px ?? 0; e.z = e._pz ?? 0; if (!Number.isFinite(e.x)) e.x = 0; if (!Number.isFinite(e.z)) e.z = 0; }
    }
  }
  function pushOut(e, ox, oz, or) {
    const dx = e.x - ox, dz = e.z - oz, rr = or + e.r;
    if (dx > rr || dx < -rr || dz > rr || dz < -rr) return;
    const d2 = dx * dx + dz * dz;
    if (d2 >= rr * rr) return;
    const d = Math.sqrt(d2) || 0.01;
    e.x = ox + dx / d * rr; e.z = oz + dz / d * rr;
  }

  // ---------------------------------------------------------------- commands
  function applyCommand() {
    // Engine clears input.command at the start of the next frame; we just avoid re-applying the same object.
    const cmd = world.input?.command;
    if (!cmd || cmd === lastCmd) return;
    lastCmd = cmd;
    const sel = [...(world.input.selected || [])].filter(e => e.team === 0 && e.isUnit && e.state !== 'dead');
    if (!sel.length) return;
    // Hidden (fogged) targets can't be targeted: treat as a move to the tapped ground point.
    let tgt = cmd.target && cmd.target.state !== 'dead' ? cmd.target : null;
    if (tgt && tgt.hidden && fog.enabled) tgt = null;
    const n = sel.length, cols = Math.ceil(Math.sqrt(n)), sp = 3.2;
    sel.forEach((e, i) => {
      e.aggressive = false; e.autoTarget = false; e.manual = false;
      if (cmd.type === 'attack' && tgt && isEnemyOf(e, tgt) && e.dps > 0 && canHit(e, tgt)) {
        e.state = 'attack'; e.target = tgt; e.dest = null;
        return;
      }
      const ox = (i % cols - (cols - 1) / 2) * sp, oz = (Math.floor(i / cols) - (cols - 1) / 2) * sp;
      const x = (tgt ? tgt.x : cmd.x) + (n > 1 ? ox : 0), z = (tgt ? tgt.z : cmd.z) + (n > 1 ? oz : 0);
      if (!Number.isFinite(x) || !Number.isFinite(z)) return;
      e.state = 'move'; e.target = null; e.dest = { x, z }; e.stall = 0; e.stallRef = null;
      if (e.harv) {
        e.manual = true;
        // Tapping a crystal with a harvester = gather there.
        if (tgt && tgt.kind === 'crystal') { e.manual = false; e.field = tgt; e.state = 'gather'; e.dest = null; e.harvT = 0; }
      }
    });
  }

  // ---------------------------------------------------------------- unit AI
  function arrive(e) {
    e.dest = null; e.state = 'idle'; e.idleT = 0;
  }

  function updateMover(e, dt) {
    const d = e.dest;
    const rem = nav(e, d.x, d.z, dt, null);
    // stall detection: crowded at destination
    e.stall += dt;
    if (e.stall > 1) {
      const moved = e.stallRef ? Math.hypot(e.x - e.stallRef.x, e.z - e.stallRef.z) : 99;
      if (moved < 0.6 && rem < 10) return arrive(e);
      e.stall = 0; e.stallRef = { x: e.x, z: e.z };
    }
    if (rem <= e.r) {
      arrive(e);
      return;
    }
    if (e.aggressive && e.dps > 0) {
      e.scan -= dt;
      if (e.scan <= 0) {
        e.scan = C.aggro.scanInterval;
        const t = findTarget(e, C.aggro.moving);
        if (t) { e.state = 'attack'; e.target = t; e.autoTarget = true; }
      }
    }
  }

  function updateCombat(e, dt) {
    let t = e.target;
    if (!t || t.state === 'dead' || !canHit(e, t)) t = e.target = null;
    if (e.autoTarget || !t) {
      e.scan -= dt;
      if (e.scan <= 0) {
        e.scan = C.aggro.scanInterval;
        const nt = findTarget(e, e.isUnit ? C.aggro.unit : effRange(e));
        if (nt && (!t || edgeDist(e, nt) + 2 < edgeDist(e, t) || t.cls === 'bld' && nt.cls !== 'bld')) { t = e.target = nt; e.autoTarget = true; }
      }
    }
    if (!t) {
      if (e.state === 'attack') {
        e.state = 'idle';
        if (e.aggressive && e.waveDest) { e.state = 'move'; e.dest = { ...e.waveDest }; e.stall = 0; e.stallRef = null; }
      }
      return;
    }
    const d = edgeDist(e, t);
    const rng = e.isUnit ? e.range : effRange(e);
    if (e.autoTarget && e.isUnit && d > C.aggro.leash) { e.target = null; return; }
    if (!e.isUnit && d > rng) { e.target = null; return; }
    e.state = 'attack';
    const ang = Math.atan2(e.z - t.z, t.x - e.x);
    if (d <= rng) {
      if (e.isUnit) turnTo(e, ang, dt); else e.rot = ang;
      if (e.cooldown <= 0 && !e._stunned && !e.burrowed) { e.cooldown = e.fireRate; fire(e, t); }
    } else if (e.isUnit) {
      nav(e, t.x, t.z, dt, t);
    }
    const tur = e.mesh?.userData?.turret;
    if (tur && tur.rotation) tur.rotation.y = ang - e.rot;
  }

  function pickField(e) {
    let best = null, bs = Infinity;
    const home = hq[e.team] || e;
    for (const o of staticObs) {
      if (o.kind !== 'crystal' || o.state === 'dead' || !(o.amount > 0)) continue;
      if (o.home != null && o.home !== -1 && o.home !== e.team) continue;   // never mine another base's field
      let occ = 0;
      for (const h of unitsBuf) if (h !== e && h.harv && h.field === o) occ++;
      const s = Math.hypot(o.x - home.x, o.z - home.z) + Math.hypot(o.x - e.x, o.z - e.z) * 0.25 + occ * 6;
      if (s < bs) { bs = s; best = o; }
    }
    return best;
  }

  function updateHarvester(e, dt) {
    if (e.state === 'move') return updateMover(e, dt);
    if (e.state === 'idle') {
      e.idleT += dt;
      if (e.manual && e.idleT < C.economy.idleHarvesterRestart) return;
      e.manual = false;
      if (e.carry > 0) { e.state = 'return'; e.harvT = 0; return; }
      if (e.idleT < 0.5 && e.idleT > 0) { /* fallthrough */ }
      e.field = pickField(e);
      if (!e.field) return;
      e.state = 'gather'; e.harvT = 0;
    }
    if (e.state === 'gather') {
      const f = e.field;
      if (!f || f.state === 'dead' || !(f.amount > 0)) { e.field = null; e.state = 'idle'; e.idleT = 99; return; }
      const reach = f.r + e.r + 1.2;
      if (Math.hypot(f.x - e.x, f.z - e.z) > reach) { nav(e, f.x, f.z, dt, f); e.harvT = 0; return; }
      e.harvT += dt;
      if (e.harvT >= C.economy.gatherTime) {
        const want = C.economy.harvesterCarry * (f.rich ? C.economy.richMul : 1);
        const take = Math.min(want, f.amount);
        f.amount -= take; e.carry = take; e.harvT = 0; e.state = 'return';
        if (f.amount <= 0) { f.depleted = true; kill(f); }
      }
    } else if (e.state === 'return') {
      const cc = hq[e.team];
      if (!cc || cc.state === 'dead') { e.state = 'idle'; return; }
      const reach = cc.r + e.r + 1.5;
      if (Math.hypot(cc.x - e.x, cc.z - e.z) > reach) { nav(e, cc.x, cc.z, dt, cc); e.harvT = 0; return; }
      e.harvT += dt;
      if (e.harvT >= C.economy.depositTime) {
        crystals[e.team] += e.carry; e.carry = 0; e.harvT = 0;
        e.state = e.field && e.field.state !== 'dead' ? 'gather' : 'idle';
        e.idleT = 99;
      }
    }
  }

  // ---------------------------------------------------------------- AI (teams 1..NT-1, independent)
  function nearestEnemyHQ(t) {
    const me = hq[t]; if (!me) return null;
    let best = null, bd = Infinity;
    for (let o = 0; o < NT; o++) {
      const h = hq[o];
      if (o === t || !h || h.state === 'dead') continue;
      const d = Math.hypot(h.x - me.x, h.z - me.z);
      if (d < bd) { bd = d; best = h; }
    }
    return best;
  }
  const reserveFor = (t) => {
    const d = world.defense;
    if (typeof d?.reserveFor === 'function') return d.reserveFor(t) || 0;
    if (t === 1 && d?.enemyReserve != null) return d.enemyReserve;
    return C.pacing.enemyReserve;
  };
  // Combat kinds team t can build now: its faction's roster kinds if the roster has any, else the legacy kinds.
  function aiOptions(t, blds) {
    const f = world.factions?.[t];
    const hasRoster = Object.keys(ROSTER).some(k => ROSTER[k]?.faction === f);
    const out = [];
    for (const b of blds) {
      if (!b) continue;
      for (const k of producesFor(b)) {
        if (isHarvKind(k) || (hasRoster && !ROSTER[k]) || (!hasRoster && !COMBAT_KINDS.includes(k))) continue;
        const u = unitDef(k);
        if (!u || !(u.cost >= 0)) continue;
        if (!(u.dps > 0) && u.role !== 'special') continue;
        out.push({ kind: k, b });
      }
    }
    return out;
  }
  const ROLE_W = { inf: 3, light: 2, heavy: 1.5, special: 1, air: 1.5, aa: 0.8 };
  const LEGACY_ROLE = { warden: 'inf', raider: 'light', tank: 'heavy' };
  const DUMMY = { inf: { cls: 'inf' }, veh: { cls: 'veh' }, air: { cls: 'veh', air: true } };
  function aiWeight(kind, rc) {
    const u = unitDef(kind);
    const role = u.role || LEGACY_ROLE[kind] || (u.air ? 'air' : u.cls === 'inf' ? 'inf' : u.light ? 'light' : 'heavy');
    let w = ROLE_W[role] ?? 1;
    if (!rc) return w;
    const tot = rc.inf + rc.veh + rc.air;
    if (!tot) return role === 'aa' ? w * 0.3 : w;
    const fa = rc.air / tot;
    let edge = 0;
    for (const c of ['inf', 'veh', 'air']) {
      const f = rc[c] / tot; if (!f) continue;
      const hits = c === 'air' ? !!u.canHitAir : u.canHitGround !== false;
      edge += f * ((hits ? mul(kind, DUMMY[c]) : 0) - 1);
    }
    w *= Math.max(0.15, 1 + C.pacing.counterWeight * edge);
    if (u.canHitAir && fa > 0) w *= 1 + 2 * fa;
    if (role === 'aa' && fa === 0) w *= 0.3;
    return w;
  }
  function aiTeam(t, dt) {
    const st = AI[t];
    if (!st.alive || !hq[t]) return;
    const P = C.pacing;
    crystals[t] += (P.enemyTrickleBase + P.enemyTrickleGrowth * T / 60) / 60 * dt;
    st.think -= dt;
    if (st.think <= 0) {
      st.think = 1;
      const bar = byKind('barracks', t), fac = byKind('factory', t);
      const qOf = (b) => (b && queues.get(b.id)) || [];
      const reserve = reserveFor(t);
      const army = counts[t].army;
      // Below the minimum army the AI spends everything on units; above it, it banks for defense tiers.
      const canBuy = (k) => crystals[t] - unitDef(k).cost >= (T > P.firstWave && army >= P.enemyMinArmy ? reserve : 0);
      // harvesters (faction kind; cc builds them if the producing building is gone)
      const hk = harvKindFor(t);
      const hb = [fac, bar, hq[t]].find(b => b && producesFor(b).includes(hk));
      const harvs = counts[t].harv + (hb ? qOf(hb).filter(q => isHarvKind(q.kind)).length : 0);
      const want = T >= P.enemyThirdHarvesterAt ? P.enemyHarvesters
        : T >= P.enemySecondHarvesterAt ? Math.min(2, P.enemyHarvesters) : 1;
      if (hb && harvs < want && qOf(hb).length < P.enemyMaxQueued && crystals[t] >= (unitDef(hk)?.cost ?? 100)) enqueue(hb, hk);
      // army: weighted pick from this faction's roster, skewed toward counters of the current rival's army
      const rival = nearestEnemyHQ(t);
      const opts = aiOptions(t, [bar, fac]);
      if (opts.length) {
        const w = opts.map(o => aiWeight(o.kind, rival ? counts[rival.team] : null));
        const sum = w.reduce((x, y) => x + y, 0);
        for (let tries = 0; tries < 2; tries++) {
          let r = Math.random() * sum, pick = opts[0];
          for (let i = 0; i < opts.length; i++) { if ((r -= w[i]) <= 0) { pick = opts[i]; break; } }
          const u = unitDef(pick.kind);
          if (qOf(pick.b).length < P.enemyMaxQueued && canBuy(pick.kind) && supplyUsed(t) + (u.supply ?? 1) <= C.supplyCap) enqueue(pick.b, pick.kind);
        }
      }
    }
    if (T >= st.nextWave) {
      st.nextWave += P.waveInterval;
      st.waveNo++;
      const size = Math.min(P.waveMax, P.waveBase + Math.floor(T / P.waveGrowthPer));
      const target = nearestEnemyHQ(t);
      if (!target) return;
      st.target = target.team;
      const idle = unitsBuf.filter(e => e.team === t && e.dps > 0 && e.state === 'idle' && !e.aggressive);
      idle.sort((a, b) => Math.hypot(b.x - target.x, b.z - target.z) - Math.hypot(a.x - target.x, a.z - target.z));
      const group = idle.slice(0, size);
      group.forEach((e, i) => {
        const a = i * 2.4, rad = target.r + 4 + (i % 4) * 2;
        e.waveDest = { x: target.x + Math.cos(a) * rad, z: target.z + Math.sin(a) * rad };
        e.dest = { ...e.waveDest }; e.state = 'move'; e.aggressive = true; e.stall = 0; e.stallRef = null;
      });
      if (group.length) emit('wave', { team: t, target: target.team, size: group.length, n: st.waveNo });
      if (group.length && target.team === 0) message(`${teamName(t)} wave ${st.waveNo} incoming (${group.length})`, 3000);
    }
  }

  // ---------------------------------------------------------------- frame
  const unitsBuf = [];
  function update(dtIn) {
    sweep();
    if (ui.gameOver) return;
    // Always consume the full game dt (world.clock.dt = min(real,0.05)*speed). At high clock.speed this is
    // split into <=0.1s substeps so steering/collisions stay stable.
    const dtAll = typeof dtIn === 'number' ? dtIn : world.clock?.dt ?? 0;
    if (!(dtAll > 0)) return;
    const t0 = performance.now();
    applyCommand();
    const n = Math.min(40, Math.ceil(dtAll / 0.1));
    const dt = dtAll / n;
    for (let k = 0; k < n && !ui.gameOver; k++) step(dt);
    fogTick(dtAll);
    for (const e of unitsBuf) {
      const m = e.mesh;
      if (!m) continue;
      m.position?.set?.(e.x, e.air ? e.y : 0, e.z);
      // e.rot is the mesh yaw: meshes face local +X, so heading (dx,dz) => rot = atan2(-dz, dx) == -atan2(dz, dx).
      if (m.rotation) m.rotation.y = e.rot;
      // Out of combat, swing the turret back to the hull's forward so vehicles don't look like they drive sideways.
      const tur = m.userData?.turret;
      if (tur?.rotation && e.state !== 'attack' && tur.rotation.y) {
        const d = ((tur.rotation.y + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
        const mx = 4 * dtAll;
        tur.rotation.y = Math.abs(d) <= mx ? 0 : d - Math.sign(d) * mx;
      }
    }
    writeUi();
    perf.stepMs = performance.now() - t0;
  }

  const now = () => world.clock?.t ?? T;
  const active = (v, t) => v === true || (typeof v === 'number' && v > t);
  function applyStatus(e) {
    const s = e.status, t = now();
    if (s.until != null && t > s.until) { e.status = null; e._noMove = e._stunned = false; return; }
    e._stunned = active(s.stunned, t);
    e._noMove = e._stunned || active(s.rooted, t);
  }
  function syncStats(e) {
    const s = e.stats;
    if (s.speed != null) e.speed = s.speed;
    if (s.range != null) e.range = s.range;
    if (s.dps != null) e.dps = s.dps;
    if (s.cooldown != null) e.fireRate = s.cooldown;
    if (s.r != null) e.r = s.r;
  }

  let lastDt = 0;
  function step(dt) {
    T += dt; lastDt = dt;
    pathBudget = C.nav.pathsPerStep;
    updateQueues(dt);

    unitsBuf.length = 0;
    for (const c of counts) { c.units = 0; c.army = 0; c.harv = 0; c.warden = 0; c.raider = 0; c.tank = 0; }
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (!e.isUnit || e.state === 'dead') continue;
      unitsBuf.push(e);
      if (e.stats) syncStats(e);
      if (e.status) applyStatus(e); else if (e._noMove) e._noMove = e._stunned = false;
      const c = counts[e.team];
      if (!c) continue;
      c.units++;
      if (e.harv) c.harv++;
      else {
        c.army++;
        if (c[e.kind] != null) c[e.kind]++;
        if (e.air) c.air++; else if (e.cls === 'inf') c.inf++; else c.veh++;
        if (e.armor >= 0.2 || (e.cls === 'veh' && !e.light)) c.armored++;
      }
    }
    hashRebuild();
    obsHash();
    for (let t = 1; t < NT; t++) aiTeam(t, dt);

    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (e.state === 'dead') continue;
      if (e.cooldown > 0) e.cooldown -= dt;
      if (e.isUnit) {
        if (e.harv) updateHarvester(e, dt);
        else if (e.state === 'move') updateMover(e, dt);
        else if (e.state === 'attack') updateCombat(e, dt);
        else if (e.state === 'idle') {
          updateCombat(e, dt);
          if (e.state === 'idle' && e.aggressive && e.team !== 0 && e.scan <= dt) {
            const b = nearestEnemyBuilding(e);   // siege mode after a wave arrives
            if (b) { e.state = 'attack'; e.target = b; e.autoTarget = true; }
          }
        }
      } else if (e.dps > 0 && !e.external) {
        updateCombat(e, dt);
      }
    }
    resolveCollisions(unitsBuf);
    sweep();
  }

  function writeUi() {
    ui.time = T;
    const cyc = C.dayNight.cycle;
    ui.nightFactor = 0.5 - 0.5 * Math.cos(TWO_PI * (T % cyc) / cyc);
    ui.phase = ui.nightFactor > 0.5 ? 'night' : 'day';
    ui.crystals = Math.floor(crystals[0]);
    ui.supply = supplyUsed(0);
    ui.supplyCap = C.supplyCap;
    let nw = Infinity;
    for (let t = 1; t < NT; t++) if (AI[t].alive && AI[t].target === 0 || AI[t].alive && AI[t].target == null) nw = Math.min(nw, AI[t].nextWave);
    ui.nextWave = Number.isFinite(nw) ? Math.max(0, nw - T) : 0;
    ui.teamsAlive = hq.map(h => !!(h && h.state !== 'dead'));
    const pb = byKind('barracks', 0), pf = byKind('factory', 0);
    ui.queues.barracks = (pb && queues.get(pb.id)) || [];
    ui.queues.factory = (pf && queues.get(pf.id)) || [];
  }

  function buildDefense() {
    const fn = world.defense?.buildDefense;
    if (typeof fn === 'function') return fn.call(world.defense, 0);
    message('Defenses not available yet');
    return false;
  }

  ui.queues = ui.queues || {};
  if (ui.gameOver === undefined) ui.gameOver = null;
  // initial fog + hidden flags so the first rendered frame is already correct
  hashRebuild(); obsHash(); fogRecompute();
  writeUi();

  const sim = {
    update, enqueue, buildDefense, spawn, damage, spendCrystals, mul, kill, near, canHit, producesFor, unitDef, roster: ROSTER,
    entities: ents, crystals, queues, config: C, counts, perf, bases, hq, ai: AI,
    teamCount: NT,
    get time() { return T; },
  };
  world.sim = sim;
  return sim;
}
