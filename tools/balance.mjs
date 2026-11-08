#!/usr/bin/env node
// Vanguard — headless balance harness (owner: ROSTER). Node only, no Three.
//   node tools/balance.mjs                 evaluate current TUNING, print matrices + identity checks
//   node tools/balance.mjs --tune          auto-tune faction/unit power multipliers
//   node tools/balance.mjs --tune --write  ...and write the result into js/roster.js (TUNING block)
//   options: --n=60 (fights per pair per side order), --budget=2000, --seed=1, --iters=10
//
// Combat model is a minimal re-implementation of sim.js rules (acquire radius 14, retarget if 2u closer, fire when
// edge distance <= range, shot dmg = dps*cooldown*RPS mul, splash, minRange, stun/root/dmgMul status, armor,
// air only hittable by canHitAir, burrowed/stealth untargetable unless detected) plus the REAL abilities.js
// (AI autocast for both sides). Fights: two equal-cost armies 70u apart at random spots, attack-move, 150s cap.
// Winner = more surviving cost-weighted hp.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ROSTER, BASE, FACTIONS, TUNING, applyTuning, rosterMul, ehp } from '../js/roster.js';
import { createAbilities, ABILITIES } from '../js/abilities.js';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const N = +args.n || 40, BUDGET = +args.budget || 2000, ITERS = +args.iters || 10;
let seed = +args.seed || 1;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
Math.random = rnd; // abilities.js uses Math.random for scatter: keep runs reproducible

const F = Object.keys(FACTIONS);
const ROLES = ['infantry', 'light', 'heavy', 'special', 'sky'];
const roleKind = (f, role) => FACTIONS[f].units.find(k => role === 'sky' ? (ROSTER[k].role === 'air' || ROSTER[k].role === 'aa') : ROSTER[k].role === role);
const MIXES = {
  combined: { infantry: 0.30, light: 0.20, heavy: 0.25, special: 0.10, sky: 0.15 },
  noair:    { infantry: 0.35, light: 0.25, heavy: 0.28, special: 0.12 },
  infantry: { infantry: 0.60, light: 0.20, special: 0.20 },
  armor:    { heavy: 0.60, light: 0.20, sky: 0.20 },
};

function buildArmy(f, mix) {
  const out = [], spent = {};
  let left = BUDGET;
  const roles = Object.keys(mix).filter(r => roleKind(f, r));
  for (;;) {
    let best = null, bd = -Infinity;
    for (const r of roles) {
      const k = roleKind(f, r), c = ROSTER[k].cost;
      if (c > left) continue;
      const d = mix[r] * BUDGET - (spent[r] || 0) - c / 2;
      if (d > bd) { bd = d; best = r; }
    }
    if (!best) break;
    const k = roleKind(f, best);
    out.push(k); spent[best] = (spent[best] || 0) + ROSTER[k].cost; left -= ROSTER[k].cost;
  }
  return out;
}
const mono = (k) => { const n = Math.max(1, Math.floor(BUDGET / ROSTER[k].cost)); return Array(n).fill(k); };

// ------------------------------------------------------------------ fake world + sim
function fight(armyA, armyB, maxT = 150) {
  const ents = [];
  const bus = new EventTarget();
  const world = { entities: ents, bus, clock: { t: 0, dt: 0.1 }, teams: { P: -1 }, map: { w: 512, h: 320 }, obstacles: [], fog: null, input: { selected: new Set() } };
  let nextId = 1;
  const emit = (n, d) => bus.dispatchEvent(new CustomEvent(n, { detail: d }));
  const sim = {
    get time() { return world.clock.t; },
    near: (x, z, r, out) => { out = out || []; out.length = 0; for (const e of ents) if (e.state !== 'dead') out.push(e); return out; },
    spawn(kind, team, x, z, opts) {
      const r = ROSTER[kind];
      const e = { id: nextId++, kind, team, x, z, rot: 0, r: r.r, hp: r.hp, hpMax: r.hp, cls: r.cls, light: r.light, air: r.air,
        canHitAir: r.canHitAir, armor: r.armor, state: 'idle', target: null, cooldown: 0, range: r.range, dps: r.dps, speed: r.speed,
        fireRate: r.cooldown || 1, splash: r.splash, minRange: r.minRange, isUnit: !r.mine, scan: rnd() * 0.3, cost: r.cost };
      if (opts) Object.assign(e, opts);
      ents.push(e); return e;
    },
    kill(e) { if (e.state !== 'dead') { e.hp = 0; e.state = 'dead'; } },
    damage(v, a, dmg) {
      if (!v || v.state === 'dead' || !(dmg > 0)) return;
      const s = v.status;
      if (s && s.dmgMul != null && !(s.until != null && world.clock.t > s.until)) dmg *= s.dmgMul;
      dmg *= 1 - (v.armor || 0);
      v.hp -= dmg;
      emit('hit', { x: v.x, z: v.z, attacker: a, victim: v, dmg, cls: v.cls });
      if (v.isUnit && v.state !== 'dead' && !v.target && a && a.state !== 'dead' && a.isUnit) v.target = a;
      if (v.hp <= 0) sim.kill(v);
    },
  };
  const ab = args.noab ? { isDetected: () => false, update() {} } : createAbilities(world, sim);
  const ang = rnd() * Math.PI * 2, ca = Math.cos(ang), sa = Math.sin(ang);
  const place = (army, team, side) => army.forEach((k, i) => {
    const a = rnd() * Math.PI * 2, rr = 12 * Math.sqrt(rnd());
    const lx = side * 35 + Math.cos(a) * rr, lz = Math.sin(a) * rr + (rnd() - 0.5) * 10;
    sim.spawn(k, team, lx * ca - lz * sa, lx * sa + lz * ca);
  });
  place(armyA, 0, -1); place(armyB, 1, 1);

  const t = world.clock;
  const act = (v, now) => v === true || (typeof v === 'number' && v > now);
  const canHit = (e, o) => {
    if (o.state === 'dead' || o.team === e.team) return false;
    if ((o.burrowed || o.stealth) && !ab.isDetected(o, e.team)) return false;
    if (o.mine && !o.isUnit) return rosterMul(e.kind, o) > 0;
    return rosterMul(e.kind, o) > 0;
  };
  const dt = 0.1;
  while (t.t < maxT) {
    t.t += dt; t.dt = dt;
    const units = ents.filter(e => e.isUnit && e.state !== 'dead');
    let alive0 = 0, alive1 = 0;
    for (const e of units) { if (e.summoned) continue; if (e.team === 0) alive0++; else alive1++; }
    if (!alive0 || !alive1) break;
    for (const e of units) {
      if (e.cooldown > 0) e.cooldown -= dt;
      const s = e.status;
      let stunned = false, rooted = false, spd = e.speed;
      if (s && !(s.until != null && t.t > s.until)) {
        stunned = act(s.stunned, t.t); rooted = stunned || act(s.rooted, t.t);
        spd *= (s.speedMul ?? 1) * (s.slowMul ?? 1);
      }
      if (e.burrowed) spd *= 0.7;
      if (!e.speed) continue;
      // targeting
      let tg = e.target;
      if (tg && (tg.state === 'dead' || !canHit(e, tg))) tg = e.target = null;
      e.scan -= dt;
      if (e.scan <= 0 || !tg) {
        e.scan = 0.3;
        let best = null, bd = Infinity;
        for (const o of ents) {
          if (o.team === e.team || o.state === 'dead' || (!o.isUnit && !o.mine)) continue;
          if (!canHit(e, o)) continue;
          const d = Math.hypot(o.x - e.x, o.z - e.z) - o.r;
          if (e.minRange && d < e.minRange) continue;
          if (d < bd) { bd = d; best = o; }
        }
        if (best && (!tg || bd + 2 < Math.hypot(tg.x - e.x, tg.z - e.z) - tg.r)) tg = e.target = best;
      }
      let mx = null, mz = null;
      if (e.burrowed) {
        // burrowed: travel toward nearest ground enemy, stop close (erupt is an ability)
        let best = null, bd = Infinity;
        for (const o of units) if (o.team !== e.team && !o.air && o.state !== 'dead') { const d = Math.hypot(o.x - e.x, o.z - e.z); if (d < bd) { bd = d; best = o; } }
        if (best && bd > 2.5) { mx = best.x; mz = best.z; }
      } else if (tg) {
        const d = Math.hypot(tg.x - e.x, tg.z - e.z) - tg.r;
        if (d <= e.range) {
          e.rot = Math.atan2(e.z - tg.z, tg.x - e.x);
          if (e.cooldown <= 0 && !stunned) {
            e.cooldown = e.fireRate;
            if (e.splash > 0) {
              for (const o of ents) {
                if (o.team === e.team || o.state === 'dead' || !o.isUnit || !canHit(e, o) || !!o.air !== !!tg.air) continue;
                if (Math.hypot(o.x - tg.x, o.z - tg.z) - o.r <= e.splash) sim.damage(o, e, e.dps * e.fireRate * rosterMul(e.kind, o));
              }
            } else sim.damage(tg, e, e.dps * e.fireRate * rosterMul(e.kind, tg));
          }
        } else { mx = tg.x; mz = tg.z; }
      } else {
        // attack-move toward nearest hittable enemy; units that can hit nothing hold
        let best = null, bd = Infinity;
        for (const o of units) if (o.team !== e.team && canHit(e, o)) { const d = Math.hypot(o.x - e.x, o.z - e.z); if (d < bd) { bd = d; best = o; } }
        if (best) { mx = best.x; mz = best.z; }
      }
      if (e.state === 'move' && e.dest) { mx = e.dest.x; mz = e.dest.z; if (Math.hypot(mx - e.x, mz - e.z) < 1) { e.state = 'idle'; e.dest = null; } }
      if (mx != null && !rooted) {
        const dx = mx - e.x, dz = mz - e.z, l = Math.hypot(dx, dz);
        if (l > 0.01) { const st = Math.min(spd * dt, l); e.x += dx / l * st; e.z += dz / l * st; if (!tg) e.rot = Math.atan2(-dz, dx); }
      }
    }
    // separation (ground) + temporary obstacles (floods block the other team)
    for (let i = 0; i < units.length; i++) {
      const a = units[i]; if (a.air) continue;
      for (let j = i + 1; j < units.length; j++) {
        const b = units[j]; if (b.air) continue;
        const dx = b.x - a.x, dz = b.z - a.z, rr = a.r + b.r, d2 = dx * dx + dz * dz;
        if (d2 >= rr * rr) continue;
        const d = Math.sqrt(d2) || 0.01, p = (rr - d) * 0.5;
        a.x -= dx / d * p; a.z -= dz / d * p; b.x += dx / d * p; b.z += dz / d * p;
      }
      for (const o of world.obstacles) {
        if (o.team === a.team) continue;
        const dx = a.x - o.x, dz = a.z - o.z, rr = o.r + a.r, d = Math.hypot(dx, dz);
        if (d < rr) { a.x = o.x + dx / (d || 1) * rr; a.z = o.z + dz / (d || 1) * rr; }
      }
    }
    ab.update(dt);
    for (let i = ents.length - 1; i >= 0; i--) if (ents[i].state === 'dead') ents.splice(i, 1);
  }
  let v0 = 0, v1 = 0;
  for (const e of ents) if (e.isUnit && !e.summoned && e.state !== 'dead') { const v = e.cost * Math.max(0, e.hp) / e.hpMax; if (e.team === 0) v0 += v; else v1 += v; }
  return v0 > v1 ? 1 : v0 < v1 ? 0 : 0.5;
}

// A vs B, n fights each side-order (A as team 0 and as team 1). Returns A's win rate.
function rate(mkA, mkB, n = N) {
  let w = 0;
  for (let i = 0; i < n; i++) { w += fight(mkA(), mkB()); w += 1 - fight(mkB(), mkA()); }
  return w / (2 * n);
}
function matrix(mix, n = N) {
  const M = {};
  for (const a of F) { M[a] = {}; for (const b of F) M[a][b] = a === b ? 0.5 : null; }
  for (let i = 0; i < F.length; i++) for (let j = i + 1; j < F.length; j++) {
    const r = rate(() => buildArmy(F[i], MIXES[mix]), () => buildArmy(F[j], MIXES[mix]), n);
    M[F[i]][F[j]] = r; M[F[j]][F[i]] = 1 - r;
  }
  return M;
}
const combatKinds = () => F.flatMap(f => FACTIONS[f].units.filter(k => ROSTER[k].role !== 'harvester'));
function monoEff(k, n = Math.max(8, N >> 2)) {
  const f = ROSTER[k].faction, opp = F.filter(x => x !== f);
  let s = 0;
  for (const o of opp) s += rate(() => mono(k), () => buildArmy(o, MIXES.combined), n);
  return s / opp.length;
}
const pct = (v) => v == null ? '  -  ' : (v * 100).toFixed(0).padStart(4) + '%';
function printMatrix(title, M) {
  console.log(`\n${title} (row win% vs column)`);
  console.log('            ' + F.map(f => f.padStart(9)).join(''));
  for (const a of F) console.log(a.padEnd(12) + F.map(b => pct(M[a][b]).padStart(9)).join(''));
}
const offBand = (M) => { const out = []; for (let i = 0; i < F.length; i++) for (let j = i + 1; j < F.length; j++) { const v = M[F[i]][F[j]]; if (v < 0.45 || v > 0.55) out.push([F[i], F[j], v]); } return out; };

// ------------------------------------------------------------------ identity checks
function identity() {
  const out = [];
  const all = combatKinds();
  const topEhp = all.slice().sort((a, b) => ehp(b) - ehp(a))[0];
  out.push([`Volcanic heavy has highest effective HP (top: ${topEhp} ${ehp(topEhp).toFixed(0)})`, topEhp === 'volcanic_juggernaut']);
  const air = (f) => FACTIONS[f].units.filter(k => ROSTER[k].air);
  const airArmy = (f) => { const ks = air(f); const o = []; let left = BUDGET, i = 0; for (;;) { const k = ks[i++ % ks.length]; if (ROSTER[k].cost > left) { if (ks.every(q => ROSTER[q].cost > left)) break; continue; } o.push(k); left -= ROSTER[k].cost; } return o; };
  for (const f of F) if (f !== 'earth' && air(f).length) {
    const r = rate(() => airArmy('earth'), () => airArmy(f), Math.max(10, N >> 1));
    out.push([`Earth air beats ${f} air (equal cost): ${pct(r)}`, r > 0.5]);
  }
  for (const role of ['infantry', 'light', 'heavy', 'harvester', 'special']) {
    const ks = F.map(f => roleKind(f, role)), fast = ks.slice().sort((a, b) => ROSTER[b].speed - ROSTER[a].speed)[0];
    out.push([`Storm fastest ${role}: ${fast} ${ROSTER[fast].speed}`, ROSTER[fast].faction === 'storm']);
  }
  const fastest = Object.keys(ROSTER).filter(k => ROSTER[k].trainable).sort((a, b) => ROSTER[b].speed - ROSTER[a].speed)[0];
  out.push([`Fastest unit overall: ${fastest} ${ROSTER[fastest].speed}`, ROSTER[fastest].faction === 'storm']);
  return out;
}
function validate() {
  const errs = [];
  for (const f of F) {
    if (FACTIONS[f].units.length !== 6) errs.push(`${f}: ${FACTIONS[f].units.length} units`);
    for (const k of FACTIONS[f].units) {
      const r = ROSTER[k];
      if (!r) { errs.push(`missing ${k}`); continue; }
      if (r.abilities.length !== 4) errs.push(`${k}: ${r.abilities.length} abilities`);
      const defs = r.abilities.map(id => ABILITIES[id]);
      defs.forEach((d, i) => { if (!d) errs.push(`${k}: unknown ability ${r.abilities[i]}`); });
      if (defs.filter(d => d?.type === 'active').length < 2) errs.push(`${k}: <2 actives`);
    }
  }
  return errs;
}

// ------------------------------------------------------------------ tuning
const T = JSON.parse(JSON.stringify(TUNING));
T.faction = T.faction || {}; T.unit = T.unit || {};
const apply = () => applyTuning(T);
function tune() {
  for (let it = 0; it < ITERS; it++) {
    apply();
    const M = matrix('combined');
    const off = offBand(M);
    const avg = Object.fromEntries(F.map(f => [f, F.filter(g => g !== f).reduce((s, g) => s + M[f][g], 0) / 3]));
    console.log(`iter ${it}: ` + F.map(f => `${f} ${pct(avg[f])}`).join('  ') + `  off-band pairs: ${off.length}`);
    // unit cap: no single unit > 60% vs everything
    let capped = 0;
    for (const k of combatKinds()) {
      const e = monoEff(k);
      if (e > 0.58) { T.unit[k] = +((T.unit[k] ?? 1) * Math.max(0.8, 1 - (e - 0.52))).toFixed(3); capped++; console.log(`   cap ${k} mono ${pct(e)} -> ${T.unit[k]}`); }
    }
    if (!off.length && !capped) return M;
    // faction scalars
    for (const f of F) T.faction[f] = +((T.faction[f] ?? 1) * Math.pow(0.5 / Math.min(0.9, Math.max(0.1, avg[f])), 0.8)).toFixed(3);
    // non-transitive pairs: nerf the winner's unit that does best vs the loser, buff the loser's best answer
    for (const [a, b, v] of off) {
      const [win, lose] = v > 0.5 ? [a, b] : [b, a];
      const ks = FACTIONS[win].units.filter(k => ROSTER[k].role !== 'harvester');
      let top = null, tv = -1;
      for (const k of ks) { const r = rate(() => mono(k), () => buildArmy(lose, MIXES.combined), 8); if (r > tv) { tv = r; top = k; } }
      const gap = Math.abs(v - 0.5);
      T.unit[top] = +((T.unit[top] ?? 1) * (1 - gap * 0.6)).toFixed(3);
      console.log(`   pair ${win}>${lose} ${pct(Math.max(v, 1 - v))}: nerf ${top} -> ${T.unit[top]}`);
    }
    // normalize faction scalars around 1
    const g = Math.pow(F.reduce((p, f) => p * T.faction[f], 1), 1 / F.length);
    for (const f of F) T.faction[f] = +(T.faction[f] / g).toFixed(3);
  }
  apply();
  return matrix('combined');
}

function writeTuning() {
  const p = fileURLToPath(new URL('../js/roster.js', import.meta.url));
  const src = readFileSync(p, 'utf8');
  const unit = Object.fromEntries(Object.entries(T.unit).filter(([, v]) => Math.abs(v - 1) > 1e-3).sort());
  const block = `/*BEGIN TUNING*/\nexport const TUNING = ${JSON.stringify({ faction: T.faction, unit }, null, 2)};\n/*END TUNING*/`;
  writeFileSync(p, src.replace(/\/\*BEGIN TUNING\*\/[\s\S]*?\/\*END TUNING\*\//, block));
  console.log('\nwrote TUNING to js/roster.js');
}

// ------------------------------------------------------------------ main
const errs = validate();
if (errs.length) { console.log('ROSTER errors:\n  ' + errs.join('\n  ')); process.exitCode = 1; }
const t0 = Date.now();
let M;
if (args.tune) M = tune(); else { apply(); M = matrix('combined'); }
printMatrix(`COMBINED ARMS, ${BUDGET} crystals, n=${2 * N}/pair`, M);
if (!args.quick) {
  for (const mix of ['noair', 'infantry', 'armor']) printMatrix(`${mix.toUpperCase()} mix`, matrix(mix, Math.max(10, N >> 1)));
  console.log('\nUnit cost-efficiency (mono army vs other factions\' combined arms):');
  const rows = combatKinds().map(k => [k, monoEff(k)]).sort((a, b) => b[1] - a[1]);
  for (const [k, e] of rows) console.log(`  ${k.padEnd(22)} ${pct(e)}${e > 0.6 ? '  <-- over 60%' : ''}`);
}
console.log('\nIdentity checks:');
for (const [txt, ok] of identity()) console.log(`  [${ok ? 'ok' : 'FAIL'}] ${txt}`);
const ob = offBand(M);
console.log(`\nCombined-arms pairs outside 45-55%: ${ob.length ? ob.map(([a, b, v]) => `${a}-${b} ${pct(v)}`).join(', ') : 'none'}`);
console.log('TUNING:', JSON.stringify(T));
console.log(`(${((Date.now() - t0) / 1000).toFixed(1)}s)`);
if (args.tune && args.write) writeTuning();
