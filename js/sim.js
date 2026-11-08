// Vanguard — simulation (owner: SIM).
// Entities, movement/steering, RPS combat, harvesting economy, build queues,
// enemy army AI + waves, day/night, win/lose. All numbers come from config.js.
//
// TODO.md (stubs / assumptions):
//  - e.rot is the mesh's rotation.y; models face local +X, so rot = atan2(-vz, vx). Turret aim is local to the hull.
//  - damage(victim, attacker, dmg) applies dmg AS GIVEN (already RPS-multiplied). Use sim.mul(attackerKind, victim)
//    to compute the multiplier when calling from defense.js.
//  - Entities flagged `external:true` are skipped by sim targeting/firing (for defense.js to drive itself).
//  - Night turret range penalty skipped when world.defense.hasSurveillance(team) returns true or e.noNightPenalty.
//  - Enemy keeps world.defense.enemyReserve (or CONFIG.pacing.enemyReserve) crystals banked for tiers.
//  - world.obstacles entries with a `team` (gates) block only the other team.
//  - Depleted crystals are removed silently (no `died` event).
import { CONFIG } from './config.js';

const UNIT_KINDS = new Set(['warden', 'raider', 'tank', 'harvester']);
const COMBAT_KINDS = ['warden', 'raider', 'tank'];
const PRODUCES = { barracks: ['warden', 'raider'], factory: ['tank', 'harvester'] };
const TWO_PI = Math.PI * 2;

export function createSim(world) {
  const C = CONFIG;
  const ents = world.entities || (world.entities = []);
  const ui = world.ui || (world.ui = {});
  const bus = world.bus;
  const crystals = [C.economy.startCrystals, C.economy.enemyStartCrystals];
  const queues = new Map();      // building.id -> [{kind, progress, t, total}]
  let nextId = 1;
  let T = 0;                     // accumulated sim seconds (mirrors clock.t)
  let nextWave = C.pacing.firstWave;
  let enemyThink = 0;
  let waveNo = 0;
  let pendingDead = [];
  let hq = [null, null];         // command centers by team
  let staticObs = [];
  let lastCmd = null;
  let staticVer = 0;

  const emit = (name, detail) => { try { bus?.dispatchEvent(new CustomEvent(name, { detail })); } catch (_) {} };
  const message = (text, ms = 2500) => { ui.message = text; emit('message', { text, ms }); };

  // ---------------------------------------------------------------- spawn
  function spawn(kind, team, x, z, opts) {
    const u = C.units[kind], b = C.buildings[kind], d = C.defenses[kind];
    const s = u || b || d || {};
    const e = {
      id: nextId++, kind, team,
      x, z, rot: team === 1 ? Math.PI : 0,
      r: s.r ?? 2, hp: s.hp ?? 100, hpMax: s.hp ?? 100,
      cls: s.cls ?? 'bld', light: !!s.light,
      mesh: null, state: 'idle', target: null, dest: null,
      cooldown: 0, range: s.range ?? 0, dps: s.dps ?? 0, speed: s.speed ?? 0,
      fireRate: s.cooldown ?? 1, carry: 0,
      supply: u ? u.supply : 0, isUnit: !!u, splash: s.splash ?? 0, minRange: s.minRange ?? 0,
      aggressive: false, autoTarget: false, scan: Math.random() * C.aggro.scanInterval,
      harvT: 0, field: null, idleT: 0, manual: false, stall: 0, stallRef: null,
    };
    if (kind === 'crystal') { e.amount = b.amount; e.blockR = b.blockR ?? e.r; }
    if (opts) Object.assign(e, opts);
    if (e.hpMax < e.hp) e.hpMax = e.hp;
    try {
      e.mesh = world.makeMesh ? world.makeMesh(kind, team) : null;
    } catch (err) { console.warn('[sim] makeMesh failed', kind, err?.message); }
    if (e.mesh) {
      e.mesh.userData = e.mesh.userData || {};
      e.mesh.userData.entity = e;
      e.mesh.position?.set?.(x, 0, z);
      if (e.mesh.rotation) e.mesh.rotation.y = e.rot;
      world.scene?.add?.(e.mesh);
    }
    ents.push(e);
    if (kind === 'cc' && (team === 0 || team === 1)) hq[team] = e;
    if (!e.isUnit) rebuildStaticObs();
    return e;
  }

  function rebuildStaticObs() {
    // Buildings/crystals block movement. Walls/gates come via world.obstacles (defense.js).
    staticObs = ents.filter(e => !e.isUnit && e.state !== 'dead' && e.kind !== 'wall' && e.kind !== 'gate');
    staticVer++;
  }

  // ---------------------------------------------------------------- setup
  const M = C.map;
  function field(cx, cz) {
    for (let i = 0; i < 3; i++) {
      const a = i * TWO_PI / 3 + 0.5;
      spawn('crystal', -1, cx + Math.cos(a) * M.fieldSpread, cz + Math.sin(a) * M.fieldSpread);
    }
  }
  spawn('cc', 0, M.playerBase.x, M.playerBase.z);
  spawn('barracks', 0, M.playerBarracks.x, M.playerBarracks.z);
  spawn('factory', 0, M.playerFactory.x, M.playerFactory.z);
  spawn('cc', 1, -M.playerBase.x, -M.playerBase.z);
  spawn('barracks', 1, -M.playerBarracks.x, -M.playerBarracks.z);
  spawn('factory', 1, -M.playerFactory.x, -M.playerFactory.z);
  field(M.playerField.x, M.playerField.z);
  field(M.enemyField.x, M.enemyField.z);
  field(M.centerField.x, M.centerField.z);
  spawnAtRally(byKind('factory', 0), 'harvester');
  spawnAtRally(byKind('factory', 1), 'harvester');

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
    for (const [, q] of queues) for (const it of q) if (it.team === team) s += C.units[it.kind].supply;
    return s;
  }
  function spendCrystals(team, n) {
    if (!(n >= 0) || crystals[team] < n) return false;
    crystals[team] -= n;
    return true;
  }

  function enqueue(building, kind) {
    if (typeof building === 'string') building = byKind(building, 0);
    const fail = (t) => { if (!building || building.team === 0) message(t); return false; };
    if (!building || building.state === 'dead') return fail('Building not available');
    const allowed = PRODUCES[building.kind];
    if (!allowed || !allowed.includes(kind)) return fail(`${building.kind} can't build ${kind}`);
    const team = building.team, u = C.units[kind];
    let q = queues.get(building.id);
    if (!q) { q = []; queues.set(building.id, q); }
    if (q.length >= C.queueMax) return fail('Queue full');
    if (supplyUsed(team) + u.supply > C.supplyCap) return fail('Supply cap reached');
    if (!spendCrystals(team, u.cost)) return fail('Not enough crystals');
    q.push({ kind, progress: 0, t: 0, total: u.buildTime, team });
    return true;
  }

  function updateQueues(dt) {
    for (const [id, q] of queues) {
      if (!q.length) continue;
      const b = ents.find(e => e.id === id);
      if (!b || b.state === 'dead') { q.length = 0; continue; }
      const it = q[0];
      it.t += dt;
      it.progress = Math.min(1, it.t / it.total);
      if (it.t >= it.total) {
        q.shift();
        const e = spawnAtRally(b, it.kind);
        emit('built', { entity: e });
        if (b.team === 0) message(`${it.kind[0].toUpperCase() + it.kind.slice(1)} ready`, 1500);
      }
    }
  }

  // ---------------------------------------------------------------- combat
  function mul(attackerKind, victim) {
    const t = C.rps[attackerKind] || C.rpsDefault;
    if (victim.light && t.light != null) return t.light;
    return t[victim.cls] ?? 1;
  }

  function damage(victim, attacker, dmg) {
    if (!victim || victim.state === 'dead' || victim.cls === 'neutral' || !(dmg > 0)) return;
    victim.hp -= dmg;
    emit('hit', { x: victim.x, z: victim.z, attacker, victim, dmg, cls: victim.cls });
    // Retaliate: an idle/auto unit that gets shot engages its attacker.
    if (attacker && victim.isUnit && victim.dps > 0 && attacker.state !== 'dead' &&
        (victim.state === 'idle' || (victim.state === 'attack' && victim.autoTarget && victim.target?.cls === 'bld'))) {
      victim.state = 'attack'; victim.target = attacker; victim.autoTarget = true;
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
      if (e.mesh) world.scene?.remove?.(e.mesh);
      world.input?.selected?.delete?.(e);
      if (!e.isUnit) structural = true;
      if (queues.has(e.id)) { queues.get(e.id).length = 0; queues.delete(e.id); }
      if (e.depleted) continue;
      emit('died', { entity: e });
      if (e.kind === 'cc' && !ui.gameOver) {
        ui.gameOver = e.team === 1 ? 'win' : 'lose';
        message(e.team === 1 ? 'Victory! Enemy command center destroyed' : 'Defeat. Your command center has fallen', 8000);
      }
    }
    if (structural) rebuildStaticObs();
  }

  const isEnemyOf = (a, b) => b.team !== a.team && b.team !== -1 && b.state !== 'dead' && b.cls !== 'neutral';
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
    for (const o of ents) {
      if (!isEnemyOf(e, o)) continue;
      if (e.kind === 'turret_mg' || e.kind === 'turret_cannon') { if (o.cls === 'bld') continue; }
      const d = edgeDist(e, o);
      if (d > radius) continue;
      if (e.minRange && d < e.minRange) continue;
      const s = d + (o.cls === 'bld' ? C.aggro.bldPenalty : 0);
      if (s < bestScore) { bestScore = s; best = o; }
    }
    return best;
  }
  function nearestEnemyBuilding(e) {
    let best = null, bd = Infinity;
    for (const o of ents) {
      if (!isEnemyOf(e, o) || o.cls !== 'bld') continue;
      const d = edgeDist(e, o);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }

  function fire(e, t) {
    const m = mul(e.kind, t);
    const gy = C.gunY[e.cls] ?? 1.5, ty = t.cls === 'inf' ? 1 : t.cls === 'veh' ? 1.2 : 2;
    emit('shot', { from: { x: e.x, z: e.z, y: gy }, to: { x: t.x, z: t.z, y: ty }, kind: e.kind });
    const dmg = e.dps * e.fireRate * m;
    if (e.splash > 0) {
      const tx = t.x, tz = t.z, sr = e.splash;
      for (let i = ents.length - 1; i >= 0; i--) {
        const o = ents[i];
        if (!isEnemyOf(e, o)) continue;
        if (Math.hypot(o.x - tx, o.z - tz) - o.r <= sr) damage(o, e, e.dps * e.fireRate * mul(e.kind, o));
      }
    } else if (dmg > 0) damage(t, e, dmg);
  }

  // ---------------------------------------------------------------- movement
  const half = { w: (world.map?.w ?? 160) / 2 - 1, h: (world.map?.h ?? 100) / 2 - 1 };

  // Steer toward (tx,tz); returns remaining distance. `ignore` = entity not steered around (our goal).
  // Ghosting (anti-softlock): a unit with no path may pass through its own team's buildings/walls and crystals,
  // never through the other team's structures.
  const ghostSkips = (e, owner) => e.ghost > 0 && (!owner || owner.team === e.team || owner.team === -1);
  function steer(e, tx, tz, dt, ignore) {
    let dx = tx - e.x, dz = tz - e.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-4) return 0;
    dx /= dist; dz /= dist;
    let sx = dx, sz = dz;
    const look = 6;
    const avoid = (ox, oz, or) => {
      const rx = ox - e.x, rz = oz - e.z;
      const along = rx * dx + rz * dz;
      if (along <= 0 || along > dist) return;
      const clear = or + e.r + 0.5;
      const d = Math.hypot(rx, rz);
      if (d > clear + look) return;
      const cross = rx * dz - rz * dx;
      if (Math.abs(cross) >= clear) return;
      const w = 1.6 * (1 - Math.max(0, d - clear) / look);
      const sgn = cross >= 0 ? 1 : -1;
      sx += -dz * sgn * w; sz += dx * sgn * w;
    };
    const obs = world.obstacles || [];
    // Team-tagged obstacles (gates) only block the other team; untagged block everyone.
    for (let i = 0; i < obs.length; i++) { const o = obs[i]; if ((o.team == null || o.team !== e.team) && !(o.owner && ghostSkips(e, o.owner))) avoid(o.x, o.z, o.r); }
    for (let i = 0; i < staticObs.length; i++) { const o = staticObs[i]; if (o !== ignore && !ghostSkips(e, o)) avoid(o.x, o.z, o.blockR ?? o.r); }
    // Other units: avoid ones that aren't travelling with us (prevents head-on harvester deadlocks).
    for (let i = 0; i < unitsBuf.length; i++) {
      const o = unitsBuf[i];
      if (o === e || o === ignore || o.state === 'dead') continue;
      const ox = o.x - e.x, oz = o.z - e.z;
      if (ox * ox + oz * oz > 100) continue;
      if (o.state !== 'idle' && Math.cos(o.rot) * dx - Math.sin(o.rot) * dz > 0.5) continue;
      avoid(o.x, o.z, o.r * 0.8);
    }
    // Stuck fallback: if we barely moved since the last steer call, sidestep for a moment.
    if (e._px != null) {
      const moved = Math.hypot(e.x - e._px, e.z - e._pz);
      if (moved < 0.2 * e.speed * dt) e.stuckT = (e.stuckT || 0) + dt; else e.stuckT = Math.max(0, (e.stuckT || 0) - dt);
      if (e.stuckT > 0.8 && !(e.detour > 0)) { e.detour = 1.2; e.detourSide = Math.random() < 0.5 ? -1 : 1; e.stuckT = 0; }
    }
    if (e.detour > 0) { e.detour -= dt; sx += -dz * e.detourSide * 1.8; sz += dx * e.detourSide * 1.8; }
    const sl = Math.hypot(sx, sz) || 1;
    const step = Math.min(e.speed * dt, dist);
    const vx = sx / sl, vz = sz / sl;
    e.x += vx * step; e.z += vz * step;
    e._px = e.x; e._pz = e.z;
    turnTo(e, Math.atan2(-vz, vx), dt);
    return dist - step;
  }

  // ---------------------------------------------------------------- pathfinding
  // 1-unit grid per team (gates only block the other team). Units steer straight when the line is clear,
  // otherwise follow an A* path (string-pulled) so wall rings / moat gaps / crystal pockets don't trap them.
  const GW = Math.ceil(world.map?.w ?? 160), GH = Math.ceil(world.map?.h ?? 100), GX0 = -GW / 2, GZ0 = -GH / 2;
  const NAV_INFL = 1.0;
  const grids = [null, null];
  let gridSig = ['', ''], gridAt = [-99, -99], gridVer = [0, 0];
  const cellOf = (x, z) => [Math.max(0, Math.min(GW - 1, Math.floor(x - GX0))), Math.max(0, Math.min(GH - 1, Math.floor(z - GZ0)))];
  function gridFor(team) {
    const obs = world.obstacles || [];
    const sig = obs.length + '|' + staticVer;
    if (grids[team] && gridSig[team] === sig && T - gridAt[team] < 2) return grids[team];
    const g = grids[team] || (grids[team] = new Uint8Array(GW * GH));
    g.fill(0);
    const mark = (ox, oz, or) => {
      const rr = or + NAV_INFL;
      const x0 = Math.max(0, Math.floor(ox - rr - GX0)), x1 = Math.min(GW - 1, Math.floor(ox + rr - GX0));
      const z0 = Math.max(0, Math.floor(oz - rr - GZ0)), z1 = Math.min(GH - 1, Math.floor(oz + rr - GZ0));
      for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) {
        const px = cx + GX0 + 0.5, pz = cz + GZ0 + 0.5;
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
    const L = Math.hypot(x1 - x0, z1 - z0), n = Math.ceil(L / 0.5);
    for (let i = 1; i <= n; i++) {
      const f = i / n, x = x0 + (x1 - x0) * f, z = z0 + (z1 - z0) * f;
      if (skipR > 0 && (1 - f) * L < skipR) break;
      const [cx, cz] = cellOf(x, z);
      if (g[cz * GW + cx]) return false;
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
    const g = gridFor(team);
    const s0 = nearestFree(g, ...cellOf(sx, sz)), t0 = nearestFree(g, ...cellOf(tx, tz));
    if (!s0 || !t0) return null;
    const si = s0[1] * GW + s0[0], ti = t0[1] * GW + t0[0];
    if (++stampN >= 0xfffffff0) { stamp.fill(0); stampN = 1; }
    heapI.length = 0; heapF.length = 0;
    const h = (i) => { const dx = Math.abs(i % GW - t0[0]), dz = Math.abs(((i / GW) | 0) - t0[1]); return Math.max(dx, dz) + 0.41421 * Math.min(dx, dz); };
    stamp[si] = stampN; gScore[si] = 0; came[si] = -1; hPush(si, h(si));
    let found = false, it = 0;
    while (heapI.length && it++ < 30000) {
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
    for (let i = ti; i !== -1; i = came[i]) cells.push({ x: i % GW + GX0 + 0.5, z: ((i / GW) | 0) + GZ0 + 0.5 });
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
    const g = gridFor(e.team);
    let n = e._nav;
    const skip = ignore ? ignore.r + NAV_INFL + 1 : 1.5;
    const stale = !n || Math.abs(n.tx - tx) > 2 || Math.abs(n.tz - tz) > 2 || n.ver !== gridVer[e.team] ||
      (e.stuckT > 0.6 && T - n.at > 1.5) || (n.pts && T - n.at > 4);
    if (stale) {
      n = e._nav = { tx, tz, ver: gridVer[e.team], at: T, pts: null };
      if (!losClear(g, e.x, e.z, tx, tz, skip)) {
        n.pts = findPath(e.team, e.x, e.z, tx, tz);
        if (!n.pts && e.stuckT > 0.3) e.ghost = 2.5;   // boxed in (e.g. a wall closed a pocket around us)
      }
    }
    const pts = n.pts;
    if (pts && pts.length) {
      // drop reached waypoints; shortcut to the goal once it's in sight
      while (pts.length && Math.hypot(pts[0].x - e.x, pts[0].z - e.z) < 1.2) pts.shift();
      if (pts.length > 1 && losClear(g, e.x, e.z, pts[1].x, pts[1].z, 0)) pts.shift();
      if (!pts.length || losClear(g, e.x, e.z, tx, tz, skip)) n.pts = null;
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

  function resolveCollisions(units) {
    // unit-unit separation (n^2 on units only; fine for ~80)
    for (let i = 0; i < units.length; i++) {
      const a = units[i];
      for (let j = i + 1; j < units.length; j++) {
        const b = units[j];
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
    const obs = world.obstacles || [];
    for (const e of units) {
      if (e.ghost > 0) e.ghost -= lastDt;
      for (let i = 0; i < obs.length; i++) { const o = obs[i]; if ((o.team == null || o.team !== e.team) && !(o.owner && ghostSkips(e, o.owner))) pushOut(e, o.x, o.z, o.r); }
      for (let i = 0; i < staticObs.length; i++) { const o = staticObs[i]; if (!ghostSkips(e, o)) pushOut(e, o.x, o.z, o.blockR ?? o.r); }
      if (e.x > half.w) e.x = half.w; else if (e.x < -half.w) e.x = -half.w;
      if (e.z > half.h) e.z = half.h; else if (e.z < -half.h) e.z = -half.h;
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
    const tgt = cmd.target && cmd.target.state !== 'dead' ? cmd.target : null;
    const n = sel.length, cols = Math.ceil(Math.sqrt(n)), sp = 3.2;
    sel.forEach((e, i) => {
      e.aggressive = false; e.autoTarget = false; e.manual = false;
      if (cmd.type === 'attack' && tgt && isEnemyOf(e, tgt) && e.dps > 0) {
        e.state = 'attack'; e.target = tgt; e.dest = null;
        return;
      }
      const ox = (i % cols - (cols - 1) / 2) * sp, oz = (Math.floor(i / cols) - (cols - 1) / 2) * sp;
      const x = (tgt ? tgt.x : cmd.x) + (n > 1 ? ox : 0), z = (tgt ? tgt.z : cmd.z) + (n > 1 ? oz : 0);
      if (!Number.isFinite(x) || !Number.isFinite(z)) return;
      e.state = 'move'; e.target = null; e.dest = { x, z }; e.stall = 0; e.stallRef = null;
      if (e.kind === 'harvester') {
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
    if (!t || t.state === 'dead' || !ents.includes(t) && t.state === 'dead') t = e.target = null;
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
      if (e.cooldown <= 0) { e.cooldown = e.fireRate; fire(e, t); }
    } else if (e.isUnit) {
      nav(e, t.x, t.z, dt, t);
    }
    const tur = e.mesh?.userData?.turret;
    if (tur && tur.rotation) tur.rotation.y = ang - e.rot;
  }

  function pickField(e) {
    let best = null, bs = Infinity;
    for (const o of ents) {
      if (o.kind !== 'crystal' || o.state === 'dead' || !(o.amount > 0)) continue;
      const center = Math.abs(o.x) < 15 && Math.abs(o.z) < 15;
      const ownHalf = e.team === 0 ? o.x < 0 : o.x > 0;
      if (!center && !ownHalf) continue;
      let occ = 0;
      for (const h of ents) if (h !== e && h.kind === 'harvester' && h.field === o) occ++;
      const s = Math.hypot(o.x - e.x, o.z - e.z) + occ * 6;
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
        const take = Math.min(C.economy.harvesterCarry, f.amount);
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

  // ---------------------------------------------------------------- enemy AI
  function enemyAI(dt) {
    crystals[1] += (C.pacing.enemyTrickleBase + C.pacing.enemyTrickleGrowth * T / 60) / 60 * dt;
    enemyThink -= dt;
    if (enemyThink <= 0) {
      enemyThink = 1;
      const bar = byKind('barracks', 1), fac = byKind('factory', 1);
      const qOf = (b) => (b && queues.get(b.id)) || [];
      const reserve = world.defense?.enemyReserve ?? C.pacing.enemyReserve;
      const canBuy = (k) => crystals[1] - C.units[k].cost >= (T > C.pacing.firstWave ? reserve : 0);
      // harvesters
      const harvs = ents.filter(e => e.team === 1 && e.kind === 'harvester').length +
        qOf(fac).filter(q => q.kind === 'harvester').length;
      const want = T >= C.pacing.enemySecondHarvesterAt ? C.pacing.enemyHarvesters : 1;
      if (fac && harvs < want && qOf(fac).length < C.pacing.enemyMaxQueued && canBuy('harvester')) enqueue(fac, 'harvester');
      // army mix, skewed toward counters of the player's army
      let pi = 0, pr = 0, pt = 0;
      for (const e of ents) if (e.team === 0) { if (e.kind === 'warden') pi++; else if (e.kind === 'raider') pr++; else if (e.kind === 'tank') pt++; }
      const tot = pi + pr + pt || 1, cw = C.pacing.counterWeight, mix = C.pacing.enemyMix;
      const w = { warden: mix.warden + cw * 6 * pt / tot, raider: mix.raider + cw * 6 * pi / tot, tank: mix.tank + cw * 6 * pr / tot };
      for (let tries = 0; tries < 2; tries++) {
        let r = Math.random() * (w.warden + w.raider + w.tank), kind = 'warden';
        for (const k of COMBAT_KINDS) { if ((r -= w[k]) <= 0) { kind = k; break; } }
        const b = kind === 'tank' ? fac : bar;
        if (b && qOf(b).length < C.pacing.enemyMaxQueued && canBuy(kind) && supplyUsed(1) + C.units[kind].supply <= C.supplyCap) enqueue(b, kind);
      }
    }
    if (T >= nextWave) {
      nextWave += C.pacing.waveInterval;
      waveNo++;
      const size = Math.min(C.pacing.waveMax, C.pacing.waveBase + Math.floor(T / C.pacing.waveGrowthPer));
      const target = hq[0];
      if (!target) return;
      const idle = ents.filter(e => e.team === 1 && e.isUnit && e.dps > 0 && e.state === 'idle' && !e.aggressive);
      idle.sort((a, b) => Math.hypot(b.x - target.x, b.z - target.z) - Math.hypot(a.x - target.x, a.z - target.z));
      const group = idle.slice(0, size);
      group.forEach((e, i) => {
        const a = i * 2.4, rad = target.r + 4 + (i % 4) * 2;
        e.waveDest = { x: target.x + Math.cos(a) * rad, z: target.z + Math.sin(a) * rad };
        e.dest = { ...e.waveDest }; e.state = 'move'; e.aggressive = true; e.stall = 0; e.stallRef = null;
      });
      if (group.length) message(`Enemy wave ${waveNo} incoming (${group.length})`, 3000);
    }
  }

  // ---------------------------------------------------------------- frame
  const unitsBuf = [];
  function update(dtIn) {
    sweep();
    if (ui.gameOver) return;
    // Always consume the full game dt (world.clock.dt = min(real,0.05)*speed). At high clock.speed this is
    // split into <=0.1s substeps so steering/collisions stay stable; previously dt was clamped to 0.1, which
    // silently ran the sim at a fraction of clock time (6.7% at speed 30) and stalled build queues.
    let dtAll = typeof dtIn === 'number' ? dtIn : world.clock?.dt ?? 0;
    if (!(dtAll > 0)) return;
    applyCommand();
    const n = Math.min(40, Math.ceil(dtAll / 0.1));
    const dt = dtAll / n;
    for (let k = 0; k < n && !ui.gameOver; k++) step(dt);
    for (const e of unitsBuf) {
      const m = e.mesh;
      if (!m) continue;
      m.position?.set?.(e.x, 0, e.z);
      if (m.rotation) m.rotation.y = e.rot;
    }
    writeUi();
  }

  let lastDt = 0;
  function step(dt) {
    T += dt; lastDt = dt;
    updateQueues(dt);
    enemyAI(dt);

    unitsBuf.length = 0;
    for (let i = 0; i < ents.length; i++) if (ents[i].isUnit && ents[i].state !== 'dead') unitsBuf.push(ents[i]);
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (e.state === 'dead') continue;
      if (e.cooldown > 0) e.cooldown -= dt;
      if (e.isUnit) {
        if (e.kind === 'harvester') updateHarvester(e, dt);
        else if (e.state === 'move') updateMover(e, dt);
        else if (e.state === 'attack') updateCombat(e, dt);
        else if (e.state === 'idle') {
          updateCombat(e, dt);
          if (e.state === 'idle' && e.aggressive && e.team === 1) {
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
    ui.nextWave = Math.max(0, nextWave - T);
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
  writeUi();

  const sim = {
    update, enqueue, buildDefense, spawn, damage, spendCrystals, mul, kill,
    entities: ents, crystals, queues, config: C,
    get time() { return T; },
  };
  world.sim = sim;
  return sim;
}
