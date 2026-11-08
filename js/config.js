// Vanguard — all tunables. Single source of truth (owner: SIM).
// Pacing math (see CONTRACT "Pacing"):
//  - Harvester trip: gather 14s + deposit 2s + ~2x4.5s travel at speed 4 ≈ 25s → +40 crystals ≈ 96/min each.
//  - Enemy: harvester income + trickle (base + growth per minute) → ~8k crystals over 30 min.
//  - Waves every 90s from 4:00, size grows ~1 unit / 2.5 min; supply cap 40 limits both sides.
//  - CCs are 8000hp so a match lands in the 30–40 min window.

export const CONFIG = {
  // ---- Units ------------------------------------------------------------
  // dps = base damage per second; each shot deals dps * cooldown * RPS multiplier.
  units: {
    warden:    { hp: 110, speed: 4.5, range: 10, dps: 11, cooldown: 1.1, cost: 60,  buildTime: 20, supply: 1, r: 1.2, cls: 'inf', light: false },
    raider:    { hp: 200, speed: 8.5, range: 8,  dps: 14, cooldown: 0.25, cost: 90, buildTime: 25, supply: 2, r: 1.6, cls: 'veh', light: true },
    tank:      { hp: 520, speed: 4.0, range: 13, dps: 22, cooldown: 2.0, cost: 200, buildTime: 45, supply: 4, r: 2.2, cls: 'veh', light: false },
    harvester: { hp: 320, speed: 4.0, range: 0,  dps: 0,  cooldown: 0,   cost: 100, buildTime: 40, supply: 2, r: 2.0, cls: 'veh', light: false },
  },

  // ---- Buildings (player-side production + neutral crystal) ---------------
  buildings: {
    cc:       { hp: 8000, r: 8, cls: 'bld', produces: [] },
    barracks: { hp: 1800, r: 5, cls: 'bld', produces: ['warden', 'raider'] },
    factory:  { hp: 2200, r: 5, cls: 'bld', produces: ['tank', 'harvester'] },
    crystal:  { hp: 1, r: 1.8, blockR: 1.1, cls: 'neutral', amount: 2400 }, // blockR: movement footprint (smaller than visual)
  },

  // Default stats for defense-owned kinds (defense.js may override via spawn overrides).
  defenses: {
    turret_mg:     { hp: 650,  r: 1.5, cls: 'bld', range: 14, dps: 16, cooldown: 0.2 },
    turret_cannon: { hp: 850,  r: 1.5, cls: 'bld', range: 16, dps: 26, cooldown: 2.5 },
    artillery:     { hp: 700,  r: 1.8, cls: 'bld', range: 32, dps: 20, cooldown: 4.0, splash: 6, minRange: 6 },
    wall:          { hp: 1400, r: 2.0, cls: 'bld', range: 0,  dps: 0,  cooldown: 0 },
    gate:          { hp: 2000, r: 2.5, cls: 'bld', range: 0,  dps: 0,  cooldown: 0 },
  },

  // ---- RPS multipliers: attacker kind → victim class --------------------
  rps: {
    warden:        { inf: 0.6, veh: 1.8, bld: 1.0 },
    tank:          { inf: 0.8, veh: 0.6, bld: 1.6, light: 1.8 },
    raider:        { inf: 1.8, veh: 0.5, bld: 0.4 },
    turret_mg:     { inf: 1.8, veh: 0.5, bld: 0 },
    turret_cannon: { inf: 0.6, veh: 1.8, bld: 0 },
    artillery:     { inf: 1.2, veh: 1.2, bld: 0.8 },
  },
  rpsDefault: { inf: 1, veh: 1, bld: 1 },

  // Gun heights for `shot` events.
  gunY: { inf: 1.2, veh: 1.8, bld: 3 },

  // ---- Economy ----------------------------------------------------------
  economy: {
    startCrystals: 400,
    enemyStartCrystals: 200,
    harvesterCarry: 40,
    gatherTime: 16,       // seconds at the crystal
    depositTime: 2,       // seconds at the cc
    tripTarget: 25,       // documentation: intended full round-trip
    idleHarvesterRestart: 3, // seconds a manually-moved harvester idles before auto-resuming
  },
  supplyCap: 40,
  queueMax: 5,

  // ---- Pacing -----------------------------------------------------------
  pacing: {
    matchTargetMin: [30, 40],
    waveInterval: 90,       // s
    firstWave: 240,         // s grace before first wave
    waveBase: 2,            // units in first wave
    waveGrowthPer: 150,     // +1 unit every N seconds of match time
    waveMax: 30,
    enemyTrickleBase: 30,   // crystals/min at t=0
    enemyTrickleGrowth: 12, // +crystals/min per minute elapsed
    enemyMaxQueued: 2,      // enemy keeps ≤N items queued per building (leaves cash for defense tiers)
    enemyReserve: 150,      // enemy keeps this banked for defense tiers (world.defense.enemyReserve overrides)
    enemyHarvesters: 3,
    enemySecondHarvesterAt: 100, // s
    enemyThirdHarvesterAt: 300,  // s
    enemyMinArmy: 6,        // below this many combat units the enemy doesn't bank for defense tiers
    enemyMix: { warden: 3, raider: 2, tank: 1 },
    counterWeight: 2.5,     // how hard the enemy skews toward counters of the player's army
  },

  dayNight: { cycle: 480, nightTurretRangeMul: 0.8 }, // 8 min full cycle

  // ---- AI ranges --------------------------------------------------------
  aggro: {
    unit: 14,          // idle auto-acquire radius
    moving: 12,        // aggressive (attack-move) acquire radius
    leash: 26,         // auto-acquired targets dropped beyond this
    scanInterval: 0.3, // s between target scans per unit
    bldPenalty: 6,     // prefer units over buildings when scoring targets
  },

  map: {
    playerBase: { x: -55, z: 25 },
    enemyBase: { x: 55, z: -25 },
    playerBarracks: { x: -45, z: 35 }, playerFactory: { x: -45, z: 15 },
    playerField: { x: -35, z: 25 }, enemyField: { x: 35, z: -25 }, centerField: { x: 0, z: 0 },
    fieldSpread: 4,
    rallyOffset: 4,
  },
};
