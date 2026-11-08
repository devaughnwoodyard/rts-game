// Vanguard — all tunables. Single source of truth (owner: SIM).
// Pacing math (see CONTRACT "Pacing"):
//  - Harvester trip: gather 14s + deposit 2s + ~2x4.5s travel at speed 4 ≈ 25s → +40 crystals ≈ 96/min each.
//  - Enemy: harvester income + trickle (base + growth per minute) → ~8k crystals over 30 min.
//  - Waves every 90s from 4:00, size grows ~1 unit / 2.5 min; supply cap 40 limits both sides.
//  - CCs are 8000hp so a match lands in the 30–40 min window.
// v2 (10x map, 4 factions): unit speeds x1.6 so a 220u cross-quadrant wave takes ~30s; base field sits 25u from
// the cc (trip ~22s); center fields are 'rich' (x1.5 carry) to pay for the ~60s round trip. Supply cap 40/team and
// a global 160-unit cap keep 4 armies phone-sized. Match target 30–45 min.

export const CONFIG = {
  // ---- Units ------------------------------------------------------------
  // dps = base damage per second; each shot deals dps * cooldown * RPS multiplier.
  units: {
    warden:    { hp: 110, speed: 7.2, range: 10, dps: 11, cooldown: 1.1, cost: 60,  buildTime: 20, supply: 1, r: 1.2, cls: 'inf', light: false },
    raider:    { hp: 200, speed: 13.6, range: 8,  dps: 14, cooldown: 0.25, cost: 90, buildTime: 25, supply: 2, r: 1.6, cls: 'veh', light: true },
    tank:      { hp: 520, speed: 6.4, range: 13, dps: 22, cooldown: 2.0, cost: 200, buildTime: 45, supply: 4, r: 2.2, cls: 'veh', light: false },
    harvester: { hp: 320, speed: 6.4, range: 0,  dps: 0,  cooldown: 0,   cost: 100, buildTime: 40, supply: 2, r: 2.0, cls: 'veh', light: false },
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
    enemyStartCrystals: 300,
    harvesterCarry: 40,
    gatherTime: 16,       // seconds at the crystal
    depositTime: 2,       // seconds at the cc
    tripTarget: 25,       // documentation: intended full round-trip
    idleHarvesterRestart: 3, // seconds a manually-moved harvester idles before auto-resuming
    richMul: 1.5,         // carry multiplier at the contested center fields
  },
  // ---- ECONOMY v3 (owner: ECON — js/economy.js). Two currencies per faction, land plots, extractors, hauling.
  // Income math (per team): 1 primary extractor = 2.1/s = 126/min, 1 secondary = 0.75/s = 45/min, so the starting
  // 1+1 extractors give ~126/45 per min. Mid-game 3 primary + 2 secondary + 1 Aether (on secondary) ≈ 380/155; with
  // Aether on primary ≈ 510/90. A harvester (carry 60, load 5s, deposit 2s) on a base plot ~30u away hauls ~200/min,
  // so one hauler covers ~1.5 base extractors but only ~0.8 of a far center plot: expanding also needs haulers.
  // First 5 min: start 350/150 vs claim 60 sec + extractor 150 pri, housing 150 pri (+8 supply), units 55-260 pri,
  // walls/turrets/tech in secondary — you can't do all of it.
  econ: {
    start: { primary: 350, secondary: 150 },
    aiStart: { primary: 350, secondary: 150 },
    aiIncomeMul: 1.0,          // handicap knob for AI teams (multiplies extractor output)
    supply: { cc: 10, barracks: 10, housing: 8, bunkhouse: 8, max: 200 },
    crew: { turret_mg: 2, turret_cannon: 3, turret_aa: 2, aa: 2, artillery: 4, mortar: 4, siege: 6 },
    crewPrimary: 0,            // primary charged per crew member when a defense gets manned (0 = free)
    crewRetry: 1.0,            // s between attempts to man unmanned defenses
    claim: { secondary: 60, aetherSecondary: 100, time: 20, adj: 40 },  // adj = edge-to-edge distance rule
    plotR: 4.5,
    extractor: {
      primary:   { cost: 150, time: 35, rate: 2.1,  cap: 240, hp: 700, r: 2.6 },
      secondary: { cost: 120, time: 30, rate: 0.75, hp: 500, r: 2.2 },
      aether:    { cost: 200, time: 40, rate: 1.1,  cap: 240, hp: 800, r: 2.8 },
    },
    aetherMul: { primary: 2, secondary: 1 },     // raw Aether -> currency at the processor (player toggle)
    harvester: { carry: 60, load: 5, deposit: 2, ccFallbackMul: 0.5, minLoad: 20 },
    // Per-faction flavour (multipliers on the generic numbers above).
    mods: {
      vanguard: { claimTime: 1.25, hp: 1.3 },                        // slowest to expand, sturdy rigs
      volcanic: { pulse: 12 },                                       // Vent Taps release secondary in pulses
      earth:    { stages: 3, growTime: 1.3, stage2Out: 0.5 },        // groves grow in 3 visible stages
      storm:    { buildTime: 0.85, weatherPeriod: 150, weatherAmp: 0.5, stormBonus: 0.6 }, // rods surge in storms
    },
    names: {
      vanguard: { primary: 'Steel', secondary: 'Fuel', pIcon: '⚙', sIcon: '⛽', pColor: '#c9d3dc', sColor: '#ffb347',
        processor: 'Foundry', ext: { primary: 'Ore Mine', secondary: 'Oil Derrick', aether: 'Aether Drill' } },
      volcanic: { primary: 'Ore', secondary: 'Pressure', pIcon: '⬢', sIcon: '♨', pColor: '#ff8a4a', sColor: '#ffd0a0',
        processor: 'Smelter', ext: { primary: 'Ore Cutter', secondary: 'Vent Tap', aether: 'Aether Drill' } },
      earth:    { primary: 'Sunlight', secondary: 'Wind', pIcon: '☀', sIcon: '🌬', pColor: '#ffd56a', sColor: '#bff0c0',
        processor: 'Sun Altar', ext: { primary: 'Solar Grove', secondary: 'Turbine Tree', aether: 'Aether Bloom' } },
      storm:    { primary: 'Charge', secondary: 'Water', pIcon: '⚡', sIcon: '💧', pColor: '#9fe4ff', sColor: '#6fb8ff',
        processor: 'Capacitor Hall', ext: { primary: 'Lightning Rod', secondary: 'Dew Trap', aether: 'Aether Drill' } },
    },
    // Costs for everything that isn't a unit (units: roster `cost` = primary). BUILDER reads these via econ.cost(kind).
    costs: {
      hero:          { primary: 600, secondary: 200 },
      housing:       { primary: 150, time: 25, hp: 900, r: 3.2 },
      processor:     { primary: 300, secondary: 50, time: 40, hp: 2400, r: 4.2 },
      wall:          { secondary: 12 },          // per 4u segment
      wallWidenMul:  3,
      gate:          { secondary: 40 },
      turret_mg:     { secondary: 80 },
      turret_cannon: { secondary: 140 },
      turret_aa:     { secondary: 110 },
      artillery:     { secondary: 220 },
      siege:         { secondary: 450 },
      tech:          { secondary: 150 },         // default per tech unlock (BUILDER may price each)
    },
    // AI personalities: expansion pace (plots/min after the first), secondary budget split, primary kept for army.
    ai: {
      vanguard: { expandPerMin: 0.55, maxPlots: 10, budget: { expand: 0.35, defense: 0.45, tech: 0.20 }, army: 0.55, harvPerExt: 1.0 },
      volcanic: { expandPerMin: 0.65, maxPlots: 11, budget: { expand: 0.40, defense: 0.25, tech: 0.35 }, army: 0.70, harvPerExt: 1.0 },
      earth:    { expandPerMin: 0.85, maxPlots: 13, budget: { expand: 0.50, defense: 0.20, tech: 0.30 }, army: 0.50, harvPerExt: 1.1 },
      storm:    { expandPerMin: 0.95, maxPlots: 13, budget: { expand: 0.55, defense: 0.15, tech: 0.30 }, army: 0.65, harvPerExt: 0.9 },
    },
    // Plot layout. Base plots: polar (angle deg relative to the cc->center direction, radius) around each cc.
    // Center plots: positive "magnitude" coords in team 0's frame (fractions of half extents), mirrored per quadrant.
    layout: {
      base: [
        { a: 45, r: 30, res: 'primary', start: true }, { a: -45, r: 30, res: 'secondary', start: true },
        { a: 90, r: 30, res: 'secondary' }, { a: -90, r: 30, res: 'primary' },
        { a: 140, r: 30, res: 'primary' }, { a: -140, r: 30, res: 'secondary' },
        { a: 0, r: 50, res: 'primary' },
      ],
      frontier: [
        { fx: 125 / 256, fz: 62 / 160, res: 'primary' }, { fx: 100 / 256, fz: 35 / 160, res: 'secondary' },
        { fx: 55 / 256, fz: 20 / 160, res: 'primary' }, { fx: 28 / 256, fz: 10 / 160, res: 'secondary' },
      ],
    },
  },
  supplyCap: 40,          // legacy (pre-v3); live cap comes from econ.supplyCap(team)
  unitCap: 160,           // all teams combined (phone perf)
  queueMax: 5,

  // ---- Pacing -----------------------------------------------------------
  pacing: {
    matchTargetMin: [30, 45],
    waveInterval: 90,       // s
    firstWave: 240,         // s grace before first wave
    waveBase: 2,            // units in first wave
    waveGrowthPer: 150,     // +1 unit every N seconds of match time
    waveMax: 30,
    enemyTrickleBase: 0,    // v3: AIs earn through plots/extractors like the player (was 30 crystals/min)
    enemyTrickleGrowth: 0,  // v3: was +15/min per minute
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

  // v2 layout. Base positions are fractions of the half-extents so any world.map size works
  // (512x320 -> cc at (+-200, +-110)). Other distances are absolute world units.
  map: {
    baseFrac: { x: 200 / 256, z: 110 / 160 },
    bldOff: 10,            // barracks/factory: 10u toward center in x, +-10u in z (v1 offsets, mirrored)
    toField: 25,           // base crystal field distance from cc, toward map center
    fieldCrystals: 4, fieldSpread: 4,
    centerFields: [{ fx: 0, fz: 0 }, { fx: -110 / 256, fz: 0 }, { fx: 110 / 256, fz: 0 }],
    centerCrystals: 7, centerSpread: 6.5,
    rallyOffset: 4,
  },

  // team t base quadrant signs (x, z) per CONTRACT v2: 0 SW, 1 NE, 2 NW, 3 SE
  teams: {
    count: 4,
    quad: [[-1, 1], [1, -1], [-1, -1], [1, 1]],
    factions: ['vanguard', 'volcanic', 'earth', 'storm'],
    names: ['Vanguard', 'Volcanic Clans', 'Earth Cult', 'Storm Nomads'],
    colors: [0x2fb8ff, 0xff5a12, 0x5fd35f, 0xe8d27a],
  },

  // Fog of war (team 0 only). Sight is measured from the entity edge for buildings.
  fog: {
    cell: 4, interval: 0.25,
    sight: { inf: 18, veh: 22, harvester: 14, bld: 26, turret: 30 },
    tallMul: 1.4, survMul: 1.5,
  },

  // Perf: uniform spatial hash for neighbor/target queries; coarse nav grid for A*.
  hash: { cell: 16 },
  nav: { cell: 2, infl: 1.0, pathsPerStep: 3, maxIter: 30000 },
};
