// Vanguard — faction rosters (owner: ROSTER). Single source of truth for non-hero unit stats.
// sim reads ROSTER[kind] before CONFIG.units. Ability definitions live in abilities.js (ids listed here).
//
// Stat fields: faction, role ('infantry'|'light'|'heavy'|'harvester'|'special'|'air'|'aa'), name,
// cost: {primary, secondary} (ECONOMY v3: units cost PRIMARY; elite/air units also a little SECONDARY),
// value (= primary + 1.5 x secondary, used for equal-cost balance), crew (supply needed to man a crewed weapon;
// already included in supply), buildTime,
// building ('barracks'|'factory'|'airfield'; airfield === factory until an airfield exists), supply, hp,
// armor (flat fraction of incoming damage removed, 0..0.9), speed, sight, range, minRange, dps, cooldown, splash,
// r, cls ('inf'|'veh'), light, air, canHitAir, canHitGround, vs (RPS multipliers by victim: inf/veh/bld/light/air;
// a victim with air:true uses vs.air — 0/absent means "can't hit"), abilities: [4 ids].
// Static passives (e.g. Magma Coat's 45% armor) are ALREADY folded into the base stats below; abilities.js only
// adds conditional/temporary modifiers on top.
//
// Balance: TUNING (written by tools/balance.mjs --write) scales hp and dps by sqrt(power) per faction and per
// unit, so a power of 1.10 ≈ +10% fight strength. Ability damage scales with the same dps factor (abilityMul).
//
// projectile: basic-attack visual ('arrow'|'spear'|'minimissile'|'ironball'|'bullet'|'laser'|'lightning'|'slug');
// sim should put it in `shot` events. impact.zone: a burning patch left where this unit's basic shot lands.
// TODO.md: none — summons (storm_dustdevil) are trainable:false and carry no abilities.

export const FACTIONS = {
  vanguard: { name: 'Vanguard', color: 0x2fb8ff, units: ['vanguard_trooper', 'vanguard_apc', 'vanguard_tank', 'vanguard_harvester', 'vanguard_sapper', 'vanguard_flak'] },
  volcanic: { name: 'Volcanic Clans', color: 0xff5a12, units: ['volcanic_brute', 'volcanic_scorcher', 'volcanic_juggernaut', 'volcanic_harvester', 'volcanic_mortar', 'volcanic_ashcannon'] },
  earth:    { name: 'Earth Cult', color: 0x5fd35f, units: ['earth_acolyte', 'earth_strider', 'earth_sunwing', 'earth_harvester', 'earth_burrower', 'earth_glider'] },
  storm:    { name: 'Storm Nomads', color: 0xe8d27a, units: ['storm_skirmisher', 'storm_yacht', 'storm_cruiser', 'storm_harvester', 'storm_caller', 'storm_kite'] },
};

const B = {
  // ---------------------------------------------------------------- VANGUARD: industrial all-rounder
  vanguard_trooper: { faction: 'vanguard', role: 'infantry', name: 'Ironjacket Trooper', cost: { primary: 70, secondary: 0 }, buildTime: 20, building: 'barracks', supply: 1,
    hp: 140, armor: 0.15, speed: 7.2, sight: 18, range: 10, dps: 9, cooldown: 1.4, splash: 3, r: 1.2, cls: 'inf', projectile: 'minimissile',
    canHitAir: true, vs: { inf: 0.9, veh: 1.3, bld: 1.0, light: 1.2, air: 1.0 },
    abilities: ['vg_frag', 'vg_digin', 'vg_flare', 'vg_brace'], blurb: 'Plate-armored trooper with a shoulder mini-missile pod (splash).' },
  vanguard_apc: { faction: 'vanguard', role: 'light', name: 'Bulldog APC', cost: { primary: 100, secondary: 0 }, buildTime: 24, building: 'barracks', supply: 2,
    hp: 240, armor: 0.2, speed: 11.5, sight: 22, range: 10, dps: 11, cooldown: 1.2, splash: 3, r: 1.7, cls: 'veh', light: true, projectile: 'minimissile',
    vs: { inf: 1.5, veh: 0.7, bld: 0.5, light: 1.0 },
    abilities: ['vg_smoke', 'vg_ram', 'vg_overdrive', 'vg_repairrig'], blurb: 'Six-wheeled carrier with a mini-rocket salvo rack.' },
  vanguard_tank: { faction: 'vanguard', role: 'heavy', name: 'Anvil Heavy Tank', cost: { primary: 220, secondary: 20 }, buildTime: 45, building: 'factory', supply: 4,
    hp: 560, armor: 0.3, speed: 5.8, sight: 22, range: 13, dps: 22, cooldown: 2.0, r: 2.3, cls: 'veh', projectile: 'slug',
    vs: { inf: 0.9, veh: 1.4, bld: 1.6, light: 1.2 },
    abilities: ['vg_hullbrace', 'vg_apslug', 'vg_plating', 'vg_spotter'], blurb: 'Direct-fire slug-cannon tank; braces into a pillbox.' },
  vanguard_harvester: { faction: 'vanguard', role: 'harvester', name: 'Crawler Hauler', cost: { primary: 100, secondary: 0 }, buildTime: 40, building: 'factory', supply: 2,
    hp: 380, armor: 0.25, speed: 7, sight: 14, range: 0, dps: 0, cooldown: 0, r: 2.0, cls: 'veh', harvester: true,
    abilities: ['vg_hv_plating', 'vg_hv_boost', 'vg_hv_beacon', 'vg_hv_frame'], blurb: 'Tracked ore crawler.' },
  vanguard_sapper: { faction: 'vanguard', role: 'special', name: 'Sapper Crew', cost: { primary: 120, secondary: 10 }, buildTime: 26, building: 'barracks', supply: 2,
    hp: 150, armor: 0.2, speed: 7.2, sight: 20, range: 8, dps: 9, cooldown: 0.8, r: 1.3, cls: 'inf', projectile: 'bullet',
    vs: { inf: 1.2, veh: 0.9, bld: 1.5, light: 1.0 },
    abilities: ['vg_minefield', 'vg_claymore', 'vg_demo', 'vg_minesweep'], blurb: 'Combat engineers: minefields, claymores, demolition. Area denial.' },
  vanguard_flak: { faction: 'vanguard', role: 'aa', name: 'Skyguard Flak Truck', cost: { primary: 130, secondary: 10 }, buildTime: 30, building: 'factory', supply: 2,
    hp: 320, armor: 0.2, speed: 8, sight: 26, range: 16, dps: 20, cooldown: 0.5, r: 1.9, cls: 'veh', projectile: 'bullet',
    canHitAir: true, vs: { inf: 0.5, veh: 0.35, bld: 0.2, light: 0.5, air: 2.2 },
    abilities: ['vg_flakburst', 'vg_radar', 'vg_struts', 'vg_tracking'], blurb: 'Twin-autocannon flak truck.' },

  // ---------------------------------------------------------------- VOLCANIC: sturdiest tanks, slow, no air
  volcanic_brute: { faction: 'volcanic', role: 'infantry', name: 'Cinder Brute', cost: { primary: 65, secondary: 0 }, buildTime: 20, building: 'barracks', supply: 1,
    hp: 120, armor: 0.15, speed: 6.4, sight: 14, range: 7, dps: 12, cooldown: 0.9, r: 1.3, cls: 'inf', projectile: 'slug',
    vs: { inf: 1.3, veh: 1.1, bld: 1.2, light: 1.2 },
    abilities: ['vc_flameburst', 'vc_emberrush', 'vc_ignite', 'vc_moltenskin'], blurb: 'Basalt-skinned flamer brute.' },
  volcanic_scorcher: { faction: 'volcanic', role: 'light', name: 'Scorch Crawler', cost: { primary: 100, secondary: 0 }, buildTime: 24, building: 'barracks', supply: 2,
    hp: 240, armor: 0.25, speed: 9, sight: 16, range: 7, dps: 13, cooldown: 0.3, r: 1.7, cls: 'veh', light: true, projectile: 'slug',
    vs: { inf: 1.6, veh: 0.7, bld: 0.6, light: 1.1 },
    abilities: ['vc_napalm', 'vc_oilslick', 'vc_heathaze', 'vc_ignite'], blurb: 'Armored flamethrower crawler.' },
  volcanic_juggernaut: { faction: 'volcanic', role: 'heavy', name: 'Magma Juggernaut', cost: { primary: 260, secondary: 30 }, buildTime: 55, building: 'factory', supply: 5,
    hp: 760, armor: 0.45, speed: 4.8, sight: 16, range: 11, dps: 20, cooldown: 2.0, r: 2.6, cls: 'veh', projectile: 'slug',
    vs: { inf: 0.9, veh: 1.3, bld: 1.6, light: 1.2 },
    abilities: ['vc_magmacoat', 'vc_moltenram', 'vc_slagspray', 'vc_crust'], blurb: 'Magma-coated super-heavy; the toughest hull in the field.' },
  volcanic_harvester: { faction: 'volcanic', role: 'harvester', name: 'Slag Hauler', cost: { primary: 100, secondary: 0 }, buildTime: 40, building: 'factory', supply: 2,
    hp: 420, armor: 0.3, speed: 6.6, sight: 12, range: 0, dps: 0, cooldown: 0, r: 2.0, cls: 'veh', harvester: true,
    abilities: ['vc_hv_vent', 'vc_hv_harden', 'vc_hv_lavatrail', 'vc_moltenskin'], blurb: 'Slag-plated ore hauler.' },
  volcanic_mortar: { faction: 'volcanic', role: 'special', name: 'Crucible Siege Mortar', cost: { primary: 190, secondary: 25 }, buildTime: 45, building: 'factory', supply: 4, crew: 4,
    hp: 360, armor: 0.3, speed: 4.2, sight: 14, range: 24, minRange: 6, dps: 14, cooldown: 4.0, splash: 5, r: 2.3, cls: 'veh', projectile: 'ironball',
    impact: { zone: { r: 3, dps: 10, dur: 3 } },
    vs: { inf: 1.2, veh: 1.0, bld: 1.6, light: 1.0 },
    abilities: ['vc_slagshell', 'vc_ricochet', 'vc_bracing', 'vc_redhot'], blurb: 'Siege mortar lobbing molten iron balls; splash leaves burning slag. The only true artillery.' },
  volcanic_ashcannon: { faction: 'volcanic', role: 'aa', name: 'Ash Cannon', cost: { primary: 130, secondary: 10 }, buildTime: 30, building: 'factory', supply: 3, crew: 3,
    hp: 380, armor: 0.3, speed: 5.6, sight: 14, range: 15, dps: 20, cooldown: 0.8, r: 2.0, cls: 'veh', projectile: 'bullet',
    canHitAir: true, vs: { inf: 0.4, veh: 0.35, bld: 0.2, light: 0.4, air: 2.3 },
    abilities: ['vc_ashcloud', 'vc_shrapnel', 'vc_anchor', 'vc_moltenskin'], blurb: 'Pumice flak mortar; the Clans\' only answer to the sky.' },

  // ---------------------------------------------------------------- EARTH: strongest air, burrower, healing
  earth_acolyte: { faction: 'earth', role: 'infantry', name: 'Grove Archer', cost: { primary: 55, secondary: 0 }, buildTime: 18, building: 'barracks', supply: 1,
    hp: 95, armor: 0, speed: 7.6, sight: 20, range: 12, dps: 11, cooldown: 1.1, r: 1.1, cls: 'inf', projectile: 'arrow',
    canHitAir: true, vs: { inf: 1.2, veh: 0.7, bld: 0.8, light: 0.9, air: 0.9 },
    abilities: ['ea_mend', 'ea_monsoon', 'ea_photosynth', 'ea_thornshot'], blurb: 'Longbow archer-priest; heals and calls monsoon rain.' },
  earth_strider: { faction: 'earth', role: 'light', name: 'Thornback Lancer', cost: { primary: 95, secondary: 0 }, buildTime: 24, building: 'barracks', supply: 2,
    hp: 220, armor: 0.05, speed: 11.5, sight: 22, range: 11, dps: 14, cooldown: 1.0, r: 1.6, cls: 'veh', light: true, projectile: 'spear',
    vs: { inf: 1.5, veh: 0.6, bld: 0.4, light: 1.1 },
    abilities: ['ea_pounce', 'ea_piercespear', 'ea_flashflood', 'ea_barkskin'], blurb: 'War beast with a spear-thrower rider; spears pierce in a line.' },
  earth_sunwing: { faction: 'earth', role: 'heavy', name: 'Sunwing', cost: { primary: 240, secondary: 40 }, buildTime: 50, building: ['factory', 'airfield'], supply: 4,
    hp: 560, armor: 0.15, speed: 10, sight: 30, range: 12, dps: 26, cooldown: 1.5, r: 2.4, cls: 'veh', air: true, projectile: 'laser',
    canHitAir: true, vs: { inf: 1.2, veh: 1.15, bld: 1.0, light: 1.1, air: 1.5 },
    abilities: ['ea_solarbeam', 'ea_dive', 'ea_plumage', 'ea_sunburst'], blurb: 'Great golden flyer; the Cult\'s heavy.' },
  earth_harvester: { faction: 'earth', role: 'harvester', name: 'Rootback Gatherer', cost: { primary: 100, secondary: 0 }, buildTime: 40, building: 'factory', supply: 2,
    hp: 280, armor: 0.05, speed: 7.2, sight: 14, range: 0, dps: 0, cooldown: 0, r: 2.0, cls: 'veh', harvester: true,
    abilities: ['ea_hv_burrow', 'ea_hv_surface', 'ea_hv_rootshield', 'ea_photosynth'], blurb: 'Burrowing beast of burden.' },
  earth_burrower: { faction: 'earth', role: 'special', name: 'Deepmaw Burrower', cost: { primary: 160, secondary: 20 }, buildTime: 40, building: 'factory', supply: 3,
    hp: 340, armor: 0.15, speed: 8, sight: 18, range: 6, dps: 18, cooldown: 1.0, r: 1.9, cls: 'veh', projectile: 'spear',
    vs: { inf: 1.3, veh: 0.9, bld: 1.1, light: 1.1 },
    abilities: ['ea_burrow', 'ea_erupt', 'ea_tremor', 'ea_rootnet'], blurb: 'Tunnels hidden under the battlefield and erupts beneath foes.' },
  earth_glider: { faction: 'earth', role: 'air', name: 'Dawnglider Flock', cost: { primary: 80, secondary: 10 }, buildTime: 22, building: ['factory', 'airfield'], supply: 2,
    hp: 130, armor: 0, speed: 14, sight: 24, range: 9, dps: 13, cooldown: 0.5, r: 1.4, cls: 'veh', air: true, light: true, projectile: 'arrow',
    canHitAir: true, vs: { inf: 1.3, veh: 0.6, bld: 0.5, light: 1.0, air: 1.5 },
    abilities: ['ea_swoop', 'ea_updraft', 'ea_featherstorm', 'ea_flock'], blurb: 'Swarm of feathered gliders.' },

  // ---------------------------------------------------------------- STORM: quickest, hit-and-run, lightning
  storm_skirmisher: { faction: 'storm', role: 'infantry', name: 'Gale Skirmisher', cost: { primary: 55, secondary: 0 }, buildTime: 16, building: 'barracks', supply: 1,
    hp: 85, armor: 0, speed: 10.5, sight: 20, range: 10, dps: 14, cooldown: 0.8, r: 1.1, cls: 'inf', projectile: 'lightning',
    canHitAir: true, vs: { inf: 1.1, veh: 1.1, bld: 0.7, light: 1.1, air: 0.9 },
    abilities: ['st_tailwind', 'st_javelin', 'st_static', 'st_windstep'], blurb: 'Wind-runner with shock javelins.' },
  storm_yacht: { faction: 'storm', role: 'light', name: 'Dune Yacht', cost: { primary: 85, secondary: 0 }, buildTime: 20, building: 'barracks', supply: 2,
    hp: 180, armor: 0, speed: 18, sight: 24, range: 9, dps: 18, cooldown: 0.25, r: 1.6, cls: 'veh', light: true, projectile: 'bullet',
    vs: { inf: 1.6, veh: 0.7, bld: 0.4, light: 1.2 },
    abilities: ['st_fullsail', 'st_arclance', 'st_hitrun', 'st_jib'], blurb: 'Sail-driven land-yacht; fastest thing on wheels.' },
  storm_cruiser: { faction: 'storm', role: 'heavy', name: 'Thunderhead Sail-Cruiser', cost: { primary: 200, secondary: 20 }, buildTime: 40, building: 'factory', supply: 4,
    hp: 440, armor: 0.1, speed: 13, sight: 24, range: 14, dps: 26, cooldown: 1.2, r: 2.2, cls: 'veh', projectile: 'lightning',
    canHitAir: true, vs: { inf: 1.0, veh: 1.3, bld: 0.9, light: 1.1, air: 0.6 },
    abilities: ['st_chain', 'st_stormfront', 'st_capacitor', 'st_gustram'], blurb: 'Tri-mast lightning cruiser.' },
  storm_harvester: { faction: 'storm', role: 'harvester', name: 'Sand Skimmer', cost: { primary: 100, secondary: 0 }, buildTime: 36, building: 'factory', supply: 2,
    hp: 240, armor: 0, speed: 8, sight: 16, range: 0, dps: 0, cooldown: 0, r: 2.0, cls: 'veh', harvester: true,
    abilities: ['st_hv_sail', 'st_hv_static', 'st_hv_mirage', 'st_hv_featherweight'], blurb: 'Sail-skimmer ore runner.' },
  storm_caller: { faction: 'storm', role: 'special', name: 'Tempest Caller', cost: { primary: 130, secondary: 15 }, buildTime: 28, building: 'barracks', supply: 2,
    hp: 130, armor: 0, speed: 9, sight: 22, range: 14, dps: 12, cooldown: 1.2, r: 1.2, cls: 'inf', projectile: 'lightning',
    canHitAir: true, vs: { inf: 1.0, veh: 1.0, bld: 0.6, light: 1.0, air: 1.0 },
    abilities: ['st_lstorm', 'st_overcharge', 'st_dustdevil', 'st_staticfield'], blurb: 'Storm shaman; calls lightning and dust devils.' },
  storm_kite: { faction: 'storm', role: 'air', name: 'Kitewing Skyraider', cost: { primary: 110, secondary: 15 }, buildTime: 26, building: ['factory', 'airfield'], supply: 2,
    hp: 160, armor: 0, speed: 16, sight: 26, range: 10, dps: 16, cooldown: 0.6, r: 1.5, cls: 'veh', air: true, light: true, projectile: 'lightning',
    canHitAir: true, vs: { inf: 1.2, veh: 1.0, bld: 0.6, light: 1.0, air: 1.0 },
    abilities: ['st_bolt', 'st_gust', 'st_jetstream', 'st_evasive'], blurb: 'Rider on a lightning kite.' },

  // ---------------------------------------------------------------- summons (not trainable)
  storm_dustdevil: { faction: 'storm', role: 'summon', name: 'Dust Devil', cost: { primary: 0, secondary: 0 }, buildTime: 0, building: null, supply: 0,
    hp: 110, armor: 0, speed: 15, sight: 14, range: 3, dps: 12, cooldown: 0.4, r: 1.2, cls: 'veh', light: true, projectile: 'lightning',
    vs: { inf: 1.2, veh: 0.8, bld: 0.3, light: 1.0 }, trainable: false, summon: true, abilities: [] },
  // Mine (laid by Sapper Crew). Not a unit: cls 'bld', non-blocking, stealthed from enemies unless detected.
  // abilities.js owns triggering (r 2.5, enemy ground units only; not air/burrowed). Cap 30 per team.
  vanguard_mine: { faction: 'vanguard', role: 'mine', name: 'AP Mine', cost: { primary: 0, secondary: 0 }, buildTime: 0, building: null, supply: 0,
    hp: 40, armor: 0, speed: 0, sight: 4, range: 0, dps: 0, cooldown: 0, r: 0.8, cls: 'bld', trainable: false, mine: true,
    noBlock: true, stealth: true, trigger: 2.5, mineDmg: 160, abilities: [] },
};

/*BEGIN TUNING*/
export const TUNING = {
  "faction": {
    "vanguard": 0.9873,
    "volcanic": 1.0091,
    "earth": 0.9668,
    "storm": 1.0382
  },
  "unit": {}
};
/*END TUNING*/

export const BASE = B;
// Total value of a cost for balance: primary + 1.5 x secondary.
export function costValue(c) { return typeof c === 'number' ? c : (c?.primary ?? 0) + 1.5 * (c?.secondary ?? 0); }
export const ROSTER = {};

// (Re)build ROSTER in place from BASE × tuning (balance.mjs calls this with candidate tunings).
export function applyTuning(t = TUNING) {
  for (const [kind, b] of Object.entries(B)) {
    const p = (t.faction?.[b.faction] ?? 1) * (t.unit?.[kind] ?? 1);
    const f = Math.sqrt(p);
    const e = ROSTER[kind] || (ROSTER[kind] = {});
    Object.assign(e, b, {
      kind,
      cost: { primary: b.cost?.primary ?? b.cost ?? 0, secondary: b.cost?.secondary ?? 0 },
      value: costValue(b.cost),
      crew: b.crew ?? 0,
      hp: Math.round(b.hp * (b.harvester ? 1 : f)),
      dps: +(b.dps * f).toFixed(2),
      abilityMul: f,
      power: p,
      light: !!b.light, air: !!b.air, canHitAir: !!b.canHitAir, canHitGround: b.canHitGround !== false,
      minRange: b.minRange ?? 0, splash: b.splash ?? 0, armor: b.armor ?? 0,
      trainable: b.trainable !== false,
      vs: b.vs ? { ...b.vs } : { inf: 1, veh: 1, bld: 1 },
      projectile: b.projectile || (b.dps ? 'bullet' : null),
      rps: null, // set below (sim reads ROSTER[kind].rps)
    });
    e.rps = e.vs;
  }
  return ROSTER;
}
applyTuning();

// RPS multiplier for attacker kind vs victim entity. null = attacker not in ROSTER (use CONFIG.rps).
// 0 = can't hit (ground-only vs air, or canHitGround:false vs ground).
export function rosterMul(attackerKind, victim) {
  const a = ROSTER[attackerKind];
  if (!a) return null;
  if (victim.air) return a.canHitAir ? (a.vs.air ?? 1) : 0;
  if (!a.canHitGround) return 0;
  if (victim.light && a.vs.light != null) return a.vs.light;
  return a.vs[victim.cls] ?? 1;
}

// Effective HP (armor folded in).
export const ehp = (k) => ROSTER[k].hp / (1 - ROSTER[k].armor);
export const unitsOf = (faction) => FACTIONS[faction]?.units || [];
export const roleOf = (faction, role) => unitsOf(faction).find(k => ROSTER[k].role === role) || null;
// What a production building can make for a faction (airfield units fall back to the factory).
export function producedBy(faction, building, hasAirfield = false) {
  return unitsOf(faction).filter(k => {
    const bl = [].concat(ROSTER[k].building || []);
    if (hasAirfield && bl.includes('airfield')) return building === 'airfield';
    return bl.includes(building);
  });
}
