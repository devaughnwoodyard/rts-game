// Vanguard — data-driven unit abilities (owner: ROSTER). No THREE dependency (runs headless in tools/balance.mjs).
//
// createAbilities(world, sim) -> world.abilities = {
//   cast(entity|entities, id, target?)  target: {x,z} | entity | undefined (auto best target). Returns # units that cast
//                                        (or queued: out-of-range casters walk into range, then cast).
//   update(dt)                          call once per frame after sim.update.
//   defsFor(kindOrEntity) -> [def x4]   ABILITIES[id] objects.
//   cooldown(e, id) -> {left, total}    ready(e, id) -> bool        canCast(e, id) -> bool (ready + requirements)
//   autocast(e, id) / setAutocast(e, id, on)   AI teams always autocast; the player per-entity toggle (default def.auto).
//   bestTarget(e, id, relaxed)          what autocast would pick.
//   isDetected(entity, byTeam) -> bool  inside a detector/reveal of byTeam (burrowed units, stealthed mines).
//   reveals: [{team,x,z,r,until,detect}] live reveal/detector circles (fog should OR these in for team 0).
//   zones: [{kind,team,x,z,r,until,...}]  persistent areas (rain, slag, lightning storm) for FX.
//   mines: [entity]                     live mines (vanguard_mine entities).
// }
// Events on world.bus: `ability` {unit, id, x, z, targets, kind, team, faction, r, dir, tx, tz}
//   kind ∈ aoe|cone|line|single|chain|dash|heal|shield|buff|speed|burrow|surface|erupt|reveal|summon|zone|rain|flood|
//          ironball|mines|mine|claymore|demo|slag
//
// Status (CONTRACT: e.status = {rooted, stunned, dmgMul, until}) — this module MERGES with statuses written by
// others (heroes.js) and adds: slowMul (<1), speedMul (>1) — sim should multiply movement speed by both —
// and rangeMul (informational; range changes are applied to e.range directly).
// Direct stat writes each frame (from a captured base): e.armor, e.dps, e.range. Sim must not reset these from
// ROSTER after spawn.
//
// TODO.md: mines/claymores are vanguard_mine entities created with sim.spawn(..., {noBlock, stealth, external});
//   sim must not path-block on noBlock and must keep stealth entities hidden/untargetable unless isDetected().
import { ROSTER } from './roster.js';

const D = Math.PI / 180;
// ------------------------------------------------------------------ ability definitions
// type: 'active'|'passive'. target: 'self'|'point'|'unit'|'ally'. Effects run in order with ctx {x,z (center), dx,dz}.
// Effect shapes: single (the target unit) | aoe {r} | cone {len, arc} | line {len, w}; air: 'ground'(default)|'air'|'both';
// who: 'enemies'(default)|'allies'|'alliesAir'|'self'. ai: autocast heuristic (see aiPick).
export const ABILITIES = {
  // ======================= VANGUARD (industrial: fortification + area denial, mini-missiles)
  vg_frag: { name: 'Frag Grenade', type: 'active', target: 'point', range: 12, cd: 16, auto: true, kind: 'aoe',
    fx: [{ t: 'damage', shape: 'aoe', r: 3.5, amt: 30 }] },
  vg_digin: { name: 'Dig In', type: 'active', target: 'self', cd: 24, ai: 'combat', kind: 'buff',
    fx: [{ t: 'buff', who: 'self', dur: 6, root: true, dmgMul: 0.7, rangeAdd: 3 }] },
  vg_flare: { name: 'Flare', type: 'active', target: 'point', range: 24, cd: 25, ai: 'reveal', kind: 'reveal',
    fx: [{ t: 'reveal', r: 14, dur: 8, detect: true }] },
  vg_brace: { name: 'Brace', type: 'passive', mods: { still: { after: 1.5, armorAdd: 0.15 } }, desc: '+15% armor after standing still 1.5s.' },
  vg_smoke: { name: 'Smoke Screen', type: 'active', target: 'self', cd: 24, ai: 'combat', min: 2, auto: true, kind: 'shield',
    fx: [{ t: 'buff', who: 'allies', r: 8, dur: 4, dmgMul: 0.7 }] },
  vg_ram: { name: 'Ram', type: 'active', target: 'unit', range: 12, cd: 14, kind: 'dash',
    fx: [{ t: 'dash', to: 'target', hit: { amt: 40, r: 2.5, knock: 4, stun: 0.5 } }] },
  vg_overdrive: { name: 'Overdrive', type: 'active', target: 'self', cd: 18, ai: 'engage', kind: 'speed',
    fx: [{ t: 'buff', who: 'self', dur: 5, speedMul: 1.5 }] },
  vg_repairrig: { name: 'Repair Rig', type: 'passive', mods: { aura: { r: 8, who: 'allies', cls: 'veh', hps: 3 } }, desc: 'Nearby allied vehicles regenerate 3 hp/s.' },
  vg_hullbrace: { name: 'Brace Hull', type: 'active', target: 'self', cd: 24, ai: 'combat', aiR: 13, kind: 'buff',
    fx: [{ t: 'buff', who: 'self', dur: 8, root: true, dmgMul: 0.7, rangeAdd: 3 }] },
  vg_apslug: { name: 'AP Slug', type: 'active', target: 'unit', range: 15, cd: 14, auto: true, prefer: 'veh', kind: 'single',
    fx: [{ t: 'damage', shape: 'single', amt: 100 }, { t: 'stun', shape: 'single', dur: 0.4 }] },
  vg_plating: { name: 'Composite Plating', type: 'passive', mods: {}, desc: 'Static: +10% armor (included in stats).' },
  vg_spotter: { name: 'Spotter Link', type: 'passive', mods: { near: { r: 10, cls: 'inf', rangeAdd: 2 } }, desc: '+2 range while allied infantry are within 10.' },
  vg_hv_plating: { name: 'Emergency Plating', type: 'active', target: 'self', cd: 30, ai: 'hurt', auto: true, kind: 'shield',
    fx: [{ t: 'buff', who: 'self', dur: 5, dmgMul: 0.35 }] },
  vg_hv_boost: { name: 'Afterburner', type: 'active', target: 'self', cd: 24, ai: 'hurt', auto: true, kind: 'speed',
    fx: [{ t: 'buff', who: 'self', dur: 4, speedMul: 1.6 }] },
  vg_hv_beacon: { name: 'Distress Beacon', type: 'active', target: 'self', cd: 40, ai: 'hurt', kind: 'reveal',
    fx: [{ t: 'reveal', r: 20, dur: 6, detect: true }, { t: 'buff', who: 'allies', r: 16, dur: 4, speedMul: 1.3 }] },
  vg_hv_frame: { name: 'Reinforced Frame', type: 'passive', mods: { regen: { hps: 3, ooc: 6 } }, desc: 'Regenerate 3 hp/s out of combat.' },
  vg_minefield: { name: 'Lay Minefield', type: 'active', target: 'point', range: 10, cd: 30, ai: 'mines', auto: true, kind: 'mines',
    fx: [{ t: 'mines', n: 6, r: 6, amt: 160, slow: 0.6, slowDur: 2 }] },
  vg_claymore: { name: 'Claymore', type: 'active', target: 'point', range: 8, cd: 20, ai: 'claymore', auto: true, kind: 'claymore',
    fx: [{ t: 'claymore', len: 8, arc: 70, amt: 80, trig: 6 }] },
  vg_demo: { name: 'Demolition Charge', type: 'active', target: 'point', range: 6, cd: 30, ai: 'demo', kind: 'demo',
    fx: [{ t: 'charge', delay: 3, r: 4, amt: 120, bld: 3 }] },
  vg_minesweep: { name: 'Mine Sweep', type: 'passive', mods: { detect: 16 }, desc: 'Detects enemy mines and burrowed units within 16.' },
  vg_flakburst: { name: 'Flak Burst', type: 'active', target: 'point', range: 18, cd: 12, auto: true, air: 'air', kind: 'aoe',
    fx: [{ t: 'damage', shape: 'aoe', r: 4, amt: 70, air: 'air' }] },
  vg_radar: { name: 'Radar Sweep', type: 'active', target: 'self', cd: 30, ai: 'reveal', kind: 'reveal',
    fx: [{ t: 'reveal', r: 40, dur: 8, detect: true }] },
  vg_struts: { name: 'Deploy Struts', type: 'active', target: 'self', cd: 20, ai: 'deploy', kind: 'buff',
    fx: [{ t: 'buff', who: 'self', dur: 8, root: true, rangeAdd: 6, dpsMul: 1.3 }] },
  vg_tracking: { name: 'Tracking Radar', type: 'passive', mods: { detect: 14 }, desc: 'Detects hidden units within 14.' },

  // ======================= VOLCANIC (sturdy, burn, molten regen; iron-ball artillery)
  vc_flameburst: { name: 'Flame Burst', type: 'active', target: 'point', range: 7, cd: 10, auto: true, kind: 'cone',
    fx: [{ t: 'damage', shape: 'cone', len: 7, arc: 70, amt: 20 }, { t: 'dot', shape: 'cone', len: 7, arc: 70, dps: 5, dur: 3 }] },
  vc_emberrush: { name: 'Ember Rush', type: 'active', target: 'unit', range: 10, cd: 12, kind: 'dash',
    fx: [{ t: 'dash', to: 'target', hit: { amt: 20, r: 2 } }] },
  vc_ignite: { name: 'Ignite', type: 'passive', mods: { onHit: { dot: { dps: 3, dur: 3 } } }, desc: 'Attacks burn: 3 dps for 3s.' },
  vc_moltenskin: { name: 'Molten Skin', type: 'passive', mods: { regen: { hps: 4, ooc: 4 } }, desc: 'Regenerate 4 hp/s out of combat.' },
  vc_napalm: { name: 'Napalm Sweep', type: 'active', target: 'point', range: 9, cd: 12, auto: true, kind: 'cone',
    fx: [{ t: 'dot', shape: 'cone', len: 9, arc: 60, dps: 8, dur: 3 }] },
  vc_oilslick: { name: 'Oil Slick', type: 'active', target: 'point', range: 12, cd: 22, auto: true, kind: 'zone',
    fx: [{ t: 'zone', zk: 'oil', r: 5, dur: 5, dps: 5, slow: 0.6 }] },
  vc_heathaze: { name: 'Heat Haze', type: 'active', target: 'self', cd: 20, ai: 'combat', kind: 'shield',
    fx: [{ t: 'buff', who: 'self', dur: 4, dmgMul: 0.7, speedMul: 1.3 }] },
  vc_magmacoat: { name: 'Magma Coat', type: 'passive', mods: { onHit: { dot: { dps: 6, dur: 3 } }, regen: { hps: 6, ooc: 5 }, thorns: { r: 4, dps: 6, dur: 2 } },
    desc: 'Static 45% armor (in stats). Attacks burn; melee attackers burn; molten regen 6 hp/s out of combat.' },
  vc_moltenram: { name: 'Molten Ram', type: 'active', target: 'unit', range: 14, cd: 16, auto: true, kind: 'dash',
    fx: [{ t: 'dash', to: 'target', hit: { amt: 70, r: 3, knock: 4, stun: 0.6 } }] },
  vc_slagspray: { name: 'Slag Spray', type: 'active', target: 'point', range: 8, cd: 12, auto: true, kind: 'cone',
    fx: [{ t: 'damage', shape: 'cone', len: 8, arc: 80, amt: 20 }, { t: 'dot', shape: 'cone', len: 8, arc: 80, dps: 5, dur: 4 }] },
  vc_crust: { name: 'Hardened Crust', type: 'active', target: 'self', cd: 28, ai: 'combat', aiR: 12, auto: true, kind: 'buff',
    fx: [{ t: 'buff', who: 'self', dur: 5, armorAdd: 0.2, stunImmune: true }] },
  vc_hv_vent: { name: 'Magma Vent', type: 'active', target: 'self', cd: 20, ai: 'aoe', min: 1, auto: true, kind: 'aoe',
    fx: [{ t: 'damage', shape: 'aoe', r: 6, amt: 40 }, { t: 'dot', shape: 'aoe', r: 6, dps: 10, dur: 4 }] },
  vc_hv_harden: { name: 'Harden', type: 'active', target: 'self', cd: 25, ai: 'hurt', auto: true, kind: 'buff',
    fx: [{ t: 'buff', who: 'self', dur: 6, armorAdd: 0.3 }] },
  vc_hv_lavatrail: { name: 'Lava Trail', type: 'active', target: 'self', cd: 25, ai: 'hurt', auto: true, kind: 'speed',
    fx: [{ t: 'buff', who: 'self', dur: 5, speedMul: 1.5 }] },
  vc_slagshell: { name: 'Slag Shell', type: 'active', target: 'point', range: 26, cd: 16, auto: true, kind: 'ironball',
    fx: [{ t: 'damage', shape: 'aoe', r: 6, amt: 30 }, { t: 'zone', zk: 'slag', r: 4, dur: 5, dps: 8 }] },
  vc_ricochet: { name: 'Ricochet Shot', type: 'active', target: 'point', range: 26, cd: 14, auto: true, kind: 'ironball',
    fx: [{ t: 'damage', shape: 'aoe', r: 4, amt: 25 }, { t: 'damage', shape: 'aoe', r: 4, amt: 20, at: 'beyond', off: 8 }] },
  vc_bracing: { name: 'Bracing', type: 'passive', mods: { still: { after: 3, rangeAdd: 5 } }, desc: '+5 range after standing still 3s.' },
  vc_redhot: { name: 'Red-Hot Load', type: 'active', target: 'self', cd: 20, ai: 'combat', aiR: 26, auto: true, kind: 'buff',
    fx: [{ t: 'charges', n: 3, mul: 1.5, dot: { dps: 5, dur: 3 } }] },
  vc_ashcloud: { name: 'Ash Cloud', type: 'active', target: 'point', range: 18, cd: 16, auto: true, air: 'air', kind: 'zone',
    fx: [{ t: 'zone', zk: 'ash', r: 6, dur: 5, dps: 18, slow: 0.6, air: 'air' }] },
  vc_shrapnel: { name: 'Pumice Shrapnel', type: 'active', target: 'point', range: 16, cd: 12, auto: true, air: 'air', kind: 'aoe',
    fx: [{ t: 'damage', shape: 'aoe', r: 4, amt: 60, air: 'air' }] },
  vc_anchor: { name: 'Anchor Spikes', type: 'active', target: 'self', cd: 22, ai: 'deploy', kind: 'buff',
    fx: [{ t: 'buff', who: 'self', dur: 8, root: true, rangeAdd: 4, dpsMul: 1.4 }] },

  // ======================= EARTH (air, burrower, healing, water)
  ea_mend: { name: 'Mend', type: 'active', target: 'ally', range: 12, cd: 14, ai: 'alliesHurt', auto: true, kind: 'heal',
    fx: [{ t: 'heal', r: 6, amt: 35, over: 3 }] },
  ea_monsoon: { name: 'Monsoon', type: 'active', target: 'point', range: 18, cd: 45, min: 3, auto: true, kind: 'rain',
    fx: [{ t: 'zone', zk: 'rain', r: 14, dur: 8, slow: 0.6, rangeMul: 0.8 }] },
  ea_photosynth: { name: 'Photosynthesis', type: 'passive', mods: { regen: { hps: 3, ooc: 4 } }, desc: 'Regenerate 3 hp/s out of combat.' },
  ea_thornshot: { name: 'Thorn Arrows', type: 'passive', mods: { onHit: { slow: { mul: 0.85, dur: 1.5 } } }, desc: 'Arrows slow 15% for 1.5s.' },
  ea_pounce: { name: 'Pounce', type: 'active', target: 'unit', range: 12, cd: 12, auto: true, kind: 'dash',
    fx: [{ t: 'dash', to: 'target', hit: { amt: 30, r: 2, stun: 0.5 } }] },
  ea_piercespear: { name: 'Piercing Spear', type: 'active', target: 'point', range: 18, cd: 12, auto: true, kind: 'line',
    fx: [{ t: 'damage', shape: 'line', len: 18, w: 2, amt: 30 }] },
  ea_flashflood: { name: 'Flash Flood', type: 'active', target: 'point', range: 16, cd: 35, min: 3, auto: true, kind: 'flood',
    fx: [{ t: 'damage', shape: 'line', len: 16, w: 4, amt: 20 }, { t: 'knock', shape: 'line', len: 16, w: 4, dist: 5 },
         { t: 'slow', shape: 'line', len: 16, w: 4, mul: 0.5, dur: 3 }, { t: 'obstacle', len: 16, dur: 5, r: 2 }],
    desc: 'Wall of rising water: knockback, 50% slow 3s, blocks enemy ground movement 5s.' },
  ea_barkskin: { name: 'Barkskin', type: 'passive', mods: { regen: { hps: 4, ooc: 4 } }, desc: 'Regenerate 4 hp/s out of combat.' },
  ea_solarbeam: { name: 'Solar Beam', type: 'active', target: 'point', range: 20, cd: 14, auto: true, air: 'both', kind: 'line',
    fx: [{ t: 'damage', shape: 'line', len: 20, w: 3, amt: 50, air: 'both' }] },
  ea_dive: { name: 'Sun Dive', type: 'active', target: 'unit', range: 14, cd: 16, auto: true, kind: 'dash',
    fx: [{ t: 'dash', to: 'target', hit: { amt: 40, r: 3, knock: 3 } }] },
  ea_plumage: { name: 'Radiant Plumage', type: 'passive', mods: { aura: { r: 12, who: 'allies', hps: 3 } }, desc: 'Allies in r12 regenerate 3 hp/s.' },
  ea_sunburst: { name: 'Sunburst', type: 'active', target: 'self', cd: 22, ai: 'aoe', min: 2, auto: true, kind: 'aoe',
    fx: [{ t: 'damage', shape: 'aoe', r: 7, amt: 35 }, { t: 'stun', shape: 'aoe', r: 7, dur: 0.5 }] },
  ea_hv_burrow: { name: 'Tunnel Escape', type: 'active', target: 'self', cd: 20, ai: 'hurt', auto: true, req: 'surfaced', kind: 'burrow',
    fx: [{ t: 'burrow', max: 8 }] },
  ea_hv_surface: { name: 'Surface', type: 'active', target: 'self', cd: 2, ai: 'never', req: 'burrowed', kind: 'surface',
    fx: [{ t: 'surface' }] },
  ea_hv_rootshield: { name: 'Root Shield', type: 'active', target: 'self', cd: 26, ai: 'hurt', auto: true, kind: 'shield',
    fx: [{ t: 'buff', who: 'self', dur: 5, dmgMul: 0.6 }] },
  ea_burrow: { name: 'Burrow', type: 'active', target: 'self', cd: 3, ai: 'burrowApproach', req: 'surfaced', kind: 'burrow',
    fx: [{ t: 'burrow' }] },
  ea_erupt: { name: 'Erupt', type: 'active', target: 'self', cd: 20, ai: 'erupt', req: 'burrowed', kind: 'erupt',
    fx: [{ t: 'surface' }, { t: 'damage', shape: 'aoe', r: 7, amt: 180 }, { t: 'stun', shape: 'aoe', r: 7, dur: 1.5 }] },
  ea_tremor: { name: 'Tremor Sense', type: 'passive', mods: { detect: 18 }, desc: 'Detects burrowed/hidden units within 18.' },
  ea_rootnet: { name: 'Root Network', type: 'passive', mods: { rootnet: { r: 30, speedMul: 1.6 } }, desc: 'Underground near own buildings: +60% speed.' },
  ea_swoop: { name: 'Swarm Swoop', type: 'active', target: 'unit', range: 12, cd: 10, auto: true, air: 'both', kind: 'dash',
    fx: [{ t: 'dash', to: 'target', hit: { amt: 25, r: 2, air: 'both' } }] },
  ea_updraft: { name: 'Updraft', type: 'active', target: 'self', cd: 18, ai: 'combat', auto: true, kind: 'speed',
    fx: [{ t: 'buff', who: 'alliesAir', r: 10, dur: 4, speedMul: 1.4, dmgMul: 0.8 }] },
  ea_featherstorm: { name: 'Feather Storm', type: 'active', target: 'point', range: 10, cd: 14, auto: true, air: 'both', kind: 'aoe',
    fx: [{ t: 'damage', shape: 'aoe', r: 4, amt: 25, air: 'both' }] },
  ea_flock: { name: 'Flock Instinct', type: 'passive', mods: { perAlly: { kind: 'earth_glider', r: 10, dps: 0.08, max: 5 } }, desc: '+8% dps per nearby glider (max +40%).' },

  // ======================= STORM (speed, hit-and-run, lightning)
  st_tailwind: { name: 'Tailwind', type: 'active', target: 'self', cd: 16, ai: 'engage', auto: true, kind: 'speed',
    fx: [{ t: 'buff', who: 'allies', r: 8, dur: 4, speedMul: 1.4 }] },
  st_javelin: { name: 'Shock Javelin', type: 'active', target: 'unit', range: 14, cd: 10, auto: true, air: 'both', kind: 'single',
    fx: [{ t: 'damage', shape: 'single', amt: 30 }, { t: 'stun', shape: 'single', dur: 0.4 }] },
  st_static: { name: 'Static Charge', type: 'passive', mods: { everyN: { n: 4, chain: { amt: 8, bounces: 2, jump: 8 } } }, desc: 'Every 4th attack arcs to 2 more enemies.' },
  st_windstep: { name: 'Windstep', type: 'active', target: 'self', cd: 10, ai: 'flee', auto: true, kind: 'dash',
    fx: [{ t: 'dash', to: 'away', dist: 8 }] },
  st_fullsail: { name: 'Full Sail', type: 'active', target: 'self', cd: 14, ai: 'engage', auto: true, kind: 'speed',
    fx: [{ t: 'buff', who: 'self', dur: 4, speedMul: 1.6 }] },
  st_arclance: { name: 'Arc Lance', type: 'active', target: 'unit', range: 12, cd: 12, auto: true, kind: 'chain',
    fx: [{ t: 'chain', amt: 30, bounces: 3, jump: 8, falloff: 0.75 }] },
  st_hitrun: { name: 'Hit and Run', type: 'passive', mods: { onHitSelf: { speedMul: 1.35, dur: 2 } }, desc: '+35% speed for 2s after attacking.' },
  st_jib: { name: 'Jib Turn', type: 'active', target: 'self', cd: 12, ai: 'flee', auto: true, kind: 'dash',
    fx: [{ t: 'dash', to: 'away', dist: 10 }, { t: 'buff', who: 'self', dur: 2, dmgMul: 0.7 }] },
  st_chain: { name: 'Chain Lightning', type: 'active', target: 'unit', range: 16, cd: 16, auto: true, air: 'both', kind: 'chain',
    fx: [{ t: 'chain', amt: 50, bounces: 4, jump: 10, falloff: 0.75, stun: 0.3, air: 'both' }] },
  st_stormfront: { name: 'Storm Front', type: 'active', target: 'point', range: 16, cd: 18, auto: true, kind: 'aoe',
    fx: [{ t: 'damage', shape: 'aoe', r: 7, amt: 15 }, { t: 'slow', shape: 'aoe', r: 7, mul: 0.6, dur: 3 }] },
  st_capacitor: { name: 'Capacitor Bank', type: 'passive', mods: { healthy: { above: 0.7, dpsMul: 1.15 } }, desc: '+15% dps above 70% hp.' },
  st_gustram: { name: 'Gust Ram', type: 'active', target: 'unit', range: 14, cd: 14, auto: true, kind: 'dash',
    fx: [{ t: 'dash', to: 'target', hit: { amt: 40, r: 3, knock: 6 } }] },
  st_hv_sail: { name: 'Run Before the Wind', type: 'active', target: 'self', cd: 20, ai: 'hurt', auto: true, kind: 'speed',
    fx: [{ t: 'buff', who: 'self', dur: 5, speedMul: 1.7 }] },
  st_hv_static: { name: 'Static Discharge', type: 'active', target: 'self', cd: 22, ai: 'aoe', min: 1, auto: true, kind: 'aoe',
    fx: [{ t: 'damage', shape: 'aoe', r: 6, amt: 30 }, { t: 'stun', shape: 'aoe', r: 6, dur: 1 }] },
  st_hv_mirage: { name: 'Dust Mirage', type: 'active', target: 'self', cd: 26, ai: 'hurt', auto: true, kind: 'shield',
    fx: [{ t: 'buff', who: 'self', dur: 4, dmgMul: 0.5 }] },
  st_hv_featherweight: { name: 'Featherweight', type: 'passive', mods: { oocSpeed: { mul: 1.15, ooc: 3 } }, desc: '+15% speed out of combat.' },
  st_lstorm: { name: 'Lightning Storm', type: 'active', target: 'point', range: 20, cd: 20, auto: true, air: 'both', kind: 'zone',
    fx: [{ t: 'zone', zk: 'lightning', r: 6, dur: 5, dps: 12, air: 'both' }] },
  st_overcharge: { name: 'Overcharge', type: 'active', target: 'self', cd: 22, ai: 'combat', min: 3, aiR: 16, auto: true, kind: 'buff',
    fx: [{ t: 'buff', who: 'allies', r: 10, dur: 5, speedMul: 1.3, dpsMul: 1.25 }] },
  st_dustdevil: { name: 'Dust Devil', type: 'active', target: 'self', cd: 25, ai: 'combat', aiR: 16, auto: true, kind: 'summon',
    fx: [{ t: 'summon', kind: 'storm_dustdevil', n: 2, dur: 10 }] },
  st_staticfield: { name: 'Static Field', type: 'passive', mods: { aura: { r: 8, who: 'enemies', slowMul: 0.85 } }, desc: 'Enemies within 8 are slowed 15%.' },
  st_bolt: { name: 'Lightning Strike', type: 'active', target: 'unit', range: 14, cd: 12, auto: true, air: 'both', kind: 'single',
    fx: [{ t: 'damage', shape: 'single', amt: 45 }, { t: 'stun', shape: 'single', dur: 0.5 }] },
  st_gust: { name: 'Downdraft', type: 'active', target: 'self', cd: 16, ai: 'aoe', min: 2, auto: true, kind: 'aoe',
    fx: [{ t: 'damage', shape: 'aoe', r: 6, amt: 15 }, { t: 'knock', shape: 'aoe', r: 6, dist: 5 }] },
  st_jetstream: { name: 'Jetstream', type: 'active', target: 'self', cd: 18, ai: 'engage', auto: true, kind: 'speed',
    fx: [{ t: 'buff', who: 'alliesAir', r: 10, dur: 4, speedMul: 1.5 }] },
  st_evasive: { name: 'Evasive Rigging', type: 'passive', mods: { moving: { dmgMul: 0.85 } }, desc: '-15% dmg taken while moving.' },
};
// Descriptions of actives are generated from their effect data so numbers never drift from balance changes.
const pc = (m) => Math.round(Math.abs(1 - m) * 100) + '%';
const where = (f) => f.shape === 'cone' ? ` in a ${f.len}u cone` : f.shape === 'line' ? ` in a ${f.len}u line` : f.shape === 'single' ? '' : f.r ? ` r${f.r}` : '';
const airTxt = (f) => f.air === 'air' ? ' (air only)' : f.air === 'both' ? ' (air+ground)' : '';
function describeFx(f) {
  switch (f.t) {
    case 'damage': return `${f.amt} dmg${where(f)}${airTxt(f)}${f.at === 'beyond' ? ` after a ${f.off}u bounce` : ''}`;
    case 'dot': return `burn ${f.dps}/s for ${f.dur}s${where(f)}`;
    case 'stun': return `${f.dur}s stun`;
    case 'root': return `root ${f.dur}s`;
    case 'slow': return `-${pc(f.mul)} speed ${f.dur}s`;
    case 'knock': return 'knockback';
    case 'buff': {
      const who = f.who === 'self' ? '' : f.who === 'alliesAir' ? `allied flyers r${f.r}: ` : `allies r${f.r}: `;
      const p = [];
      if (f.root) p.push('rooted');
      if (f.dmgMul) p.push(`-${pc(f.dmgMul)} dmg taken`);
      if (f.armorAdd) p.push(`+${Math.round(f.armorAdd * 100)}% armor`);
      if (f.speedMul) p.push(`+${pc(f.speedMul)} speed`);
      if (f.dpsMul) p.push(`+${pc(f.dpsMul)} dps`);
      if (f.rangeAdd) p.push(`+${f.rangeAdd} range`);
      if (f.stunImmune) p.push('stun immune');
      return `${who}${p.join(', ')} for ${f.dur}s`;
    }
    case 'heal': return `heal allies r${f.r} for ${f.amt}${f.over ? ` over ${f.over}s` : ''}`;
    case 'zone': {
      const p = [];
      if (f.dps) p.push(`${f.dps} dps`);
      if (f.slow) p.push(`-${pc(f.slow)} speed`);
      if (f.rangeMul) p.push(`-${pc(f.rangeMul)} range`);
      return `${f.zk === 'rain' ? 'rain' : 'field'} r${f.r} for ${f.dur}s: ${p.join(', ')} to enemies${f.air === 'air' ? ' (air only)' : f.air === 'both' ? ' (air+ground)' : ' (ground only)'}`;
    }
    case 'reveal': return `reveal r${f.r} for ${f.dur}s${f.detect ? ' (detects burrowed/mines)' : ''}`;
    case 'burrow': return `burrow: hidden, untargetable, 0.7x speed, no attacks${f.max ? `, up to ${f.max}s` : ''}`;
    case 'surface': return 'surface';
    case 'dash': {
      if (f.to === 'away') return `leap ${f.dist}u away from the nearest enemy`;
      const h = f.hit || {}; const p = [];
      if (h.amt) p.push(`${h.amt} dmg r${h.r}`); if (h.stun) p.push(`${h.stun}s stun`); if (h.knock) p.push('knockback');
      return `charge the target${p.length ? ': ' + p.join(', ') : ''}`;
    }
    case 'chain': return `lightning ${f.amt} dmg, chains to ${f.bounces} more (x${f.falloff} each)${f.stun ? `, ${f.stun}s stun` : ''}`;
    case 'summon': return `summon ${f.n} ${f.kind.split('_').pop()}s for ${f.dur}s`;
    case 'mines': return `bury ${f.n} hidden mines in r${f.r}: ${f.amt} dmg + -${pc(f.slow)} speed on trigger (cap 30)`;
    case 'claymore': return `plant a claymore: ${f.amt} dmg ${f.len}u cone when enemies walk in front`;
    case 'charge': return `timed charge (${f.delay}s): ${f.amt} dmg r${f.r}, x${f.bld} vs buildings`;
    case 'obstacle': return `water wall blocks enemy ground movement ${f.dur}s`;
    case 'charges': return `next ${f.n} shots +${pc(f.mul)} dmg and burn ${f.dot.dps}/s`;
  }
  return '';
}
export function describe(def) {
  if (def.type === 'passive') return def.desc || '';
  const s = def.fx.map(describeFx).filter(Boolean).join('; ');
  return `${s[0].toUpperCase()}${s.slice(1)}. Cooldown ${def.cd}s.`;
}
for (const [id, d] of Object.entries(ABILITIES)) { d.id = id; if (d.type === 'active') { d.desc = describe(d); } }

// ------------------------------------------------------------------ helpers
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const alive = (e) => e && e.state !== 'dead' && e.hp > 0;

export function createAbilities(world, sim, opts = {}) {
  const bus = world.bus;
  const ents = world.entities;
  const now = () => world.clock?.t ?? sim.time ?? 0;
  const P = () => world.teams?.P ?? 0;
  const st = new Map();          // entity -> state
  const zones = [], reveals = [], timers = [], slides = [], mines = [];
  const qbuf = [];
  let inAb = false, thinkAcc = 0, lastT = 0;
  const MINE_CAP = 30;

  const emit = (name, detail) => { try { bus?.dispatchEvent(new CustomEvent(name, { detail })); } catch (_) {} };
  const R = (e) => ROSTER[e.kind];
  function S(e) {
    let s = st.get(e);
    if (!s) {
      const r = R(e);
      s = { cd: {}, auto: {}, buffs: [], dots: [], hots: [], lastHurt: -99, lastFire: -99, stillT: 0, px: e.x, pz: e.z,
        moving: false, shots: 0, charges: null, pending: null, dash: null, burrowUntil: 0, nextThink: Math.random() * 0.4,
        base: { armor: e.armor ?? r?.armor ?? 0, dps: e.dps, range: e.range }, lastObj: null, foreign: null, lastShotT: -1 };
      st.set(e, s);
    }
    return s;
  }
  const defsFor = (k) => (ROSTER[typeof k === 'string' ? k : k?.kind]?.abilities || []).map(id => ABILITIES[id]).filter(Boolean);
  const has = (e, id) => !!R(e)?.abilities?.includes(id);

  // ---------------------------------------------------------------- queries
  function near(x, z, r) {
    const out = sim.near ? sim.near(x, z, r, qbuf) : ents;
    return out.slice();
  }
  function isDetected(o, team) {
    const t = now();
    for (const v of reveals) if (v.team === team && v.detect && v.until >= t && Math.hypot(o.x - v.x, o.z - v.z) <= v.r + (o.r || 0)) return true;
    return false;
  }
  function targetable(o, e) {
    if (!alive(o) || o.team === e.team || o.team < 0 || o.cls === 'neutral') return false;
    if ((o.burrowed || o.stealth) && !isDetected(o, e.team)) return false;
    if (e.team === P() && o.hidden && world.fog?.enabled) return false;
    return true;
  }
  const airOk = (o, mode) => mode === 'both' ? true : mode === 'air' ? !!o.air : !o.air;
  function enemiesIn(e, x, z, r, mode = 'ground', units = false) {
    const out = [];
    for (const o of near(x, z, r)) {
      if (!targetable(o, e) || !airOk(o, mode)) continue;
      if (units && !o.isUnit) continue;
      if (o.mine) continue;
      if (Math.hypot(o.x - x, o.z - z) - (o.r || 0) <= r) out.push(o);
    }
    return out;
  }
  function alliesIn(e, x, z, r, airOnly) {
    const out = [];
    for (const o of near(x, z, r)) {
      if (!alive(o) || o.team !== e.team || !o.isUnit) continue;
      if (airOnly && !o.air) continue;
      if (Math.hypot(o.x - x, o.z - z) - (o.r || 0) <= r) out.push(o);
    }
    return out;
  }
  function inShape(e, f, ctx, o) {
    const shape = f.shape || 'aoe';
    if (shape === 'single') return o === ctx.target;
    if (shape === 'aoe') return Math.hypot(o.x - ctx.x, o.z - ctx.z) - (o.r || 0) <= (f.r || 3);
    const rx = o.x - e.x, rz = o.z - e.z, along = rx * ctx.dx + rz * ctx.dz;
    if (shape === 'cone') {
      const d = Math.hypot(rx, rz);
      if (d - (o.r || 0) > f.len || along <= 0) return d < (o.r || 0) + e.r;
      return Math.acos(clamp(along / (d || 1), -1, 1)) <= (f.arc || 60) * D / 2;
    }
    if (shape === 'line') {
      const cross = Math.abs(rx * ctx.dz - rz * ctx.dx);
      return along >= -1 && along <= f.len + (o.r || 0) && cross <= (f.w || 2) / 2 + (o.r || 0);
    }
    return false;
  }
  function select(e, f, ctx) {
    const who = f.who || 'enemies';
    if (who === 'self') return [e];
    if (who === 'allies' || who === 'alliesAir') return alliesIn(e, ctx.x, ctx.z, f.r || 8, who === 'alliesAir');
    if ((f.shape || 'aoe') === 'single') return ctx.target && targetable(ctx.target, e) ? [ctx.target] : [];
    const reach = f.shape === 'aoe' || !f.shape ? (f.r || 3) : (f.len || 8) + 2;
    const cx = f.shape === 'aoe' || !f.shape ? ctx.x : e.x, cz = f.shape === 'aoe' || !f.shape ? ctx.z : e.z;
    return enemiesIn(e, cx, cz, reach, f.air || 'ground').filter(o => inShape(e, f, ctx, o));
  }

  // ---------------------------------------------------------------- effect application
  const scale = (e) => R(e)?.abilityMul ?? 1;
  function hurt(src, v, amt, bldMul = 0.5) {
    if (!alive(v) || !(amt > 0)) return;
    if (v.cls === 'bld') amt *= bldMul;
    inAb = true;
    try { sim.damage(v, src, amt); } finally { inAb = false; }
  }
  // Same-id buffs don't stack: a recast refreshes (keeps the later expiry).
  function addBuff(o, b) {
    const s = S(o);
    if (b.stun && s.immuneUntil > now()) return;
    if (b.id) { const ex = s.buffs.find(x => x.id === b.id); if (ex) { if (b.until > ex.until) Object.assign(ex, b); return; } }
    s.buffs.push(b);
  }
  function addDot(o, src, dps, dur, key) {
    if (!alive(o)) return;
    const s = S(o), t = now();
    const ex = s.dots.find(d => d.key === key && d.src === src);
    if (ex) { ex.until = Math.max(ex.until, t + dur); ex.dps = Math.max(ex.dps, dps); return; }
    s.dots.push({ src, dps, until: t + dur, next: t + 0.5, key });
  }
  function knock(o, fx, fz, dist) {
    if (!alive(o) || o.air || !o.isUnit || o.cls === 'bld') return;
    let dx = o.x - fx, dz = o.z - fz; const l = Math.hypot(dx, dz) || 1;
    slides.push({ e: o, vx: dx / l * dist / 0.2, vz: dz / l * dist / 0.2, left: 0.2 });
  }
  function stun(o, dur) { if (S(o).immuneUntil > now()) return; addBuff(o, { until: now() + dur, stun: true }); }
  function spawnTemp(kind, team, x, z, extra) {
    const r = ROSTER[kind];
    const o = sim.spawn(kind, team, x, z, {
      isUnit: !r.mine, hp: r.hp, hpMax: r.hp, speed: r.speed, range: r.range, dps: r.dps, fireRate: r.cooldown || 1, r: r.r,
      cls: r.cls, light: !!r.light, air: !!r.air, canHitAir: !!r.canHitAir, armor: r.armor || 0, supply: 0, ...extra,
    });
    return o;
  }

  function runEffect(e, def, f, ctx, hitList) {
    const t = now(), m = scale(e);
    const c2 = f.at === 'beyond' ? { ...ctx, x: ctx.x + ctx.dx * (f.off || 6), z: ctx.z + ctx.dz * (f.off || 6) } : ctx;
    switch (f.t) {
      case 'damage': for (const o of select(e, f, c2)) { hurt(e, o, f.amt * m); hitList.add(o); } break;
      case 'dot': for (const o of select(e, f, c2)) { addDot(o, e, f.dps * m, f.dur, def.id); hitList.add(o); } break;
      case 'stun': for (const o of select(e, f, c2)) { stun(o, f.dur); hitList.add(o); } break;
      case 'root': for (const o of select(e, f, c2)) { addBuff(o, { until: t + f.dur, root: true }); hitList.add(o); } break;
      case 'slow': for (const o of select(e, f, c2)) { addBuff(o, { until: t + f.dur, slowMul: f.mul }); hitList.add(o); } break;
      case 'knock': {
        const lineK = f.shape === 'line';
        for (const o of select(e, f, c2)) {
          if (lineK) knock(o, o.x - ctx.dx, o.z - ctx.dz, f.dist); else knock(o, c2.x, c2.z, f.dist);
          hitList.add(o);
        }
        break;
      }
      case 'buff': for (const o of select(e, f, c2)) {
        addBuff(o, { id: def.id, until: t + f.dur, dmgMul: f.dmgMul, speedMul: f.speedMul, dpsMul: f.dpsMul, rangeAdd: f.rangeAdd, armorAdd: f.armorAdd, root: f.root });
        if (f.stunImmune) S(o).immuneUntil = t + f.dur;
        hitList.add(o);
      } break;
      case 'heal': for (const o of alliesIn(e, c2.x, c2.z, f.r || 6)) {
        if (f.over) S(o).hots.push({ hps: f.amt * m / f.over, until: t + f.over }); else o.hp = Math.min(o.hpMax, o.hp + f.amt * m);
        hitList.add(o);
      } break;
      case 'zone': zones.push({ kind: f.zk || 'zone', team: e.team, src: e, x: c2.x, z: c2.z, r: f.r, until: t + f.dur, dps: (f.dps || 0) * m,
        slow: f.slow, rangeMul: f.rangeMul, air: f.air || 'ground', next: t }); break;
      case 'reveal': reveals.push({ team: e.team, x: c2.x, z: c2.z, r: f.r, until: t + f.dur, detect: !!f.detect }); break;
      case 'burrow': e.burrowed = true; e.target = null; S(e).burrowUntil = f.max ? t + f.max : 0; break;
      case 'surface': e.burrowed = false; S(e).burrowUntil = 0; break;
      case 'dash': {
        const s = S(e);
        let tx, tz;
        if (f.to === 'away') {
          const en = enemiesIn(e, e.x, e.z, 20, 'both')[0];
          const dx = en ? e.x - en.x : -ctx.dx, dz = en ? e.z - en.z : -ctx.dz, l = Math.hypot(dx, dz) || 1;
          tx = e.x + dx / l * f.dist; tz = e.z + dz / l * f.dist;
        } else {
          const tg = ctx.target || ctx, dx = tg.x - e.x, dz = tg.z - e.z, l = Math.hypot(dx, dz) || 1;
          const stop = Math.max(0, l - (tg.r || 0) - e.r);
          tx = e.x + dx / l * stop; tz = e.z + dz / l * stop;
        }
        const half = (world.map?.w ?? 512) / 2 - 2, halfZ = (world.map?.h ?? 320) / 2 - 2;
        tx = clamp(tx, -half, half); tz = clamp(tz, -halfZ, halfZ);
        const dist = Math.hypot(tx - e.x, tz - e.z);
        s.dash = { x0: e.x, z0: e.z, x1: tx, z1: tz, t: 0, dur: Math.max(0.12, dist / 45), hit: f.hit, def };
        break;
      }
      case 'chain': {
        let cur = ctx.target && targetable(ctx.target, e) ? ctx.target : null, amt = f.amt * m;
        const seen = new Set(), order = [];
        for (let i = 0; cur && i <= f.bounces; i++) {
          seen.add(cur); order.push(cur); hurt(e, cur, amt); if (f.stun) stun(cur, f.stun); hitList.add(cur);
          amt *= f.falloff ?? 0.8;
          let nb = null, nd = Infinity;
          for (const o of enemiesIn(e, cur.x, cur.z, f.jump, f.air || 'both', true)) {
            if (seen.has(o)) continue; const d = Math.hypot(o.x - cur.x, o.z - cur.z); if (d < nd) { nd = d; nb = o; }
          }
          cur = nb;
        }
        ctx.chain = order;
        break;
      }
      case 'summon': for (let i = 0; i < f.n; i++) {
        const a = Math.random() * Math.PI * 2;
        const o = spawnTemp(f.kind, e.team, e.x + Math.cos(a) * 3, e.z + Math.sin(a) * 3, { summoned: true });
        if (!o) continue;
        const en = enemiesIn(e, e.x, e.z, 30, 'ground', true)[0];
        if (en) { o.state = 'attack'; o.target = en; o.autoTarget = true; o.aggressive = true; }
        timers.push({ at: t + f.dur, fn: () => { if (alive(o)) (sim.kill ? sim.kill(o) : (o.hp = 0, o.state = 'dead')); } });
        hitList.add(o);
      } break;
      case 'mines': {
        const own = mines.filter(o => alive(o) && o.team === e.team);
        for (let i = 0; i < f.n; i++) {
          if (own.length >= MINE_CAP) { const old = own.shift(); if (old) killMine(old, false); }
          const a = (i / f.n) * Math.PI * 2 + Math.random() * 0.5, rr = f.r * Math.sqrt(0.2 + 0.8 * Math.random());
          const o = spawnTemp('vanguard_mine', e.team, c2.x + Math.cos(a) * rr, c2.z + Math.sin(a) * rr,
            { mine: true, noBlock: true, stealth: true, external: true, isUnit: false, layer: e, mineDmg: f.amt * m, mineSlow: f.slow, mineSlowDur: f.slowDur, armedAt: t + 1 });
          if (o) { mines.push(o); own.push(o); }
        }
        break;
      }
      case 'claymore': {
        const o = spawnTemp('vanguard_mine', e.team, c2.x, c2.z, { mine: true, noBlock: true, stealth: true, external: true, isUnit: false, layer: e,
          claymore: { dx: ctx.dx, dz: ctx.dz, len: f.len, arc: f.arc, amt: f.amt * m, trig: f.trig }, armedAt: t + 1 });
        if (o) { o.rot = Math.atan2(-ctx.dz, ctx.dx); mines.push(o); }
        break;
      }
      case 'charge': {
        const cx = c2.x, cz = c2.z;
        timers.push({ at: t + f.delay, fn: () => {
          const hits = [];
          for (const o of enemiesIn(e, cx, cz, f.r, 'ground')) { hurt(e, o, f.amt * m, f.bld || 1); hits.push(o); }
          emit('ability', { unit: e, id: def.id, x: cx, z: cz, targets: hits, kind: 'demo', phase: 'detonate', team: e.team, faction: R(e)?.faction, r: f.r });
        } });
        break;
      }
      case 'obstacle': {
        const obs = world.obstacles || (world.obstacles = []);
        const added = [];
        for (let d = 2; d <= f.len; d += f.r * 1.4) {
          const o = { x: e.x + ctx.dx * d, z: e.z + ctx.dz * d, r: f.r, team: e.team, flood: true, temp: true };
          obs.push(o); added.push(o);
        }
        ctx.obstacles = added;
        timers.push({ at: t + f.dur, fn: () => { for (const o of added) { const i = obs.indexOf(o); if (i >= 0) obs.splice(i, 1); } } });
        break;
      }
      case 'charges': S(e).charges = { n: f.n, mul: f.mul, dot: f.dot, id: def.id }; break;
    }
  }

  function killMine(o, emitIt = true) {
    const i = mines.indexOf(o); if (i >= 0) mines.splice(i, 1);
    if (alive(o)) sim.kill ? sim.kill(o) : (o.hp = 0, o.state = 'dead');
    if (emitIt) emit('ability', { unit: o.layer || o, id: o.claymore ? 'vg_claymore' : 'vg_minefield', x: o.x, z: o.z, targets: [], kind: o.claymore ? 'claymore' : 'mine', phase: 'detonate', team: o.team, faction: 'vanguard', r: o.claymore ? o.claymore.len : 2.5 });
  }

  // Execute an ability now (no range/cd checks). target: entity | {x,z} | null
  function execute(e, def, target) {
    const t = now(), s = S(e);
    let x = e.x, z = e.z, tgt = null;
    if (target && target.kind !== undefined && target.id !== undefined) { tgt = target; x = target.x; z = target.z; }
    else if (target && Number.isFinite(target.x)) { x = target.x; z = target.z; }
    let dx = x - e.x, dz = z - e.z, l = Math.hypot(dx, dz);
    if (l < 1e-3) { dx = Math.cos(e.rot || 0); dz = -Math.sin(e.rot || 0); l = 1; }
    dx /= l; dz /= l;
    if (def.target === 'self') { x = e.x; z = e.z; }
    const ctx = { x, z, dx, dz, target: tgt };
    const hits = new Set();
    for (const f of def.fx) runEffect(e, def, f, ctx, hits);
    s.cd[def.id] = t + def.cd;
    e.rot = Math.atan2(-dz, dx);
    const f0 = def.fx.find(f => f.r || f.len);
    emit('ability', { unit: e, id: def.id, x, z, tx: x, tz: z, targets: ctx.chain || [...hits], kind: def.kind || def.fx[0].t,
      team: e.team, faction: R(e)?.faction, r: f0?.r ?? f0?.len ?? 0, len: f0?.len, dir: { x: dx, z: dz }, from: { x: e.x, z: e.z } });
    return true;
  }

  function meetsReq(e, def) {
    if (def.req === 'burrowed' && !e.burrowed) return false;
    if (def.req === 'surfaced' && e.burrowed) return false;
    if (e.burrowed && def.req !== 'burrowed' && def.fx[0].t !== 'surface') return false; // burrowed can only surface/erupt
    return true;
  }
  const ready = (e, id) => (S(e).cd[id] ?? 0) <= now();
  function canCast(e, id) {
    const def = ABILITIES[id];
    if (!def || def.type !== 'active' || !alive(e) || !has(e, id)) return false;
    if (e._stunned || isStunned(e)) return false;
    return ready(e, id) && meetsReq(e, def);
  }
  function isStunned(e) { const v = e.status?.stunned; return v === true || (typeof v === 'number' && v > now()); }
  const rangeOf = (e, def) => (def.range || 0) + (e.r || 0);
  const posOf = (tg) => tg && Number.isFinite(tg.x) ? tg : null;

  // ---------------------------------------------------------------- AI target picking
  function bestCluster(e, def, relaxed) {
    const f = def.fx.find(f => f.shape || f.t === 'zone' || f.t === 'mines') || def.fx[0];
    const mode = def.air || f.air || 'ground';
    const shape = f.t === 'zone' ? 'aoe' : (f.shape || 'aoe');
    const reach = rangeOf(e, def) + (shape === 'aoe' ? (f.r || 3) : 0);
    const cands = enemiesIn(e, e.x, e.z, reach, mode, true);
    if (!cands.length) return null;
    const min = relaxed ? 1 : (def.min ?? (shape === 'aoe' ? 2 : 1));
    let best = null, bn = 0;
    for (const c of cands) {
      let cx = c.x, cz = c.z;
      const d = Math.hypot(cx - e.x, cz - e.z);
      if (shape === 'aoe' && d > rangeOf(e, def)) { const k = rangeOf(e, def) / d; cx = e.x + (cx - e.x) * k; cz = e.z + (cz - e.z) * k; }
      const ctx = { x: cx, z: cz, dx: (c.x - e.x) / (d || 1), dz: (c.z - e.z) / (d || 1) };
      const ff = shape === 'aoe' ? { shape: 'aoe', r: f.r || 3 } : f;
      let n = 0;
      for (const o of cands) if (inShape(e, ff, ctx, o)) n += o.cls === 'veh' ? 1.2 : 1;
      if (n > bn) { bn = n; best = { x: cx, z: cz }; }
    }
    return bn >= min ? best : null;
  }
  function aiPick(e, def, relaxed = false) {
    const t = now();
    const hpf = e.hp / (e.hpMax || 1);
    const enemies = (r, mode = 'both') => enemiesIn(e, e.x, e.z, r, mode, true);
    switch (def.ai) {
      case 'never': return null;
      case 'combat': return enemies(def.aiR ?? 14).length >= (relaxed ? 1 : def.min ?? 1) ? e : null;
      case 'engage': return enemies(def.aiR ?? 24).length >= 1 ? e : null;
      case 'hurt': return (hpf < (def.hpBelow ?? 0.6) || relaxed) && enemies(18).length ? e : null;
      case 'flee': return (hpf < 0.45 || relaxed) && enemies(9).length ? e : null;
      case 'aoe': { const f = def.fx.find(f => f.r); return enemiesIn(e, e.x, e.z, f?.r ?? 6, def.air || 'ground', true).length >= (relaxed ? 1 : def.min ?? 2) ? e : null; }
      case 'deploy': {
        const f = def.fx[0], reach = e.range + (f.rangeAdd || 0) + 2;
        const mode = R(e)?.canHitAir ? 'both' : 'ground';
        return enemies(reach, mode).length && !enemies(6, 'ground').length ? e : null;
      }
      case 'reveal': {
        for (const o of near(e.x, e.z, def.fx[0].r ?? 20)) if (alive(o) && o.team !== e.team && o.team >= 0 && (o.burrowed || o.stealth) && !isDetected(o, e.team)) return def.target === 'point' ? { x: o.x, z: o.z } : e;
        return relaxed ? (def.target === 'point' ? { x: e.x, z: e.z } : e) : null;
      }
      case 'burrowApproach': {
        if (e.burrowed) return null;
        const far = enemies(45, 'ground'), close = enemies(8, 'ground');
        return far.length && !close.length && hpf > 0.3 ? e : null;
      }
      case 'erupt': {
        const n = enemiesIn(e, e.x, e.z, 6, 'ground', true);
        return n.length >= 2 || (n.length && Math.hypot(n[0].x - e.x, n[0].z - e.z) < 4) || (relaxed && n.length) ? e : null;
      }
      case 'alliesHurt': {
        let best = null, bm = relaxed ? 1 : 60;
        for (const a of alliesIn(e, e.x, e.z, rangeOf(e, def))) {
          let m = 0;
          for (const b of alliesIn(e, a.x, a.z, def.fx[0].r || 6)) m += b.hpMax - b.hp;
          if (m > bm) { bm = m; best = { x: a.x, z: a.z }; }
        }
        return best;
      }
      case 'mines': {
        const en = enemies(32, 'ground');
        if (!en.length) return null;
        let n = en[0], nd = Infinity;
        for (const o of en) { const d = Math.hypot(o.x - e.x, o.z - e.z); if (d < nd) { nd = d; n = o; } }
        if (nd < 10 && !relaxed) return null;
        const k = Math.min(def.range, nd * 0.5) / (nd || 1);
        return { x: e.x + (n.x - e.x) * k, z: e.z + (n.z - e.z) * k };
      }
      case 'claymore': {
        const en = enemies(16, 'ground');
        if (!en.length) return null;
        const n = en[0], d = Math.hypot(n.x - e.x, n.z - e.z) || 1, k = Math.min(def.range, d * 0.4) / d;
        return { x: e.x + (n.x - e.x) * k, z: e.z + (n.z - e.z) * k };
      }
      case 'demo': {
        for (const o of near(e.x, e.z, rangeOf(e, def) + 6)) if (targetable(o, e) && o.cls === 'bld' && !o.mine) return { x: o.x, z: o.z };
        return relaxed ? bestCluster(e, def, true) : null;
      }
    }
    if (def.target === 'unit') {
      const mode = def.air || 'ground';
      const dash = def.fx[0].t === 'dash';
      let best = null, bs = Infinity;
      for (const o of enemiesIn(e, e.x, e.z, rangeOf(e, def), mode, true)) {
        const d = Math.hypot(o.x - e.x, o.z - e.z);
        if (dash && d < 4 && !relaxed) continue;
        let sc = d - (o === e.target ? 6 : 0) - (def.prefer && o.cls === def.prefer && !o.light ? 8 : 0);
        if (sc < bs) { bs = sc; best = o; }
      }
      return best;
    }
    if (def.target === 'point') return bestCluster(e, def, relaxed);
    if (def.target === 'ally') return aiPick(e, { ...def, ai: 'alliesHurt' }, relaxed);
    return enemies(14).length ? e : null;
  }

  // ---------------------------------------------------------------- public cast
  function castOne(e, id, target) {
    const def = ABILITIES[id];
    if (!canCast(e, id)) return false;
    if (def.target === 'self') { execute(e, def, null); return true; }
    let tg = target;
    if (tg == null) { tg = aiPick(e, def, true); if (!tg) return false; }
    if (def.target === 'unit' && !(tg.id !== undefined && tg.kind !== undefined)) {
      // point given for a unit ability: nearest valid enemy to that point
      const mode = def.air || 'ground';
      const c = enemiesIn(e, tg.x, tg.z, 6, mode, true).sort((a, b) => Math.hypot(a.x - tg.x, a.z - tg.z) - Math.hypot(b.x - tg.x, b.z - tg.z))[0];
      if (!c) return false;
      tg = c;
    }
    const p = posOf(tg);
    if (!p) return false;
    const d = Math.hypot(p.x - e.x, p.z - e.z) - (tg.r || 0);
    if (d > rangeOf(e, def)) {
      S(e).pending = { id, target: tg, until: now() + 10 };
      e.state = 'move'; e.dest = { x: p.x, z: p.z }; e.target = null; e.stall = 0; e.stallRef = null;
      return true;
    }
    execute(e, def, tg);
    return true;
  }
  function cast(list, id, target) {
    const arr = Array.isArray(list) ? list : list instanceof Set ? [...list] : [list];
    let n = 0;
    for (const e of arr) if (e && has(e, id) && castOne(e, id, target)) n++;
    return n;
  }

  // ---------------------------------------------------------------- hit hook (passives on basic attacks)
  bus?.addEventListener?.('hit', (ev) => {
    const d = ev.detail; if (!d) return;
    const t = now();
    const v = d.victim, a = d.attacker;
    if (v && ROSTER[v.kind]) {
      const vs = S(v); vs.lastHurt = t;
      // thorns (Magma Coat): melee-range attackers burn
      if (!inAb && a && alive(a) && R(v)) for (const id of R(v).abilities) {
        const th = ABILITIES[id]?.mods?.thorns;
        if (th && Math.hypot(a.x - v.x, a.z - v.z) - (a.r || 0) - (v.r || 0) <= th.r) { inAb = true; try { addDot(a, v, th.dps * scale(v), th.dur, id); } finally { inAb = false; } }
      }
    }
    if (inAb || !a || !ROSTER[a.kind] || a.mine) return;
    const as = S(a); as.lastFire = t;
    const newShot = as.lastShotT !== t || as.lastShotV === v ? true : false;
    const firstOfShot = as.lastShotT !== t;
    as.lastShotT = t; as.lastShotV = v;
    const r = R(a);
    for (const id of r.abilities) {
      const m = ABILITIES[id]?.mods; if (!m) continue;
      if (m.onHit?.dot) addDot(v, a, m.onHit.dot.dps * scale(a), m.onHit.dot.dur, id);
      if (m.onHit?.slow && v.isUnit) addBuff(v, { until: t + m.onHit.slow.dur, slowMul: m.onHit.slow.mul });
      if (firstOfShot && m.onHitSelf) addBuff(a, { until: t + m.onHitSelf.dur, speedMul: m.onHitSelf.speedMul });
      if (firstOfShot && m.everyN && ++as.shots % m.everyN.n === 0) {
        const c = m.everyN.chain, ctx = { target: v, x: v.x, z: v.z, dx: 1, dz: 0 };
        let cur = v, amt = c.amt * scale(a); const seen = new Set([v]);
        for (let i = 0; i < c.bounces; i++) {
          const nb = enemiesIn(a, cur.x, cur.z, c.jump, 'both', true).find(o => !seen.has(o));
          if (!nb) break; seen.add(nb); hurt(a, nb, amt); cur = nb; amt *= 0.8;
        }
        emit('ability', { unit: a, id, x: v.x, z: v.z, targets: [...seen], kind: 'chain', team: a.team, faction: r.faction, r: c.jump });
        void ctx;
      }
    }
    if (firstOfShot && as.charges && as.charges.n > 0) {
      const c = as.charges; c.n--;
      if (c.n <= 0) as.charges = null;
      for (const o of [v]) { hurt(a, o, (d.dmg || 0) * (c.mul - 1)); if (c.dot) addDot(o, a, c.dot.dps * scale(a), c.dot.dur, c.id); }
    }
    if (firstOfShot && r.impact?.zone) {
      const z = r.impact.zone;
      zones.push({ kind: 'slag', team: a.team, src: a, x: v.x, z: v.z, r: z.r, until: t + z.dur, dps: z.dps * scale(a), air: 'ground', next: t + 0.5 });
      emit('ability', { unit: a, id: 'impact', x: v.x, z: v.z, targets: [], kind: 'slag', team: a.team, faction: r.faction, r: z.r });
    }
    void newShot;
  });

  // ---------------------------------------------------------------- per-frame update
  function update(dtIn) {
    const t = now();
    const dt = typeof dtIn === 'number' && dtIn > 0 ? dtIn : Math.max(0, t - lastT);
    lastT = t;
    if (!(dt > 0)) return;
    // timers
    for (let i = timers.length - 1; i >= 0; i--) if (timers[i].at <= t) { const fn = timers[i].fn; timers.splice(i, 1); try { fn(); } catch (err) { console.warn('[abilities] timer', err); } }
    // reveals expire
    for (let i = reveals.length - 1; i >= 0; i--) if (reveals[i].until < t) reveals.splice(i, 1);
    // slides (knockback)
    for (let i = slides.length - 1; i >= 0; i--) {
      const s = slides[i], k = Math.min(dt, s.left);
      if (alive(s.e)) { s.e.x += s.vx * k; s.e.z += s.vz * k; }
      s.left -= k; if (s.left <= 1e-4) slides.splice(i, 1);
    }

    const units = [];
    for (const e of ents) if (e.isUnit && alive(e) && ROSTER[e.kind]) units.push(e);

    // pass 1: own passives & per-entity bookkeeping; collect aura contributions
    const mods = new Map();
    const M = (e) => { let m = mods.get(e); if (!m) { m = { armorAdd: 0, dpsMul: 1, rangeAdd: 0, rangeMul: 1, speedMul: 1, slowMul: 1, dmgMul: 1, hps: 0, root: false, stun: false }; mods.set(e, m); } return m; };
    for (const e of units) {
      const s = S(e), r = R(e), m = M(e);
      const mv = Math.hypot(e.x - s.px, e.z - s.pz);
      s.moving = mv > 0.05 * dt * (e.speed || 1); s.px = e.x; s.pz = e.z;
      s.stillT = s.moving ? 0 : s.stillT + dt;
      const ooc = (sec) => t - Math.max(s.lastHurt, s.lastFire) >= sec;
      for (const id of r.abilities) {
        const d = ABILITIES[id]; if (!d || d.type !== 'passive') continue;
        const p = d.mods;
        if (p.regen && ooc(p.regen.ooc)) m.hps += p.regen.hps;
        if (p.still && s.stillT >= p.still.after) { m.armorAdd += p.still.armorAdd || 0; m.rangeAdd += p.still.rangeAdd || 0; }
        if (p.near) { if (alliesIn(e, e.x, e.z, p.near.r).some(o => o !== e && o.cls === p.near.cls)) m.rangeAdd += p.near.rangeAdd || 0; }
        if (p.detect) reveals.push({ team: e.team, x: e.x, z: e.z, r: p.detect, until: t + 0.3, detect: true, passive: true });
        if (p.rootnet && e.burrowed) {
          let ok = false;
          for (const o of near(e.x, e.z, p.rootnet.r)) if (o.team === e.team && o.cls === 'bld' && !o.mine && alive(o)) { ok = true; break; }
          if (ok) m.speedMul *= p.rootnet.speedMul;
        }
        if (p.perAlly) { const n = Math.min(p.perAlly.max, alliesIn(e, e.x, e.z, p.perAlly.r, false).filter(o => o !== e && o.kind === p.perAlly.kind).length); m.dpsMul *= 1 + p.perAlly.dps * n; }
        if (p.healthy && e.hp / e.hpMax > p.healthy.above) m.dpsMul *= p.healthy.dpsMul;
        if (p.moving && s.moving) m.dmgMul *= p.moving.dmgMul;
        if (p.oocSpeed && ooc(p.oocSpeed.ooc)) m.speedMul *= p.oocSpeed.mul;
        if (p.aura) {
          const a = p.aura;
          const list = a.who === 'enemies' ? enemiesIn(e, e.x, e.z, a.r, 'ground', true) : alliesIn(e, e.x, e.z, a.r);
          for (const o of list) {
            if (a.cls && o.cls !== a.cls) continue;
            if (!ROSTER[o.kind] && a.who !== 'enemies') continue;
            const om = M(o);
            if (a.hps) om.hps += a.hps;
            if (a.slowMul) om.slowMul = Math.min(om.slowMul, a.slowMul);
          }
        }
      }
      // burrow timeout
      if (e.burrowed && s.burrowUntil && t >= s.burrowUntil) { e.burrowed = false; s.burrowUntil = 0; emit('ability', { unit: e, id: 'surface', x: e.x, z: e.z, targets: [], kind: 'surface', team: e.team, faction: r.faction, r: 0 }); }
    }
    // zones
    for (let i = zones.length - 1; i >= 0; i--) {
      const z = zones[i];
      if (z.until < t) { zones.splice(i, 1); continue; }
      const src = alive(z.src) ? z.src : { team: z.team, x: z.x, z: z.z, r: 0, kind: '_zone' };
      const tick = z.next <= t;
      if (tick) z.next = t + 0.5;
      for (const o of enemiesIn(src, z.x, z.z, z.r, z.air)) {
        const atk = alive(z.src) ? z.src : null;
        if (!o.isUnit) { if (tick && z.dps) hurt(atk, o, z.dps * 0.5); continue; }
        const om = M(o);
        if (z.slow) om.slowMul = Math.min(om.slowMul, z.slow);
        if (z.rangeMul) om.rangeMul = Math.min(om.rangeMul, z.rangeMul);
        if (tick && z.dps) hurt(atk, o, z.dps * 0.5);
      }
    }
    // mines
    for (let i = mines.length - 1; i >= 0; i--) {
      const o = mines[i];
      if (!alive(o)) { mines.splice(i, 1); continue; }
      if (o.armedAt > t) continue;
      const lay = { team: o.team, x: o.x, z: o.z, r: 0, kind: 'vanguard_mine' };
      if (o.claymore) {
        const c = o.claymore, ctx = { x: o.x, z: o.z, dx: c.dx, dz: c.dz };
        const f = { shape: 'cone', len: c.trig, arc: c.arc };
        const trig = enemiesIn(lay, o.x, o.z, c.trig + 2, 'ground', true).filter(v => !v.burrowed && inShape(o, f, ctx, v));
        if (trig.length) {
          const ff = { shape: 'cone', len: c.len, arc: c.arc };
          for (const v of enemiesIn(lay, o.x, o.z, c.len + 2, 'ground').filter(v => inShape(o, ff, ctx, v))) hurt(alive(o.layer) ? o.layer : null, v, c.amt);
          killMine(o);
        }
      } else {
        const trig = enemiesIn(lay, o.x, o.z, (ROSTER.vanguard_mine.trigger || 2.5), 'ground', true).filter(v => !v.burrowed);
        if (trig.length) {
          for (const v of enemiesIn(lay, o.x, o.z, 2.5, 'ground')) {
            hurt(alive(o.layer) ? o.layer : null, v, o.mineDmg || 160);
            if (o.mineSlow && v.isUnit) addBuff(v, { until: t + (o.mineSlowDur || 2), slowMul: o.mineSlow });
          }
          killMine(o);
        }
      }
    }

    // pass 2: buffs, dots, hots, dashes, pending casts, stat/status writes
    for (const e of units) {
      const s = S(e), m = M(e);
      for (let i = s.buffs.length - 1; i >= 0; i--) {
        const b = s.buffs[i];
        if (b.until < t) { s.buffs.splice(i, 1); continue; }
        if (b.dmgMul != null) m.dmgMul *= b.dmgMul;
        if (b.speedMul != null) m.speedMul = Math.max(m.speedMul, b.speedMul);
        if (b.slowMul != null) m.slowMul = Math.min(m.slowMul, b.slowMul);
        if (b.dpsMul != null) m.dpsMul *= b.dpsMul;
        if (b.rangeAdd) m.rangeAdd += b.rangeAdd;
        if (b.armorAdd) m.armorAdd += b.armorAdd;
        if (b.root) m.root = Math.max(m.root || 0, b.until);
        if (b.stun) m.stun = Math.max(m.stun || 0, b.until);
      }
      for (let i = s.dots.length - 1; i >= 0; i--) {
        const d = s.dots[i];
        if (d.next <= t) { d.next += 0.5; hurt(alive(d.src) ? d.src : null, e, d.dps * 0.5); }
        if (d.until <= t || !alive(e)) s.dots.splice(i, 1);
      }
      if (!alive(e)) continue;
      for (let i = s.hots.length - 1; i >= 0; i--) { const h = s.hots[i]; if (h.until < t) { s.hots.splice(i, 1); continue; } m.hps += h.hps; }
      if (m.hps > 0 && e.hp < e.hpMax) e.hp = Math.min(e.hpMax, e.hp + m.hps * dt);
      // dash
      if (s.dash) {
        const D2 = s.dash; D2.t += dt;
        const k = Math.min(1, D2.t / D2.dur);
        e.x = D2.x0 + (D2.x1 - D2.x0) * k; e.z = D2.z0 + (D2.z1 - D2.z0) * k;
        m.root = Math.max(m.root || 0, t + 0.05);
        if (k >= 1) {
          s.dash = null;
          const h = D2.hit;
          if (h) {
            const hits = [];
            for (const o of enemiesIn(e, e.x, e.z, h.r || 2.5, h.air || 'ground')) {
              hurt(e, o, (h.amt || 0) * scale(e)); if (h.stun) stun(o, h.stun); if (h.knock) knock(o, e.x, e.z, h.knock); hits.push(o);
            }
            emit('ability', { unit: e, id: D2.def.id, x: e.x, z: e.z, targets: hits, kind: 'impact', team: e.team, faction: R(e)?.faction, r: h.r || 2.5 });
          }
        }
      }
      // stats
      const b = s.base;
      const armor = clamp(b.armor + m.armorAdd, 0, 0.9);
      if (e.armor !== armor) e.armor = armor;
      e.dps = b.dps * m.dpsMul;
      e.range = Math.max(0, (b.range + m.rangeAdd) * m.rangeMul);
      writeStatus(e, s, m, t);
      // pending (out-of-range) casts
      if (s.pending) {
        const p = s.pending, def = ABILITIES[p.id];
        if (p.until < t || !canCast(e, p.id) || (p.target.id !== undefined && !alive(p.target))) s.pending = null;
        else if (Math.hypot(p.target.x - e.x, p.target.z - e.z) - (p.target.r || 0) <= rangeOf(e, def)) {
          s.pending = null; execute(e, def, p.target); e.state = 'idle'; e.dest = null;
        }
      }
    }

    // autocast think (staggered)
    thinkAcc += dt;
    for (const e of units) {
      const s = S(e);
      if ((s.nextThink -= dt) > 0) continue;
      s.nextThink = 0.4;
      if (s.pending || s.dash || isStunned(e)) continue;
      const isAI = e.team !== P();
      for (const id of R(e).abilities) {
        const def = ABILITIES[id];
        if (!def || def.type !== 'active') continue;
        if (!(isAI || (s.auto[id] ?? !!def.auto))) continue;
        if (!canCast(e, id)) continue;
        const tg = aiPick(e, def, false);
        if (!tg) continue;
        if (def.target !== 'self') {
          const p = posOf(tg); if (!p) continue;
          if (Math.hypot(p.x - e.x, p.z - e.z) - (tg.r || 0) > rangeOf(e, def) + 0.5) continue;
        }
        execute(e, def, def.target === 'self' ? null : tg);
        break; // one cast per think
      }
    }
    // forget dead
    if (st.size > units.length + 64) for (const k of st.keys()) if (!alive(k)) st.delete(k);
  }

  function writeStatus(e, s, m, t) {
    const cur = e.status;
    if (cur !== s.lastObj) s.foreign = cur ? { rooted: cur.rooted, stunned: cur.stunned, dmgMul: cur.dmgMul, until: cur.until } : null;
    const f = s.foreign && (s.foreign.until == null || s.foreign.until > t) ? s.foreign : null;
    if (!f) s.foreign = null;
    const immune = s.immuneUntil > t;
    const mine = m.root || m.stun || m.dmgMul !== 1 || m.slowMul !== 1 || m.speedMul !== 1 || m.rangeMul !== 1 || immune;
    if (!mine && !f) { if (cur && cur === s.lastObj) e.status = null; s.lastObj = null; return; }
    if (!mine && f) { if (cur === s.lastObj && s.lastObj) { e.status = { ...f }; s.lastObj = e.status; s.foreign = f; } return; }
    const ts = (v) => v === true ? t + 1 : typeof v === 'number' ? v : 0;
    let stunned = Math.max(ts(f?.stunned), m.stun || 0);
    if (immune) stunned = 0;
    const rooted = Math.max(ts(f?.rooted), m.root || 0);
    const obj = {
      rooted: rooted > t ? rooted : false, stunned: stunned > t ? stunned : false,
      dmgMul: (f?.dmgMul ?? 1) * m.dmgMul, slowMul: m.slowMul, speedMul: m.speedMul, rangeMul: m.rangeMul,
      until: Math.max(f?.until ?? 0, t + 0.35, rooted, stunned),
    };
    e.status = obj; s.lastObj = obj;
  }

  const api = {
    ABILITIES, cast, update, defsFor, ready, canCast, isDetected, zones, reveals, mines,
    cooldown(e, id) { const d = ABILITIES[id]; return { left: Math.max(0, (S(e).cd[id] ?? 0) - now()), total: d?.cd || 0 }; },
    autocast(e, id) { const d = ABILITIES[id]; return e.team !== P() || (S(e).auto[id] ?? !!d?.auto); },
    setAutocast(e, id, on) { S(e).auto[id] = !!on; },
    bestTarget: (e, id, relaxed) => aiPick(e, ABILITIES[id], relaxed),
    stateOf: S,
  };
  world.abilities = api;
  return api;
}
