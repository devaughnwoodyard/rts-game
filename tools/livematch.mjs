#!/usr/bin/env node
// Vanguard — headless LIVE-SIM AI-vs-AI matches (owner: ROSTER). Runs the real js/sim.js + economy.js + defense.js +
// abilities.js (+ scenario.js "10 minutes in" start unless --fresh) in Node with a fake world (no Three, no meshes).
//
//   node tools/livematch.mjs                        4-team FFA as configured, 3 seeds, 20 game-min
//   node tools/livematch.mjs --duel=volcanic,storm  1v1 on the NE (team 1) / SE (team 3) bases, sides swapped per seed;
//                                                    teams 0 and 2 are parked (no AI, no waves)
//   node tools/livematch.mjs --matrix               all 6 duels, prints a win matrix
//   options: --seeds=4 --min=20 --fresh
// Winner: the team whose cc survives; at the time cap, the larger (army value + 0.5 x damage dealt).
import { CONFIG } from '../js/config.js';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const SEEDS = +args.seeds || 3, MINUTES = +args.min || 20;
globalThis.location = { search: args.fresh ? '?start=fresh' : '' };
let seed = 1;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
Math.random = rnd;
// quiet the per-frame performance.now() cost a little and silence module chatter
const origWarn = console.warn; console.warn = (...a) => { if (args.verbose) origWarn(...a); };

const { createSim } = await import('../js/sim.js');
const { createDefense } = await import('../js/defense.js');
const { createAbilities } = await import('../js/abilities.js');
const { ROSTER } = await import('../js/roster.js');
let applyScenario = null;
try { ({ applyScenario } = await import('../js/scenario.js')); } catch (_) {}

const FACS = ['vanguard', 'volcanic', 'earth', 'storm'];

function match(factions, s, park = []) {
  seed = s;
  const saved = CONFIG.teams.factions.slice();
  CONFIG.teams.factions.splice(0, 4, ...factions);
  const bus = new EventTarget();
  const world = {
    THREE: null, scene: null, renderer: null, camera: null, map: { w: 512, h: 320 }, obstacles: [], entities: [], bus,
    clock: { t: 0, dt: 0, speed: 1 }, teams: { P: 0, count: 4 }, colors: {}, input: { tap: null, drag: null, selected: new Set(), command: null },
    ui: { queues: {} }, makeMesh: () => null, biomeAt: () => ({ volcanic: 0, forest: 0, dunes: 0, badlands: 1 }), onFrame() {},
  };
  const sim = createSim(world);
  const defense = createDefense(sim, world);
  try { applyScenario?.(world, sim); } catch (e) { if (args.verbose) console.log('scenario', e.message); }
  const ab = createAbilities(world, sim);
  CONFIG.teams.factions.splice(0, 4, ...saved);
  for (const t of park) { if (sim.ai[t]) { sim.ai[t].alive = false; sim.ai[t].nextWave = 1e9; } }
  // player team 0 never commands; if parked we also keep its units home (they only defend)
  const dmg = [0, 0, 0, 0], dmgTo = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const built = [{}, {}, {}, {}], byKind = [{}, {}, {}, {}], lost = [{}, {}, {}, {}];
  bus.addEventListener('hit', (ev) => { const d = ev.detail; const a = d.attacker; if (a && a.team >= 0 && d.victim?.team !== a.team) byKind[a.team][a.kind] = Math.round((byKind[a.team][a.kind] || 0) + d.dmg); });
  bus.addEventListener('died', (ev) => { const e = ev.detail.entity; if (e?.team >= 0) lost[e.team][e.kind] = (lost[e.team][e.kind] || 0) + 1; });
  bus.addEventListener('hit', (ev) => { const d = ev.detail; const a = d.attacker?.team, v = d.victim?.team; if (a >= 0 && v >= 0 && a !== v) { dmg[a] += d.dmg; dmgTo[a][v] += d.dmg; } });
  bus.addEventListener('built', (ev) => { const e = ev.detail.entity; if (e?.isUnit) built[e.team][e.kind] = (built[e.team][e.kind] || 0) + 1; });
  const dead = [null, null, null, null];
  const dt = 0.1, end = MINUTES * 60;
  let t = 0;
  while (t < end) {
    t += dt; world.clock.t = t; world.clock.dt = dt;
    sim.update(dt); defense?.update?.(dt); ab.update(dt);
    for (let k = 0; k < 4; k++) if (!dead[k] && !sim.hq[k]) dead[k] = +(t / 60).toFixed(1);
    if (world.ui.gameOver) break;
    const alive = [0, 1, 2, 3].filter(k => !park.includes(k) && !dead[k]);
    if (park.length && alive.length <= 1) break;
  }
  const army = [0, 0, 0, 0];
  for (const e of world.entities) if (e.isUnit && e.state !== 'dead' && e.team >= 0 && ROSTER[e.kind] && !ROSTER[e.kind].harvester) army[e.team] += ROSTER[e.kind].value * e.hp / e.hpMax;
  return { factions, dead, dmg: dmg.map(Math.round), dmgTo: dmgTo.map(r => r.map(Math.round)), army: army.map(Math.round), built, byKind, lost, t: +(t / 60).toFixed(1) };
}

// 1v1 on teams 1 (NE) and 3 (SE): they are each other's nearest enemy cc. Teams 0/2 parked.
function duel(a, b, s) {
  const r = match(['vanguard', a, 'earth', b].map((f, i) => i === 1 ? a : i === 3 ? b : f), s, [0, 2]);
  const da = r.dead[1], db = r.dead[3];
  let w;
  if (da && !db) w = 0; else if (db && !da) w = 1;
  else { const sa = r.army[1] + 0.5 * r.dmgTo[1][3], sb = r.army[3] + 0.5 * r.dmgTo[3][1]; w = sa > sb ? 1 : sa < sb ? 0 : 0.5; }
  return { w, r };
}
let lastMargin = 0;
const marginOf = (r, A, B) => { const sa = r.army[A] + 0.5 * r.dmgTo[A][B] + (r.dead[B] ? 3000 : 0), sb = r.army[B] + 0.5 * r.dmgTo[B][A] + (r.dead[A] ? 3000 : 0); return (sa - sb) / Math.max(1, sa + sb); };
function duelRate(a, b, log) {
  let w = 0, n = 0, m = 0;
  for (let i = 0; i < SEEDS; i++) {
    const s = 1000 + i * 7919;
    const x = duel(a, b, s); w += x.w; n++;
    const y = duel(b, a, s + 1); w += 1 - y.w; n++;
    m += marginOf(x.r, 1, 3) - marginOf(y.r, 1, 3);
    if (log) for (const [res, A, B, ww] of [[x.r, a, b, x.w], [y.r, b, a, y.w]])
      console.log(`  seed ${s} ${A}(NE) vs ${B}(SE): ${ww === 1 ? A : ww === 0 ? B : 'draw'} wins  t=${res.t}m  dead=${JSON.stringify([res.dead[1], res.dead[3]])}  dmg ${res.dmgTo[1][3]}/${res.dmgTo[3][1]}  army ${res.army[1]}/${res.army[3]}`);
  }
  lastMargin = m / n;
  return w / n;
}

if (args.duel) {
  const [a, b] = String(args.duel).split(',');
  const r = duelRate(a, b, true);
  console.log(`${a} vs ${b}: ${(r * 100).toFixed(0)}% margin ${(lastMargin * 100).toFixed(1)}`);
  if (args.built) { const x = duel(a, b, 1000); for (const k of [1, 3]) console.log(`team ${k} built`, JSON.stringify(x.r.built[k]), '\n  dmg by kind', JSON.stringify(x.r.byKind[k]), '\n  lost', JSON.stringify(x.r.lost[k])); }
} else if (args.matrix) {
  const M = {};
  for (const a of FACS) { M[a] = {}; M[a][a] = 0.5; }
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
    const r = duelRate(FACS[i], FACS[j], !!args.log);
    M[FACS[i]][FACS[j]] = r; M[FACS[j]][FACS[i]] = 1 - r;
    console.log(`${FACS[i]} vs ${FACS[j]}: ${(r * 100).toFixed(0)}%`);
  }
  console.log(`\nLIVE-SIM 1v1 (row win% vs column), ${SEEDS * 2} matches/pair, ${MINUTES} min cap, ${args.fresh ? 'fresh start' : '10-min scenario'}`);
  console.log('            ' + FACS.map(f => f.padStart(9)).join(''));
  for (const a of FACS) console.log(a.padEnd(12) + FACS.map(b => ((M[a][b] * 100).toFixed(0) + '%').padStart(9)).join(''));
} else {
  for (let i = 0; i < SEEDS; i++) {
    const r = match(FACS, 1000 + i * 7919);
    console.log(`seed ${i}: t=${r.t}m dead(min)=${JSON.stringify(r.dead)} dmg=${JSON.stringify(r.dmg)} army=${JSON.stringify(r.army)}`);
    console.log('   dmgTo rows=attacker: ' + JSON.stringify(r.dmgTo));
  }
}
