// Vanguard — ECONOMY v3 (owner: ECON). Two currencies per faction, land plots, extractors, hauling, processors,
// Aether conversion, manpower (supply cap + defense crews) and the AI economy. Created by sim.js (createSim) and
// exposed as world.econ / sim.econ. All numbers live in CONFIG.econ (config.js).
//
// TODO.md (econ):
//  - Meshes for 'plot' / 'extractor' / 'processor' / 'housing' are procedural here. GRAPHICS-B can take over by
//    setting world.econModel = (kind, entity) => Object3D|null (called first; null = use ours). Earth extractors
//    show entity.stage 1..3; e.built/e.constructing/e.unmanned are on the entity for visuals.
//  - Plot sheet: if world.buildmode?.openPlotSheet(entity) exists (BUILDER), hud.js delegates to it; otherwise the
//    HUD shows a fallback sheet from econ.plotActions(entity).
//  - defense.js must skip firing for entities with unmanned === true (sim.js already does for its own turrets).
//  - Heroes should pay econ.cost('hero') via econ.spend(team, cost); heroes.js still uses sim.spendCrystals(600).
import { CONFIG } from './config.js';

const TAU = Math.PI * 2;
export const ECON_KINDS = new Set(['plot', 'extractor', 'processor', 'housing']);
const PLOT_WORDS = {
  vanguard: { primary: 'Ore deposit', secondary: 'Oil field', aether: 'Aether crystals' },
  volcanic: { primary: 'Obsidian deposit', secondary: 'Pressure pocket', aether: 'Aether crystals' },
  earth:    { primary: 'Sunlit glade', secondary: 'Windy rise', aether: 'Aether crystals' },
  storm:    { primary: 'Storm ridge', secondary: 'Dew flats', aether: 'Aether crystals' },
};
const RES_COLOR = { primary: 0xb7a38a, secondary: 0xe0b050, aether: 0x39d8ff };

export function createEconomy(world, sim, H) {
  const C = CONFIG, E = C.econ, NT = C.teams.count;
  const ents = H.ents;
  const T = () => H.now();
  const fac = (t) => world.factions?.[t] || C.teams.factions[t] || 'vanguard';
  const names = (t) => E.names[fac(t)] || E.names.vanguard;
  const mods = (t) => E.mods[fac(t)] || {};
  const pers = (t) => E.ai[fac(t)] || E.ai.vanguard;
  const teamName = (t) => C.teams.names[t] || `Team ${t}`;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const live = (e) => e && e.state !== 'dead';

  // ---------------------------------------------------------------- currencies
  const res = [];
  for (let t = 0; t < NT; t++) { const s = t === 0 ? E.start : E.aiStart; res[t] = { primary: s.primary, secondary: s.secondary }; }
  const norm = (c) => typeof c === 'number' ? { primary: c, secondary: 0 } : { primary: +(c?.primary || 0), secondary: +(c?.secondary || 0) };
  function canAfford(team, cost) {
    const r = res[team], c = norm(cost);
    return !!r && r.primary >= c.primary - 1e-6 && r.secondary >= c.secondary - 1e-6;
  }
  const aiSpent = Array.from({ length: NT }, () => ({ expand: 0, defense: 0, tech: 0, army: 0, other: 0 }));
  function spend(team, cost, cat) {
    const c = norm(cost);
    if (!(c.primary >= 0 && c.secondary >= 0) || !canAfford(team, c)) return false;
    res[team].primary -= c.primary; res[team].secondary -= c.secondary;
    const s = aiSpent[team]; if (s) s[cat && s[cat] != null ? cat : 'other'] += c.secondary;
    return true;
  }
  // income ring: 60 one-second buckets per team per kind (realized income, i.e. what actually reached the bank)
  const inc = Array.from({ length: NT }, () => ({ primary: new Float32Array(60), secondary: new Float32Array(60) }));
  let lastSec = 0;
  const earned = Array.from({ length: NT }, () => ({ primary: 0, secondary: 0 }));
  function add(team, kind, n, isIncome = true) {
    if (!res[team] || !(n > 0) || (kind !== 'primary' && kind !== 'secondary')) return;
    res[team][kind] += n;
    if (isIncome) { inc[team][kind][Math.floor(T()) % 60] += n; earned[team][kind] += n; }
  }
  function tickIncome() {
    const s = Math.floor(T());
    while (lastSec < s) { lastSec++; const i = lastSec % 60; for (let t = 0; t < NT; t++) { inc[t].primary[i] = 0; inc[t].secondary[i] = 0; } }
  }
  function incomePerMin(team, kind) {
    const b = inc[team]?.[kind]; if (!b) return 0;
    let s = 0; for (let i = 0; i < 60; i++) s += b[i];
    return s / Math.min(60, Math.max(30, T())) * 60;
  }

  // ---------------------------------------------------------------- costs
  function unitCost(kind) {
    const u = H.unitDef(kind);
    if (!u) return { primary: 0, secondary: 0 };
    if (u.cost && typeof u.cost === 'object') return norm(u.cost);
    return { primary: u.cost || 0, secondary: u.costSecondary || 0 };
  }
  function cost(kind, team = 0) {
    if (kind === 'claim') return { primary: 0, secondary: E.claim.secondary };
    if (kind === 'claimAether') return { primary: 0, secondary: E.claim.aetherSecondary };
    if (kind === 'extractor_primary' || kind === 'extractor_secondary' || kind === 'extractor_aether') return { primary: extSpec(team, kind.slice(10)).cost, secondary: 0 };
    const c = E.costs[kind];
    if (c) return norm(c);
    if (H.unitDef(kind)) return unitCost(kind);
    return null;
  }

  // ---------------------------------------------------------------- manpower
  const capCache = new Array(NT).fill(0), crewCache = new Array(NT).fill(0);
  function computeCaps() {
    capCache.fill(0); crewCache.fill(0);
    for (const e of ents) {
      if (e.team < 0 || e.team >= NT || e.state === 'dead' || e.isUnit) continue;
      if (!e.constructing) capCache[e.team] += E.supply[e.kind] || 0;
      if (e.crew > 0) crewCache[e.team] += e.crew;
    }
    for (let t = 0; t < NT; t++) capCache[t] = Math.min(E.supply.max, capCache[t]);
  }
  const supplyCap = (team) => capCache[team] || 0;
  const crewUsed = (team) => crewCache[team] || 0;
  const supplyUsed = (team) => H.unitSupply(team) + crewUsed(team);
  const crewNeed = (e) => (Number.isFinite(e.crewNeed) ? e.crewNeed : E.crew[e.kind] ?? (e.siege ? E.crew.siege : 0)) || 0;
  function requestCrew(e, n) {
    if (!live(e) || e.team < 0) return false;
    n = n ?? crewNeed(e);
    if (!(n > 0)) { e.unmanned = false; return true; }
    if ((e.crew || 0) >= n) { e.unmanned = false; e.needsCrew = 0; return true; }
    const have = e.crew || 0, more = n - have;
    const free = supplyCap(e.team) - supplyUsed(e.team);
    const pc = { primary: E.crewPrimary * more, secondary: 0 };
    if (free >= more && canAfford(e.team, pc)) {
      spend(e.team, pc);
      e.crew = n; crewCache[e.team] += more; e.unmanned = false; e.needsCrew = 0;
      return true;
    }
    e.unmanned = true; e.needsCrew = n;
    return false;
  }
  function releaseCrew(e) {
    if (!e || !(e.crew > 0)) return;
    if (e.team >= 0 && e.team < NT) crewCache[e.team] = Math.max(0, crewCache[e.team] - e.crew);
    e.crew = 0;
    if (live(e)) { e.unmanned = true; e.needsCrew = crewNeed(e); }
  }
  let crewT = 0;
  function crewTick(dt) {
    crewT -= dt; if (crewT > 0) return;
    crewT = E.crewRetry;
    for (const e of ents) {
      if (e.isUnit || e.state === 'dead' || e.team < 0 || e.trap || e.untargetable) continue;
      const n = crewNeed(e); if (!(n > 0)) continue;
      if (e.crew == null || e.unmanned || e.crew < n) requestCrew(e, n);
    }
  }

  // ---------------------------------------------------------------- meshes
  const THREE = world.THREE;
  const matCache = new Map();
  const mat = (color, o = {}) => {
    if (!THREE) return null;
    const k = color + JSON.stringify(o);
    let m = matCache.get(k);
    if (!m) { m = o.basic ? new THREE.MeshBasicMaterial({ color, transparent: !!o.opacity, opacity: o.opacity ?? 1, depthWrite: !o.opacity, side: THREE.DoubleSide }) : new THREE.MeshStandardMaterial({ color, roughness: o.rough ?? 0.8, metalness: o.metal ?? 0.1, emissive: o.emissive ?? 0, emissiveIntensity: o.ei ?? 1, flatShading: !!o.flat }); matCache.set(k, m); }
    return m;
  };
  const geoCache = new Map();
  const geo = (k, f) => { let g = geoCache.get(k); if (!g) { g = f(); geoCache.set(k, g); } return g; };
  function part(g, m, x = 0, y = 0, z = 0, parent) {
    const o = new THREE.Mesh(g, m); o.position.set(x, y, z); o.castShadow = true; o.receiveShadow = true; (parent)?.add(o); return o;
  }
  const box = (w, h, d, m, x, y, z, p) => part(geo(`b${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d)), m, x, y, z, p);
  const cyl = (rt, rb, h, m, x, y, z, p, s = 10) => part(geo(`c${rt},${rb},${h},${s}`, () => new THREE.CylinderGeometry(rt, rb, h, s)), m, x, y, z, p);
  const sph = (r, m, x, y, z, p) => part(geo(`s${r}`, () => new THREE.SphereGeometry(r, 12, 8)), m, x, y, z, p);
  const rock = (r, m, x, y, z, p) => { const o = part(geo(`r${r}`, () => new THREE.DodecahedronGeometry(r, 0)), m, x, y, z, p); o.rotation.set(Math.random() * 3, Math.random() * 3, 0); return o; };

  function buildPlotMesh(p) {
    const g = new THREE.Group();
    const r = p.r;
    const ring = new THREE.Mesh(geo(`pr${r}`, () => new THREE.RingGeometry(r - 0.45, r, 48)), new THREE.MeshBasicMaterial({ color: RES_COLOR[p.res], transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.14; ring.renderOrder = 2; g.add(ring);
    const fill = new THREE.Mesh(geo(`pf${r}`, () => new THREE.CircleGeometry(r - 0.45, 40)), new THREE.MeshBasicMaterial({ color: RES_COLOR[p.res], transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide }));
    fill.rotation.x = -Math.PI / 2; fill.position.y = 0.12; fill.renderOrder = 1; g.add(fill);
    const prog = new THREE.Mesh(geo(`pp${r}`, () => new THREE.CircleGeometry(r - 0.6, 40)), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }));
    prog.rotation.x = -Math.PI / 2; prog.position.y = 0.13; prog.visible = false; prog.renderOrder = 1; g.add(prog);
    if (p.res === 'primary') {
      const m = mat(0x6d625a, { flat: true });
      for (let i = 0; i < 4; i++) { const a = i * 1.7 + 0.4, d = r * (0.45 + 0.12 * (i % 2)); rock(0.5 + (i % 3) * 0.25, m, Math.cos(a) * d, 0.25, Math.sin(a) * d, g); }
    } else if (p.res === 'secondary') {
      const m = mat(0xd9b25a);
      for (let i = 0; i < 4; i++) { const a = i * TAU / 4 + 0.78; cyl(0.08, 0.1, 1.1, m, Math.cos(a) * (r - 0.9), 0.55, Math.sin(a) * (r - 0.9), g, 5); }
    }
    g.userData.plot = { ring, fill, prog };
    g.userData.height = 0.5;
    return g;
  }
  function refreshPlotMesh(p) {
    const u = p.mesh?.userData?.plot; if (!u) return;
    const own = p.owner >= 0 ? world.colors[p.owner] ?? 0xffffff : RES_COLOR[p.res];
    const key = `${p.owner}|${p.claiming}|${Math.round((p.claimT / (p.claimTotal || 1)) * 40)}|${p.contested ? 1 : 0}`;
    if (key === p._vk) return; p._vk = key;
    u.ring.material.color.setHex(own); u.ring.material.opacity = p.owner >= 0 ? 0.95 : 0.7;
    u.fill.material.color.setHex(own); u.fill.material.opacity = p.owner >= 0 ? 0.2 : 0.1;
    if (p.claiming >= 0) {
      const f = Math.max(0.05, Math.min(1, p.claimT / (p.claimTotal || 1)));
      u.prog.visible = true; u.prog.scale.set(f, f, f); u.prog.material.color.setHex(world.colors[p.claiming] ?? 0xffffff);
      u.prog.material.opacity = p.contested ? 0.15 : 0.4;
    } else u.prog.visible = false;
  }

  // Extractor meshes: one procedural model per faction x resource. Parts that animate go to userData.spin.
  function buildExtractorMesh(e) {
    const g = new THREE.Group(), f = e.faction || fac(e.team), tc = world.colors[e.team] ?? 0xcccccc;
    const T_ = mat(tc, { metal: 0.3, rough: 0.6 }), spin = [];
    const metal = mat(0x7b7f86, { metal: 0.6, rough: 0.45 }), dark = mat(0x2d2a28, { rough: 0.9 });
    const body = new THREE.Group(); g.add(body);
    let height = 4;
    if (e.res === 'aether') {
      // tripod drill over the crystal field with a glowing cyan core
      for (let i = 0; i < 3; i++) { const a = i * TAU / 3; const leg = cyl(0.14, 0.18, 5.2, metal, Math.cos(a) * 1.3, 2.4, Math.sin(a) * 1.3, body, 6); leg.rotation.z = Math.cos(a) * 0.28; leg.rotation.x = -Math.sin(a) * 0.28; }
      box(1.6, 0.8, 1.6, T_, 0, 4.9, 0, body);
      const core = cyl(0.35, 0.35, 3.6, mat(0x39d8ff, { emissive: 0x1aa0cc, ei: 1.6 }), 0, 2.2, 0, body, 8); spin.push({ o: core, ax: 'y', s: 2 });
      height = 5.6;
    } else if (f === 'vanguard' && e.res === 'primary') {   // Ore Mine: headframe + winding wheel + ore pile
      for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) cyl(0.12, 0.12, 5, metal, x * 0.9, 2.5, z * 0.9, body, 6);
      box(2.2, 0.3, 2.2, T_, 0, 5, 0, body);
      const wheel = part(geo('vgwheel', () => new THREE.TorusGeometry(0.9, 0.12, 6, 16)), metal, 0, 5.8, 0, body); spin.push({ o: wheel, ax: 'z', s: 1.5 });
      rock(1.0, mat(0x5a524c, { flat: true }), 1.9, 0.5, 0.6, body); rock(0.7, mat(0x5a524c, { flat: true }), 1.6, 0.4, -0.9, body);
      box(1.6, 1.2, 1.6, dark, 0, 0.6, 0, body); height = 6.6;
    } else if (f === 'vanguard') {                          // Oil Derrick: pumpjack
      box(3.2, 0.4, 1.2, dark, 0, 0.2, 0, body);
      cyl(0.15, 0.2, 2.4, metal, 0, 1.4, 0, body, 6);
      const beam = new THREE.Group(); beam.position.set(0, 2.6, 0); body.add(beam);
      box(3.6, 0.35, 0.35, T_, 0, 0, 0, beam); box(0.5, 1.0, 0.6, metal, 1.8, -0.4, 0, beam);
      spin.push({ o: beam, ax: 'z', s: 1.6, rock: 0.3 });
      cyl(0.5, 0.5, 1.2, mat(0x3a3836, { metal: 0.4 }), -1.6, 0.6, 0.9, body, 10); height = 3.4;
    } else if (f === 'volcanic' && e.res === 'primary') {   // Ore Cutter: basalt drill with glowing slit
      cyl(1.3, 1.6, 1.4, mat(0x2a2422, { flat: true }), 0, 0.7, 0, body, 7);
      const drill = cyl(0.1, 0.9, 2.6, mat(0x4a403a, { metal: 0.4, flat: true }), 0, 2.8, 0, body, 6); drill.rotation.x = Math.PI; spin.push({ o: drill, ax: 'y', s: 3 });
      box(2.8, 0.25, 0.4, mat(0xff5a12, { emissive: 0xff3a00, ei: 1.4 }), 0, 1.0, 1.2, body);
      box(0.6, 3.0, 0.6, T_, 1.2, 1.5, -0.8, body); height = 4.2;
    } else if (f === 'volcanic') {                          // Vent Tap: pipe over a glowing pressure vent
      cyl(1.4, 1.6, 0.3, mat(0xff5a12, { emissive: 0xff3a00, ei: 1.2 }), 0, 0.15, 0, body, 12);
      cyl(0.45, 0.55, 3.2, metal, 0, 1.8, 0, body, 8); box(1.6, 0.4, 0.4, T_, 0.6, 3.2, 0, body);
      const puff = sph(0.8, mat(0xcfc6c0, { rough: 1 }), 0, 4.1, 0, body); g.userData.puff = puff; height = 4.4;
    } else if (f === 'earth') {                             // Solar Grove / Turbine Tree: grow in stages
      const bark = mat(0x6a4a2e, { rough: 0.95 }), leaf = mat(0x4f9a3a, { flat: true });
      cyl(0.35, 0.55, 3.6, bark, 0, 1.8, 0, body, 7);
      sph(1.5, leaf, 0, 3.8, 0, body);
      if (e.res === 'primary') {
        const disc = cyl(1.3, 1.3, 0.12, mat(0xffd56a, { emissive: 0xffb340, ei: 1.1, metal: 0.6 }), 0, 4.6, 0.9, body, 18);
        disc.rotation.x = Math.PI / 2 - 0.4; spin.push({ o: disc, ax: 'y', s: 0.4 });
      } else {
        const rotor = new THREE.Group(); rotor.position.set(0, 4.2, 1.1); body.add(rotor);
        for (let i = 0; i < 3; i++) { const b = box(0.3, 2.2, 0.08, mat(0x9adf7a, { flat: true }), 0, 1.0, 0, null); const piv = new THREE.Group(); piv.rotation.z = i * TAU / 3; piv.add(b); rotor.add(piv); }
        spin.push({ o: rotor, ax: 'z', s: 2.2 });
      }
      box(0.5, 0.5, 0.5, T_, 0.9, 0.25, 0.6, body);
      height = 5.4; g.userData.stageBody = body;
    } else if (f === 'storm' && e.res === 'primary') {      // Lightning Rod
      cyl(0.9, 1.1, 0.6, mat(0x8a7a5a), 0, 0.3, 0, body, 8);
      cyl(0.07, 0.12, 7, metal, 0, 3.8, 0, body, 6);
      const orb = sph(0.45, mat(0x9fe4ff, { emissive: 0x6fc8ff, ei: 1.2 }), 0, 7.4, 0, body); g.userData.orb = orb;
      for (let i = 0; i < 3; i++) { const r2 = part(geo('strg', () => new THREE.TorusGeometry(0.5, 0.05, 5, 14)), T_, 0, 2.5 + i * 1.4, 0, body); r2.rotation.x = Math.PI / 2; }
      height = 7.8;
    } else {                                                // Dew Trap: condenser dome + mesh fins
      const dome = part(geo('dew', () => new THREE.SphereGeometry(1.4, 14, 8, 0, TAU, 0, Math.PI / 2)), mat(0xb8d8f0, { metal: 0.3, rough: 0.3 }), 0, 0, 0, body);
      for (let i = 0; i < 4; i++) { const a = i * TAU / 4; const fin = box(0.08, 2.4, 1.4, mat(0xd8d0b8), Math.cos(a) * 1.9, 1.2, Math.sin(a) * 1.9, body); fin.rotation.y = -a; }
      cyl(0.5, 0.5, 0.6, T_, 0, 1.6, 0, body, 8); void dome; height = 2.6;
    }
    g.userData.spin = spin; g.userData.body = body; g.userData.height = height;
    return g;
  }
  function buildProcessorMesh(e) {
    const g = new THREE.Group(), f = e.faction || fac(e.team), tc = world.colors[e.team] ?? 0xcccccc, T_ = mat(tc, { metal: 0.3, rough: 0.6 });
    const body = new THREE.Group(); g.add(body);
    const base = { vanguard: 0x5a5c60, volcanic: 0x2e2624, earth: 0x8a6a4a, storm: 0xb8a070 }[f] ?? 0x666666;
    const B = mat(base, { rough: 0.85, flat: f === 'volcanic' });
    box(6.4, 3.2, 5.2, B, 0, 1.6, 0, body);
    box(6.6, 0.4, 5.4, T_, 0, 3.3, 0, body);
    const glowC = { vanguard: 0xff8a30, volcanic: 0xff4a10, earth: 0xffd56a, storm: 0x9fe4ff }[f] ?? 0x39d8ff;
    box(2.2, 1.2, 0.1, mat(glowC, { emissive: glowC, ei: 1.4 }), 0, 1.4, 2.65, body);
    if (f === 'vanguard') { cyl(0.5, 0.6, 5, mat(0x3a3836, { metal: 0.4 }), -2.2, 5.5, -1.4, body); cyl(0.5, 0.6, 4, mat(0x3a3836, { metal: 0.4 }), -1, 5, -1.4, body); }
    else if (f === 'volcanic') { cyl(1.4, 2.0, 2.4, B, 1.4, 4.6, -0.6, body, 7); cyl(1.0, 1.0, 0.2, mat(0xff5a12, { emissive: 0xff3a00, ei: 1.5 }), 1.4, 5.85, -0.6, body, 10); }
    else if (f === 'earth') { const d = cyl(2.0, 2.0, 0.2, mat(0xffd56a, { emissive: 0xffb340, ei: 1.0, metal: 0.6 }), 0, 6, 0, body, 24); d.rotation.x = Math.PI / 2; g.userData.spin = [{ o: d, ax: 'z', s: 0.3 }]; cyl(0.3, 0.4, 2.6, B, 0, 4.6, 0, body); }
    else { for (const x of [-2, 0, 2]) { cyl(0.6, 0.6, 2.2, mat(0x8fb8d8, { metal: 0.6, rough: 0.3 }), x, 4.4, -1, body, 10); sph(0.3, mat(0x9fe4ff, { emissive: 0x6fc8ff, ei: 1.3 }), x, 5.7, -1, body); } }
    g.userData.spin = g.userData.spin || []; g.userData.body = body; g.userData.height = 6.5;
    return g;
  }
  function buildHousingMesh(e) {
    const g = new THREE.Group(), tc = world.colors[e.team] ?? 0xcccccc;
    const body = new THREE.Group(); g.add(body);
    const wall = mat({ vanguard: 0x7a7670, volcanic: 0x3a302c, earth: 0x9a7a52, storm: 0xd8c8a0 }[e.faction || fac(e.team)] ?? 0x888888);
    const roof = mat(tc, { rough: 0.7 });
    for (const [x, z] of [[-1.3, 0], [1.3, 0.3]]) {
      box(2.2, 1.8, 2.6, wall, x, 0.9, z, body);
      const r = part(geo('hroof', () => new THREE.ConeGeometry(1.9, 1.1, 4)), roof, x, 2.35, z, body); r.rotation.y = Math.PI / 4;
    }
    g.userData.spin = []; g.userData.body = body; g.userData.height = 3;
    return g;
  }
  function dressMesh(e) {
    if (!THREE || !e.mesh) return;
    let m = null;
    try { m = world.econModel?.(e.kind, e) || null; } catch (err) { console.warn('[econ] econModel failed', err?.message); }
    if (!m) {
      if (e.kind === 'plot') m = buildPlotMesh(e);
      else if (e.kind === 'extractor') m = buildExtractorMesh(e);
      else if (e.kind === 'processor') m = buildProcessorMesh(e);
      else if (e.kind === 'housing') m = buildHousingMesh(e);
    }
    if (!m) return;
    // e.mesh is the placeholder group sim already placed in the scene: adopt the built children + userData.
    while (m.children.length) e.mesh.add(m.children[0]);
    Object.assign(e.mesh.userData, m.userData, { entity: e, kind: e.kind });
    if (e.kind !== 'plot') e.mesh.rotation.y = e.rot = Math.random() * TAU;
  }
  // Cheap placeholder for our kinds so the engine doesn't build a default box first.
  const origMake = world.makeMesh;
  if (origMake && !origMake.__econ && THREE) {
    const wrapped = (kind, team) => ECON_KINDS.has(kind) ? Object.assign(new THREE.Group(), { userData: { kind } }) : origMake(kind, team);
    wrapped.__econ = true; world.makeMesh = wrapped;
  }

  // ---------------------------------------------------------------- plots
  const plots = [];
  const extractors = [];
  const processors = [];
  const hw = (world.map?.w ?? 160) / 2, hh = (world.map?.h ?? 100) / 2;
  function plotSpot(x, z, r) {
    const clampP = (x, z) => ({ x: Math.max(-hw + r + 2, Math.min(hw - r - 2, x)), z: Math.max(-hh + r + 2, Math.min(hh - r - 2, z)) });
    let p = clampP(x, z);
    const free = (x, z) => H.spotFree(x, z, r) && !plots.some(q => Math.hypot(q.x - x, q.z - z) < q.r + r + 2);
    if (free(p.x, p.z)) return p;
    for (let ring = 1; ring <= 10; ring++) for (let k = 0; k < 10; k++) {
      const a = k / 10 * TAU + ring, q = clampP(p.x + Math.cos(a) * ring * 2, p.z + Math.sin(a) * ring * 2);
      if (free(q.x, q.z)) return q;
    }
    return null;
  }
  function makePlot(x, z, resKind, opts = {}) {
    const r = opts.r ?? E.plotR;
    const at = opts.exact ? { x, z } : plotSpot(x, z, r);
    if (!at) return null;
    const p = H.spawn('plot', -1, at.x, at.z, {
      cls: 'neutral', team: -1, untargetable: true, noBlock: true, noSight: true, r, hp: 1, hpMax: 1,
      isPlot: true, res: resKind, owner: -1, claiming: -1, claimT: 0, claimTotal: 0, ext: null, contested: false,
      home: opts.home ?? -1, rich: !!opts.rich, amount: opts.amount ?? Infinity, crystals: opts.crystals || [],
    });
    p.hpMax = 0;   // no health bar
    p.amount0 = p.amount;
    p.rot = 0; if (p.mesh) p.mesh.rotation.y = 0;
    for (const c of p.crystals) c.plot = p;
    dressMesh(p); refreshPlotMesh(p);
    plots.push(p);
    return p;
  }
  const plotOf = (e) => !e ? null : e.isPlot ? e : e.plot || null;

  function extSpec(team, resKind) {
    const b = E.extractor[resKind] || E.extractor.primary, m = mods(team);
    let time = b.time * (m.buildTime || 1);
    if (m.stages) time *= m.growTime || 1;
    return { cost: b.cost, time, rate: b.rate, cap: b.cap ?? 0, hp: Math.round(b.hp * (m.hp || 1)), r: b.r, stages: m.stages || 1 };
  }
  function adjacent(team, p) {
    const adj = E.claim.adj;
    for (const e of ents) {
      if (e.team !== team || e.isUnit || e.state === 'dead' || e.cls !== 'bld' || e.trap || e.untargetable) continue;
      if (Math.hypot(e.x - p.x, e.z - p.z) - (e.r || 0) - p.r <= adj) return true;
    }
    for (const q of plots) if (q.owner === team && q !== p && Math.hypot(q.x - p.x, q.z - p.z) - q.r - p.r <= adj) return true;
    return false;
  }
  const claimCost = (p) => ({ primary: 0, secondary: p.res === 'aether' ? E.claim.aetherSecondary : E.claim.secondary });
  function canClaim(team, p) {
    p = plotOf(p);
    if (!p) return { ok: false, reason: 'No plot' };
    if (p.owner >= 0) return { ok: false, reason: p.owner === team ? 'Already yours' : `Held by ${teamName(p.owner)}` };
    if (p.claiming >= 0) return { ok: false, reason: p.claiming === team ? 'Claiming…' : `${teamName(p.claiming)} is claiming` };
    if (p.amount <= 0) return { ok: false, reason: 'Depleted' };
    if (!adjacent(team, p)) return { ok: false, reason: `Too far: must be within ${E.claim.adj}u of your land` };
    if (!canAfford(team, claimCost(p))) return { ok: false, reason: `Need ${claimCost(p).secondary} ${names(team).secondary}` };
    return { ok: true };
  }
  function claim(team, p, cat = 'expand') {
    p = plotOf(p);
    const ck = canClaim(team, p);
    if (!ck.ok) { if (team === 0) H.message(ck.reason); return ck; }
    spend(team, claimCost(p), cat);
    p.claiming = team; p.claimT = 0; p.claimTotal = E.claim.time * (mods(team).claimTime || 1); p.contested = false;
    H.emit('claim', { plot: p, team });
    refreshPlotMesh(p);
    return { ok: true };
  }
  function canBuildExtractor(team, p) {
    p = plotOf(p);
    if (!p) return { ok: false, reason: 'No plot' };
    if (p.owner !== team) return { ok: false, reason: 'Claim the land first' };
    if (live(p.ext)) return { ok: false, reason: 'Already built' };
    const s = extSpec(team, p.res);
    if (!canAfford(team, { primary: s.cost })) return { ok: false, reason: `Need ${s.cost} ${names(team).primary}` };
    return { ok: true };
  }
  function spawnExtractor(team, p) {
    const s = extSpec(team, p.res);
    const e = H.spawn('extractor', team, p.x, p.z, {
      cls: 'bld', hp: s.hp, hpMax: s.hp, r: s.r, extractor: true, plot: p, res: p.res, built: false, buildT: 0, buildTotal: s.time,
      stage: 0, stages: s.stages, stock: 0, cap: s.cap, rate: s.rate, rateEff: 0, pulseT: 0, faction: fac(team),
      name: names(team).ext[p.res],
    });
    p.ext = e;
    extractors.push(e);
    dressMesh(e);
    setBuildVisual(e, 0);
    return e;
  }
  function buildExtractor(team, p, cat = 'other') {
    p = plotOf(p);
    const ck = canBuildExtractor(team, p);
    if (!ck.ok) { if (team === 0) H.message(ck.reason); return ck; }
    spend(team, { primary: extSpec(team, p.res).cost }, cat);
    const e = spawnExtractor(team, p);
    H.emit('extractor', { entity: e, plot: p, team });
    return { ok: true, entity: e };
  }
  function finishInstant(e) { e.built = true; e.buildT = e.buildTotal; e.stage = e.stages; setBuildVisual(e, 1); }

  // construction visuals: non-Earth rigs rise from the ground; Earth trees step through 3 sizes (entity.stage)
  function setBuildVisual(e, prog) {
    const b = e.mesh?.userData?.body; if (!b) return;
    if (e.stages > 1) { const s = [0.35, 0.35, 0.65, 1][e.stage] ?? 1; b.scale.set(s, s, s); }
    else { const s = 0.25 + 0.75 * Math.min(1, prog); b.scale.set(1, s, 1); }
  }

  // ---------------------------------------------------------------- buildings (processor / housing)
  function build(team, kind, x, z, opts = {}) {
    const c = E.costs[kind];
    if (!c || (kind !== 'processor' && kind !== 'housing')) return { ok: false, reason: 'Unknown building' };
    const r = c.r ?? 3;
    if (!opts.free && !H.spotFree(x, z, r)) return { ok: false, reason: 'Blocked' };
    if (!opts.free && !spend(team, c, opts.cat || 'other')) return { ok: false, reason: 'Not enough resources' };
    const e = H.spawn(kind, team, x, z, {
      cls: 'bld', hp: c.hp, hpMax: c.hp, r, faction: fac(team), constructing: !opts.instant, buildT: 0, buildTotal: c.time || 20,
      processor: kind === 'processor', aetherMode: 'primary', name: kind === 'processor' ? names(team).processor : 'Housing',
    });
    dressMesh(e);
    if (kind === 'processor') processors.push(e);
    if (e.constructing) setBuildVisual(e, 0); else H.emit('built', { entity: e });
    return { ok: true, entity: e };
  }
  function nearestProcessor(team, from) {
    let best = null, bd = Infinity;
    for (const p of processors) {
      if (p.team !== team || !live(p) || p.constructing) continue;
      const d = dist(p, from); if (d < bd) { bd = d; best = p; }
    }
    if (best) return { p: best, mul: 1 };
    const cc = H.hq[team];
    return live(cc) ? { p: cc, mul: E.harvester.ccFallbackMul } : null;
  }
  function setAetherMode(proc, mode) {
    if (!proc?.processor || (mode !== 'primary' && mode !== 'secondary')) return false;
    for (const p of processors) if (p.team === proc.team) p.aetherMode = mode;   // team-wide toggle (any processor)
    return true;
  }
  const aetherMode = (team) => processors.find(p => p.team === team && live(p))?.aetherMode || 'primary';

  // ---------------------------------------------------------------- setup (called by sim after bases exist)
  function setup(bases, centerFields) {
    const L = E.layout;
    const quad = C.teams.quad;
    for (let t = 0; t < NT; t++) {
      const b = bases[t]; if (!b?.cc) continue;
      const cc = b.cc, d = H.toCenter(cc.x, cc.z), v = { x: -d.z, z: d.x };
      // the base crystal field becomes this base's Aether plot (home-only until it is claimed)
      const fieldAmt = (b.fieldEnts || []).reduce((s, c) => s + (c.amount || 0), 0);
      makePlot(b.field.x, b.field.z, 'aether', { r: b.field.r + 0.6, exact: true, home: t, amount: fieldAmt, crystals: b.fieldEnts || [] });
      for (const s of L.base) {
        const a = s.a * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
        const dx = d.x * ca + v.x * sa, dz = d.z * ca + v.z * sa;
        const p = makePlot(cc.x + dx * s.r, cc.z + dz * s.r, s.res, { home: t });
        if (p && s.start) { p.owner = t; refreshPlotMesh(p); finishInstant(spawnExtractor(t, p)); }
      }
      // starting processor: beside the cc, on the side away from the field lane
      const [qx, qz] = quad[t];
      const pp = H.nudgeFree(cc.x + qx * 11, cc.z - qz * 11, E.costs.processor.r);
      build(t, 'processor', pp.x, pp.z, { free: true, instant: true });
      // frontier / mid plots (mirrored into this team's quadrant)
      for (const f of L.frontier) makePlot(qx * f.fx * hw, qz * f.fz * hh, f.res, {});
    }
    for (const cf of centerFields) {
      const amt = cf.ents.reduce((s, c) => s + (c.amount || 0), 0);
      makePlot(cf.x, cf.z, 'aether', { r: cf.r + 0.6, exact: true, rich: true, amount: amt * (C.economy.richMul || 1), crystals: cf.ents });
    }
    computeCaps();
  }

  // ---------------------------------------------------------------- per-step update
  const qNear = [];
  let contestT = 0;
  function weatherMul(t) {
    const m = mods(t);
    if (!m.weatherPeriod) return 1;
    const w = 1 + m.weatherAmp * Math.sin(TAU * T() / m.weatherPeriod);
    return w + (world.weather?.storm || weather.storm ? m.stormBonus : 0);
  }
  const weather = { storm: false };
  function update(dt) {
    tickIncome();
    computeCaps();
    weather.storm = Math.sin(TAU * T() / 150) > 0.8;
    // claims
    contestT -= dt;
    const doContest = contestT <= 0; if (doContest) contestT = 0.5;
    for (const p of plots) {
      if (p.claiming < 0) continue;
      if (doContest) {
        p.contested = false;
        for (const o of H.near(p.x, p.z, p.r + 8, qNear)) {
          if (o.isUnit && o.team >= 0 && o.team !== p.claiming && o.dps > 0 && o.state !== 'dead' && Math.hypot(o.x - p.x, o.z - p.z) < p.r + 8) { p.contested = true; break; }
        }
      }
      if (!p.contested) p.claimT += dt;
      if (!live(H.hq[p.claiming])) { p.claiming = -1; p.claimT = 0; }
      else if (p.claimT >= p.claimTotal) {
        p.owner = p.claiming; p.claiming = -1; p.claimT = 0;
        H.emit('claimed', { plot: p, team: p.owner });
        if (p.owner === 0) H.message('Land claimed', 1500);
      }
      refreshPlotMesh(p);
    }
    // extractors
    for (let i = extractors.length - 1; i >= 0; i--) {
      const e = extractors[i];
      if (!live(e)) { extractors.splice(i, 1); continue; }
      if (!e.built) {
        e.buildT += dt;
        const pr = Math.min(1, e.buildT / e.buildTotal);
        const st = e.stages > 1 ? Math.min(e.stages, 1 + Math.floor(pr * e.stages)) : 0;
        if (pr >= 1) { e.built = true; e.stage = e.stages; H.emit('built', { entity: e }); if (e.team === 0) H.message(`${e.name} ready`, 1500); }
        else if (st !== e.stage) e.stage = st;
        setBuildVisual(e, pr);
      }
      // output multiplier: Earth produces at 50% from stage 2 while still growing
      let sm = e.built ? 1 : 0;
      if (e.stages > 1 && !e.built && e.stage >= 2) sm = mods(e.team).stage2Out ?? 0.5;
      if (!sm) { e.rateEff = 0; continue; }
      let r = e.rate * sm * (e.team > 0 ? E.aiIncomeMul : 1);
      if (e.res === 'primary') r *= weatherMul(e.team);
      const p = e.plot;
      if (e.res === 'aether' && p) { if (!(p.amount > 0)) { e.rateEff = 0; e.depleted = true; continue; } }
      e.rateEff = r;
      const out = r * dt;
      if (e.res === 'secondary') {
        const pulse = mods(e.team).pulse;
        if (pulse) { e.stock += out; e.pulseT += dt; if (e.pulseT >= pulse) { add(e.team, 'secondary', e.stock); H.emit('pulse', { entity: e, amount: e.stock }); e.stock = 0; e.pulseT = 0; } }
        else add(e.team, 'secondary', out);
      } else {
        if (e.stock >= e.cap) { e.full = true; continue; }
        e.full = false;
        let o = Math.min(out, e.cap - e.stock);
        if (e.res === 'aether' && p) {
          o = Math.min(o, p.amount); p.amount -= o;
          // the visible crystals shrink away as the field is drained
          if (p.crystals.length) {
            const left = p.crystals.filter(live), keep = Math.ceil(p.amount / p.amount0 * p.crystals.length);
            if (left.length > keep) { const c = left[left.length - 1]; c.depleted = true; H.kill(c); }
          }
        }
        e.stock += o;
      }
    }
    // buildings under construction
    for (const e of ents) {
      if (!e.constructing || e.state === 'dead') continue;
      e.buildT += dt;
      const pr = Math.min(1, e.buildT / e.buildTotal);
      setBuildVisual(e, pr);
      if (pr >= 1) { e.constructing = false; H.emit('built', { entity: e }); if (e.team === 0) H.message(`${e.name} ready`, 1500); }
    }
    crewTick(dt);
  }
  // per-frame cosmetic animation (spinning wheels, pumpjacks, vent puffs, rod glow)
  function animate(dt) {
    const t = T();
    for (const e of extractors) {
      const u = e.mesh?.userData; if (!u || !live(e)) continue;
      const on = e.rateEff > 0 && !e.full;
      for (const s of u.spin || []) {
        if (!on) continue;
        if (s.rock) s.o.rotation[s.ax] = Math.sin(t * s.s) * s.rock; else s.o.rotation[s.ax] += s.s * dt;
      }
      if (u.puff) { const k = e.pulseT ? 0.4 + 0.9 * (e.pulseT / (mods(e.team).pulse || 12)) : 0.6; u.puff.scale.setScalar(k); }
      if (u.orb) u.orb.scale.setScalar(1 + 0.35 * Math.max(0, weatherMul(e.team) - 1));
    }
    for (const p of processors) { const u = p.mesh?.userData; if (u && live(p)) for (const s of u.spin || []) s.o.rotation[s.ax] += s.s * dt; }
  }
  function onDeath(e) {
    if (e.crew > 0) releaseCrew(e);
    if (e.extractor && e.plot) {
      const p = e.plot;
      if (p.ext === e) p.ext = null;
      const was = p.owner;
      p.owner = -1; p.claiming = -1; p.claimT = 0;
      refreshPlotMesh(p);
      H.emit('razed', { plot: p, team: was, entity: e });
      if (was === 0) H.message(`${e.name} destroyed: land lost`, 2500);
    }
  }

  // ---------------------------------------------------------------- harvesters
  const carryOf = (e) => H.unitDef(e.kind)?.carry ?? E.harvester.carry;
  function pickJob(e) {
    let best = null, bs = -Infinity;
    const cap = carryOf(e), spd = Math.max(1, e.speed || 6);
    for (const x of extractors) {
      if (x.team !== e.team || !live(x) || x.res === 'secondary') continue;
      if (!(x.rateEff > 0) && x.stock < 1) continue;
      let assigned = 0;
      for (const h of H.units()) if (h !== e && h.harv && h.job === x && h.team === e.team) assigned++;
      const d = dist(e, x);
      const expected = x.stock + x.rateEff * (d / spd) - assigned * cap;
      const s = Math.min(expected, cap) - d * 0.35 - assigned * 25;
      if (s > bs) { bs = s; best = x; }
    }
    return best;
  }
  // Progress watchdog: a hauler that hasn't closed 1u on its goal in 4s sidesteps (and may ghost own structures).
  function travel(e, g, dt) {
    const d = dist(e, g);
    const w = e._hw || (e._hw = { g: null, d: 0, t: 0 });
    if (w.g !== g || d < w.d - 1) { w.g = g; w.d = d; w.t = 0; }
    else if ((w.t += dt) > 4) { w.t = 0; w.d = d; e.detour = 1.5; e.detourSide = Math.random() < 0.5 ? -1 : 1; e.ghost = 1.5; e._nav = null; }
    H.nav(e, g.x, g.z, dt, g);
  }
  function updateHarvester(e, dt) {
    const HV = E.harvester;
    if (e.state === 'move') return H.updateMover(e, dt);
    if (e.state === 'idle' || e.state === 'attack') {
      if (e.state === 'attack') e.state = 'idle';
      e.idleT += dt;
      if (e.manual && e.idleT < C.economy.idleHarvesterRestart) return;
      e.manual = false;
      if (e.carry > 0) { e.state = 'return'; e.harvT = 0; return; }
      if (e.idleT < 1 && e._jobTry) return;          // don't re-score every substep while there's nothing to do
      e._jobTry = true; e.idleT = 0;
      const j = pickJob(e);
      if (!j) return;
      e.job = j; e.state = 'gather'; e.harvT = 0; e._jobTry = false;
    }
    if (e.state === 'gather') {
      const j = e.job;
      if (!live(j) || j.team !== e.team) { e.job = null; e.state = 'idle'; e.idleT = 99; e._jobTry = false; return; }
      const reach = j.r + e.r + 1.5;
      if (dist(e, j) > reach) { travel(e, j, dt); e.harvT = 0; return; }
      e.harvT += dt;
      const cap = carryOf(e);
      const take = Math.min(cap / HV.load * dt, j.stock, cap - e.carry);
      if (take > 0) { j.stock -= take; e.carry += take; e.carryKind = j.res === 'aether' ? 'aether' : 'primary'; }
      if (e.carry >= cap - 0.01 || (e.harvT >= HV.load && j.stock < 0.5 && e.carry >= HV.minLoad) || (e.harvT > HV.load + 15 && e.carry > 0)) {
        e.state = 'return'; e.harvT = 0;
      } else if (e.harvT > HV.load + 15 && e.carry <= 0) { e.state = 'idle'; e.idleT = 99; e._jobTry = false; }
    } else if (e.state === 'return') {
      const np = nearestProcessor(e.team, e);
      if (!np) { e.state = 'idle'; return; }
      const p = np.p, reach = p.r + e.r + 1.5;
      if (dist(e, p) > reach) { travel(e, p, dt); e.harvT = 0; return; }
      e.harvT += dt;
      if (e.harvT >= HV.deposit) {
        let kind = 'primary', amt = e.carry * np.mul;
        if (e.carryKind === 'aether') { kind = p.processor ? p.aetherMode || 'primary' : 'primary'; amt *= E.aetherMul[kind] ?? 1; }
        add(e.team, kind, amt);
        H.emit('deposit', { team: e.team, kind, amount: amt, raw: e.carry, harvester: e, at: p, aether: e.carryKind === 'aether' });
        e.carry = 0; e.harvT = 0; e.carryKind = null;
        if (live(e.job) && e.job.rateEff > 0 && e.job.stock > carryOf(e) * 0.5) e.state = 'gather';
        else { e.state = 'idle'; e.idleT = 99; e._jobTry = false; }
      }
    }
  }
  function assignHarvester(h, ext) {
    if (!h?.harv || !live(ext) || !ext.extractor || ext.team !== h.team || ext.res === 'secondary') return false;
    h.manual = false; h.job = ext; h.state = h.carry > 0 && h.carryKind !== (ext.res === 'aether' ? 'aether' : 'primary') ? 'return' : 'gather';
    h.dest = null; h.harvT = 0;
    return true;
  }

  // ---------------------------------------------------------------- player plot sheet actions
  function plotActions(ent, team = 0) {
    const out = [];
    if (!ent) return out;
    const N = names(team);
    const fmt = (c) => [c.primary ? `${Math.ceil(c.primary)} ${N.primary}` : '', c.secondary ? `${Math.ceil(c.secondary)} ${N.secondary}` : ''].filter(Boolean).join(' + ');
    if (ent.processor && ent.team === team) {
      const mode = ent.aetherMode || 'primary';
      for (const k of ['primary', 'secondary']) out.push({ id: 'aether_' + k, label: `Aether → ${N[k]} ×${E.aetherMul[k]}`, cost: null, enabled: mode !== k, active: mode === k, run: () => ({ ok: setAetherMode(ent, k) }) });
      if (ent.constructing) out.unshift({ id: 'info', label: `Building ${Math.floor(100 * ent.buildT / ent.buildTotal)}%`, enabled: false, info: true });
      return out;
    }
    const p = plotOf(ent);
    if (!p) return out;
    const word = (PLOT_WORDS[fac(team)] || PLOT_WORDS.vanguard)[p.res];
    if (p.owner < 0) {
      if (p.claiming === team) out.push({ id: 'info', label: `Claiming… ${Math.floor(100 * p.claimT / (p.claimTotal || 1))}%${p.contested ? ' (contested)' : ''}`, enabled: false, info: true });
      else if (p.claiming >= 0) out.push({ id: 'info', label: `${teamName(p.claiming)} is claiming`, enabled: false, info: true });
      else {
        const c = claimCost(p), ck = canClaim(team, p);
        out.push({ id: 'claim', label: `Claim ${word}`, cost: c, costText: fmt(c), enabled: ck.ok, reason: ck.ok ? '' : ck.reason, run: () => claim(team, p) });
      }
      if (p.res === 'aether' && Number.isFinite(p.amount)) out.push({ id: 'info2', label: `${Math.floor(p.amount)} raw Aether left`, enabled: false, info: true });
      return out;
    }
    if (p.owner !== team) { out.push({ id: 'info', label: `Held by ${teamName(p.owner)}`, enabled: false, info: true }); return out; }
    const x = p.ext;
    if (!live(x)) {
      const s = extSpec(team, p.res), ck = canBuildExtractor(team, p);
      out.push({ id: 'extract', label: `${fac(team) === 'earth' ? 'Plant' : 'Build'} ${N.ext[p.res]}`, cost: { primary: s.cost, secondary: 0 }, costText: `${fmt({ primary: s.cost })} · ${Math.round(s.time)}s`, enabled: ck.ok, reason: ck.ok ? '' : ck.reason, run: () => buildExtractor(team, p) });
      return out;
    }
    if (!x.built) out.push({ id: 'info', label: x.stages > 1 ? `Growing: stage ${x.stage}/${x.stages}` : `Building ${Math.floor(100 * x.buildT / x.buildTotal)}%`, enabled: false, info: true });
    const perMin = Math.round(x.rateEff * 60 * (x.res === 'aether' ? E.aetherMul[aetherMode(team)] : 1));
    const unit = x.res === 'aether' ? N[aetherMode(team)] : N[x.res];
    if (x.res === 'secondary') out.push({ id: 'stock', label: `+${perMin} ${unit}/min${x.pulseT ? ` · pulse ${Math.floor(x.stock)}` : ' (direct)'}`, enabled: false, info: true });
    else {
      out.push({ id: 'stock', label: `Stock ${Math.floor(x.stock)}/${x.cap}${x.full ? ' FULL' : ''} · +${perMin} ${unit}/min`, enabled: false, info: true });
      const hs = H.units().filter(h => h.team === team && h.harv && h.state !== 'dead');
      const on = hs.filter(h => h.job === x).length;
      out.push({ id: 'haul', label: `Send hauler (${on} on it)`, enabled: hs.length > 0, reason: hs.length ? '' : 'No harvesters', run: () => {
        const free = hs.filter(h => h.job !== x).sort((a, b) => (a.carry - b.carry) || (dist(a, x) - dist(b, x)))[0];
        return { ok: !!free && assignHarvester(free, x) };
      } });
    }
    if (x.res === 'aether') for (const k of ['primary', 'secondary']) {
      const pr = processors.find(q => q.team === team && live(q));
      if (pr) out.push({ id: 'aether_' + k, label: `Convert → ${N[k]} ×${E.aetherMul[k]}`, enabled: aetherMode(team) !== k, active: aetherMode(team) === k, run: () => ({ ok: setAetherMode(pr, k) }) });
    }
    return out;
  }
  function plotTitle(ent, team = 0) {
    if (ent?.processor) return ent.name || names(ent.team).processor;
    if (ent?.kind === 'housing') return 'Housing (+8 supply)';
    const p = plotOf(ent); if (!p) return '';
    if (live(p.ext)) return p.ext.name;
    return (PLOT_WORDS[fac(team)] || PLOT_WORDS.vanguard)[p.res] + (p.rich ? ' (rich)' : '');
  }

  // ---------------------------------------------------------------- AI economy
  const AIS = [];
  for (let t = 1; t < NT; t++) AIS[t] = { think: 0.5 + t * 0.37, procs: 0 };
  function claimables(team) { return plots.filter(p => p.owner < 0 && p.claiming < 0 && (p.amount > 0) && (p.home < 0 || p.home === team) && adjacent(team, p)); }
  function danger(team, p) {
    let n = 0;
    for (const o of H.near(p.x, p.z, 26, qNear)) if (o.isUnit && o.team >= 0 && o.team !== team && o.dps > 0 && o.state !== 'dead') n++;
    return n;
  }
  function tripTime(team, x, spd) {
    const np = nearestProcessor(team, x);
    const d = np ? dist(np.p, x) : 60;
    return 2 * d / spd + E.harvester.load + E.harvester.deposit + 4;
  }
  function aiWantHarvesters(team) {
    const hk = H.harvKindFor(team), spd = H.unitDef(hk)?.speed || 6.4, cap = H.unitDef(hk)?.carry ?? E.harvester.carry;
    let need = 0;
    for (const x of extractors) if (x.team === team && live(x) && x.res !== 'secondary') need += (x.rateEff || x.rate) * tripTime(team, x, spd) / cap;
    return Math.max(1, Math.min(12, Math.ceil(need * pers(team).harvPerExt)));
  }
  function plotsOf(team) { let o = 0; for (const p of plots) if (p.owner === team || p.claiming === team) o++; return o; }
  function aiReservePrimary(team) {
    let need = 0;
    if (plots.some(p => p.owner === team && !live(p.ext))) need += E.extractor.primary.cost;
    if (supplyCap(team) - supplyUsed(team) <= 6 && supplyCap(team) < E.supply.max) need += E.costs.housing.primary;
    return need;   // economy investments are protected in full; personality.army shapes expansion pace instead
  }
  // Secondary spending gate for AI planners (BUILDER calls this for defense/tech): keeps each personality's split.
  function aiCanSpend(team, c, cat) {
    c = norm(c);
    if (!canAfford(team, c)) return false;
    const P = pers(team), s = aiSpent[team], b = P.budget;
    const total = s.expand + s.defense + s.tech;
    const left = res[team].secondary - c.secondary, bc = b[cat] ?? 0.3;
    // expansion behind schedule gets first call on secondary: other categories must leave the next claim's cost
    const st = AIS[team];
    if (st && st.behind) return cat === 'expand' || left >= E.claim.aetherSecondary;
    // within its budget share -> fine; over it -> only if enough stays banked for the other categories
    if (total < 150 || ((s[cat] || 0) + c.secondary) / (total + c.secondary) <= bc + 0.12) return true;
    return left >= 140 * (1 - bc);
  }
  function housingSpot(team) {
    const cc = H.hq[team]; if (!cc) return null;
    const d = H.toCenter(cc.x, cc.z);
    for (let k = 0; k < 40; k++) {
      const a = Math.atan2(-d.z, -d.x) + (k % 2 ? 1 : -1) * (0.4 + 0.22 * ((k >> 1) % 10)), r = 15 + (k % 3) * 3 + (k >= 20 ? 6 : 0);
      const x = cc.x + Math.cos(a) * r, z = cc.z + Math.sin(a) * r;
      if (Math.abs(x) < hw - 6 && Math.abs(z) < hh - 6 && H.spotFree(x, z, E.costs.housing.r + 1) && !plots.some(p => Math.hypot(p.x - x, p.z - z) < p.r + E.costs.housing.r + 1)) return { x, z };
    }
    return null;
  }
  function aiUpdate(t, dt) {
    const st = AIS[t]; if (!st) return;
    st.think -= dt; if (st.think > 0) return;
    st.think = 2;
    const cc = H.hq[t]; if (!live(cc)) return;
    const P = pers(t), r = res[t], now = T();
    // 1. extractors on claimed empty plots (cheapest first)
    for (const p of plots) {
      if (p.owner !== t || live(p.ext)) continue;
      if (canBuildExtractor(t, p).ok) { buildExtractor(t, p); break; }
    }
    // 2. housing when nearly capped
    const free = supplyCap(t) - supplyUsed(t);
    let pend = 0; for (const e of ents) if (e.team === t && e.kind === 'housing' && e.constructing && e.state !== 'dead') pend++;
    const capped = free + pend * E.supply.housing <= 6 + Math.min(10, now / 60) && supplyCap(t) + pend * E.supply.housing < E.supply.max;
    if (capped && pend < (r.primary > 450 ? 2 : 1) && canAfford(t, E.costs.housing)) { const s = housingSpot(t); if (s) build(t, 'housing', s.x, s.z); }
    // 3. expansion
    const target = Math.min(P.maxPlots, 2 + Math.floor(Math.max(0, now - 20) / 60 * P.expandPerMin + 0.5));
    const claimingNow = plots.some(p => p.claiming === t);
    st.behind = !claimingNow && plotsOf(t) < target;
    if (st.behind) {
      const pRate = extractors.filter(x => x.team === t && x.res !== 'secondary').length;
      const sRate = extractors.filter(x => x.team === t && x.res === 'secondary').length;
      const wantSec = sRate < pRate;
      let best = null, bs = Infinity;
      for (const p of claimables(t)) {
        const dz = danger(t, p); if (dz > 1) continue;
        let s = dist(p, cc) + dz * 40;
        if (p.res === 'aether') s -= 25 + (p.rich ? 10 : 0);
        if (p.res === 'secondary') s += wantSec ? -20 : 15;
        if (s < bs) { bs = s; best = p; }
      }
      if (!best) st.behind = false;
      else if (aiCanSpend(t, claimCost(best), 'expand')) claim(t, best);
    }
    // 4. Aether conversion: lean to whichever currency is scarcer
    const want = r.secondary < 120 && r.primary > 250 ? 'secondary' : r.primary < 150 && r.secondary > 200 ? 'primary' : null;
    if (want) { const pr = processors.find(q => q.team === t && live(q)); if (pr && pr.aetherMode !== want) setAetherMode(pr, want); }
    // 5. forward processor when hauls get long
    if (st.procs < 2 && now > 300 && r.primary > E.costs.processor.primary + 200 && r.secondary > E.costs.processor.secondary + 60) {
      const far = extractors.filter(x => x.team === t && live(x) && x.res !== 'secondary' && (nearestProcessor(t, x)?.p ? dist(nearestProcessor(t, x).p, x) : 0) > 85);
      if (far.length) {
        const x = far[0];
        for (let k = 0; k < 12; k++) {
          const a = k / 12 * TAU, px = x.x + Math.cos(a) * 12, pz = x.z + Math.sin(a) * 12;
          if (H.spotFree(px, pz, E.costs.processor.r + 1) && !plots.some(p => Math.hypot(p.x - px, p.z - pz) < p.r + E.costs.processor.r + 1)) {
            if (build(t, 'processor', px, pz).ok) st.procs++;
            break;
          }
        }
      }
    }
  }

  function stats(team) {
    return {
      primary: res[team].primary, secondary: res[team].secondary,
      incPrimary: incomePerMin(team, 'primary'), incSecondary: incomePerMin(team, 'secondary'),
      earnedPrimary: earned[team].primary, earnedSecondary: earned[team].secondary,
      supply: supplyUsed(team), supplyCap: supplyCap(team), crew: crewUsed(team),
      plots: plots.filter(p => p.owner === team).length, claiming: plots.filter(p => p.claiming === team).length,
      extractors: extractors.filter(x => x.team === team && live(x)).length,
      processors: processors.filter(p => p.team === team && live(p)).length,
      names: names(team),
    };
  }

  const currencyName = (team, which = 'secondary') => names(team)[which] || which;
  function doPlotAction(ent, id, team = 0) { const a = plotActions(ent, team).find(x => x.id === id); return a?.run ? a.run() : { ok: false, reason: 'Unavailable' }; }
  const econ = {
    res, earned, canAfford, spend, add, cost, unitCost, normCost: norm, currencyName, doPlotAction,
    placeBuilding: (team, kind, x, z, opts) => build(team, kind, x, z, opts),
    plots, extractors, processors, plotActions, plotTitle, plotOf, claim, canClaim, buildExtractor, canBuildExtractor, adjacent, claimables,
    build, setAetherMode, aetherMode, assignHarvester,
    supplyCap, supplyUsed, crewUsed, requestCrew, releaseCrew, crewNeed,
    incomePerMin, stats, names, weather,
    aiCanSpend, aiReservePrimary, aiWantHarvesters, aiSpent,
    // internal (sim)
    setup, update, animate, onDeath, updateHarvester, aiUpdate,
  };
  return econ;
}
