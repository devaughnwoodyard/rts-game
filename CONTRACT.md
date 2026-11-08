# Vanguard RTS — Module Contract (v1)

## v2 ADDENDUM (supersedes conflicting v1 lines below)
**Map:** 10× area. `world.map = { w: 512, h: 320 }`, origin at center. Four factions, free-for-all, player is team 0; teams 1–3 are AI.
| team | faction | base (cc) | biome | color |
|---|---|---|---|---|
| 0 | Vanguard (INDUSTRIAL, not sci-fi) | (-200, 110) SW | INDUSTRIAL ZONE: concrete slabs, oil-stained asphalt, rail tracks, gravel, puddles; obstacles = factory ruins, cooling towers, slag heaps, shipping-container stacks, gantry cranes (NOT desert) | 0x2f8fd8 |
| 1 | Volcanic Clans | (200, -110) NE | volcanic: basalt, burned ground, cracked red earth, lava | 0xff5a12 |
| 2 | Earth Cult (nature/sun/stone) | (-200, -110) NW | forest + rocky red mountainside: grass/forest ground, cliffs, trees | 0x5fd35f |
| 3 | Storm Nomads (lightning/wind) | (200, 110) SE | open dunes: sand, wind-rippled | 0xe8d27a |
ONLY the Storm Nomads quadrant is desert. Each quadrant must look like its faction's home. Center = neutral rocky badlands (grey-brown rock, gravel, some scrub — not sand) where the four biomes bleed into it, with 3 large crystal fields; each base has its own field ~25 units from its cc toward center. Barracks/factory offsets are the v1 offsets mirrored per quadrant (always on the side toward the map center).
- `world.teams = { P:0, count:4 }`; `world.colors[0..3]`; `world.factions[t] = 'vanguard'|'volcanic'|'earth'|'storm'`.
- `world.biomeAt(x,z)` → `{ volcanic, forest, dunes, badlands }` weights summing to 1 (engine owns; smooth blends ~40 units wide between regions). Engine renders terrain from this (splat).
- Obstacles: mountains/cliffs (NW), lava pools (NE, impassable), dune ridges (SE), mesas (center/SW) — all as `world.obstacles` circles; bigger ones are several overlapping circles.
- AI: every non-player team runs the same enemy AI (build, harvest, defense tiers, waves). Each AI targets the nearest enemy cc (player or AI). AIs fight each other.
- Win when all other ccs are destroyed; lose when yours is.

**Faction rosters & abilities (new, owned by ROSTER worker in js/roster.js + js/abilities.js + js/abilitybar.js):** asymmetric, balanced to ~50% win rate in equal-cost fights (verified by a headless balance harness). Every non-hero unit has exactly 4 abilities (mix of passives and actives, ≥2 actives). Each faction has 6 unit kinds: infantry, light vehicle, heavy, harvester, special, air (or anti-air for factions weak in air).
| faction | identity / strength | weakness |
|---|---|---|
| vanguard (industrial) | all-rounder; best static defense + artillery; armored infantry; flak AA | slowest to expand, mid speed |
| volcanic | STURDIEST TANKS (magma-coated: armor + burn-on-hit); strong close range | slow; NO air (has flak "Ash Cannon" AA); short sight |
| earth (Earth Cult) | STRONGEST AIR (Sunwing great flyers + glider swarms); UNDERGROUND BURROWER (travels hidden, pops up for AoE + stun); nature healing | fragile ground units, weak vs armor |
| storm (Storm Nomads) | QUICKEST: lightweight land-yachts/sail racers, hit-and-run, chain lightning, speed buffs | low HP, poor vs static defense |
Unit flags sim must honor: `air:true` (flies at y≈8, ignores ground obstacles/walls, only hittable by units with `canHitAir`), `burrowed:true` (untargetable, invisible to enemies, moves at 0.7× speed, cannot attack; surfacing is an ability), `canHitAir`, `canHitGround` (default true), `armor` (flat % dmg reduction), `light:true`. Kinds are namespaced per faction (e.g. `earth_burrower`, `storm_yacht`); roster.js is the single source of truth for unit stats (sim reads `ROSTER[kind]` before CONFIG). Ability API: `world.abilities.cast(entity|entities, abilityId, target?)`, cooldowns per entity, autocast flags; AI casts sensibly. Ability bar UI: abilitybar.js injects a bottom-center bar of 4 square buttons (≥48px) for the selected unit kind (icons drawn procedurally or from assets/icons), cooldown sweep, tap = cast at best target (or enter targeting mode: next ground tap = target).

**Heroes (new, owned by HEROES worker in js/heroes.js + js/fx.js):** one hero per faction, trained at the cc (cost 600, 60s, unique; respawn at cc 90s after death). Entities: `kind:'hero'`, `faction`, `cls:'inf'`, `hero:true`, with per-entity stats on `e.stats = {hp, speed, range, dps, cooldown, r, sight}` that sim MUST prefer over CONFIG when present (sim handles hero movement, auto-targeting and basic attacks like any unit). Abilities live in heroes.js: `world.heroes.cast(hero, abilityId, target?)`; AI teams auto-cast when ≥2 enemies in range. Damage via `sim.damage`; status effects via `e.status = {rooted:t, stunned:t, dmgMul:x, until:t}` that sim respects (rooted/stunned = no move; stunned = no attack; dmgMul scales incoming damage). Events: `ability {hero, id, x, z, targets}` for fx.
- vanguard **Ironclad**: exosuit, laser rifle (beam), hp 1400, passive incoming dmg ×0.75; **Bulwark** (cd 30s): dmgMul 0.3 for 6s + nearby enemies retarget him.
- storm **Thunderwarden**: electric hammer melee (range 3), hp 1200, fast; **Chain Lightning** (cd 18s): 220 dmg to target, chains to 4 more within 12u (×0.8 each), 1s stun on each.
- volcanic **Magmablade**: red-hot volcano blade melee + M16-style rifle (switches: rifle >5u, blade ≤5u, blade dps ×2.5), hp 1100; **Eruption Slash** (cd 20s): dash 14u toward target, 250 dmg in a cone, leaves a fire patch 4s (40 dps).
- earth **Sylvan Warden** (original tall nature being, bark-like skin, glowing gold markings — NOT a Na'vi/Avatar copy): crossbow, longest range (30), hp 1000; **Rootbind** (cd 24s): roots all enemies in r=8 for 3s and heals allies in r=10 for 200 over 3s.

**Fog of war (new):**
- Sim owns visibility: `world.fog = { enabled: true, cell: 4, cols, rows, explored: Uint8Array, visible: Uint8Array, version }` for team 0 only. Each 0.25 s recompute `visible` from team-0 units (sight: inf 18, veh 22, harvester 14, bld 26, turrets 30 (+40% w/ tall turrets), surveillance tier = +50%); `explored |= visible`. Bump `version` on change.
- Enemy entities (team≠0) on cells not currently visible: `entity.hidden = true` when fog enabled (sim sets each recompute). Engine hides their meshes/health bars; minimap hides them; buildings once seen stay drawn on minimap as "last seen" ghosts. Player cannot target hidden units by tap.
- `world.fog.enabled` toggled by HUD button "Fog: On/Off" (top bar) and key F; when off, everything is visible and `hidden` is false for all.
- Engine renders fog as a ground-level overlay: unexplored = near-black (alpha 0.92), explored-not-visible = dark desaturated (alpha 0.55), visible = clear; texture from the fog arrays (DataTexture, linear filtered, updated on version change).


Single-page web game. Plain ES modules, no bundler. Three.js r160 via import map from cdnjs.
Phone-first, landscape. Must run on iOS Safari and Chrome Android.

## Files and owners
| File | Owner | Exports |
|---|---|---|
| `index.html` | Engine | shell, importmap, canvases, HUD DOM |
| `js/engine.js` | Engine | `createEngine()` → scene, 3 cameras, render loop, input, ground, obstacles |
| `js/sim.js` | Sim | `createSim(world)` → entities, units, RPS combat, economy, build queues, time/pacing, win/lose |
| `js/defense.js` | Defense | `createDefense(sim, world)` → turrets, walls, moat, 10 tiers, enemy AI |
| `js/fx.js` | FX | `createFx(world)` → blood, muzzle flashes, explosions, ground decals, day/night |
| `js/hud.js` | Engine | HUD DOM + minimap, reads sim state |
| `js/config.js` | Sim | all tunables (costs, timers, damage table) — single source of truth |

Nobody edits another owner's file. Shared state lives on `world` (below). If you need something from another module that isn't here, stub it locally with a TODO and keep going; the integrator wires it.

## Shared `world` object (created by engine, passed to everyone)
```js
world = {
  THREE,                // the three module
  scene, renderer,
  camera,               // the active camera (switches); always use world.camera
  clock: { t: 0, dt: 0, speed: 1 },   // game seconds; dt per frame; sim must use world.clock.dt
  map: { w: 160, h: 100 },            // world units, origin at center, ground is y=0, x right, z down-screen
  obstacles: [ {x, z, r} ],           // rock circles, read-only
  teams: { P: 0, E: 1 },              // player = 0, enemy = 1
  colors: { 0: 0x2f7cff, 1: 0xe23a3a },
  entities: [],         // every live thing: see Entity below. sim owns adds/removes.
  bus: EventTarget,     // world.bus.dispatchEvent(new CustomEvent(name, {detail}))
  input: {              // engine fills each frame
    tap: null|{x,z,hit},        // world point tapped this frame + raycast hit entity (or null)
    drag: null|{x0,z0,x1,z1,done},  // box select in world coords, done=true on release
    selected: Set<Entity>,      // engine/hud maintain; sim reads
    command: null|{type:'move'|'attack', x, z, target}  // issued this frame by HUD/input
  },
  ui: {                 // sim writes, hud reads
    crystals: 0, supply: 0, supplyCap: 0, time: 0, phase: 'day'|'night',
    queues: { barracks: [...], factory: [...] }, defenseTier: 0, enemyTier: 0,
    message: null,      // transient banner text
    gameOver: null|'win'|'lose'
  }
}
```

## Entity (plain object, sim creates; others read)
```js
{
  id, kind,            // 'warden'|'tank'|'raider'|'harvester'|'cc'|'barracks'|'factory'|'turret_mg'|'turret_cannon'|'artillery'|'wall'|'gate'|'crystal'
  team,                // 0|1|-1 (neutral)
  x, z, rot,           // position/heading in world units/radians
  r,                   // collision radius
  hp, hpMax,
  cls: 'inf'|'veh'|'bld'|'neutral',   // damage class for RPS
  mesh,                // THREE.Object3D, created by sim via world.makeMesh(kind, team) (engine provides)
  state: 'idle'|'move'|'attack'|'gather'|'return'|'build'|'dead',
  target: null|Entity, dest: null|{x,z},
  cooldown: 0, range, dps, speed,
  carry: 0,            // harvester
}
```

## Events on `world.bus` (name → detail)
- `hit` → `{ x, z, attacker, victim, dmg, cls }`  (fx draws blood for cls 'inf', sparks for 'veh'/'bld')
- `shot` → `{ from:{x,z,y}, to:{x,z,y}, kind }`    (fx draws tracer/muzzle)
- `died` → `{ entity }`                               (fx explosion/corpse; sim already removed it)
- `built` → `{ entity }`
- `tier` → `{ team, tier, name }`                     (defense tier completed)
- `message` → `{ text, ms }`

## RPS damage table (config.js owns the numbers; sim applies)
Attacker → multiplier vs class: `inf` / `veh` / `bld`
- warden (rockets): 0.6 / **1.8** / 1.0
- tank (cannon):    0.8 / 0.6 / **1.6**   and vs raider class 'veh-light' treat as **1.8**
- raider (MG):      **1.8** / 0.5 / 0.4
- turret_mg:        **1.8** / 0.5 / 0
- turret_cannon:    0.6 / **1.8** / 0
- artillery (AoE):  1.2 / 1.2 / 0.8, splash r=6
Multiplier is applied to base dps. `raider` has `cls:'veh'` plus `light:true`; tank gets 1.8 vs light.

## Pacing (the "time element")
- Match target 30–40 min. `world.clock.speed` is a global multiplier (HUD exposes 1x/2x).
- Build times: warden 20s, raider 25s, tank 45s, harvester 40s. Defense tiers 60–180s each.
- Economy: harvester trip ~25s round trip, +40 crystals. Start 400.
- Enemy escalation: wave every 90s, size grows; enemy buys a defense tier every ~4 min.
- Day/night cycle: 8 min full cycle; night lowers turret range by 20% unless surveillance tier built.

## Defense tiers (defense.js owns; same list for both teams)
1 MG turret ×2 · 2 Wall ring (gaps) · 3 Cannon turret ×2 · 4 Extended wall (bigger ring)
5 Moat: single entry path (walls close all but one gap) · 6 Tall turrets (+40% range)
7 Artillery battery ×2 · 8 Surveillance (enemy units visible on minimap, night penalty removed)
9 Shield gate (gate entity, 2000hp, regen) · 10 Siege cannon (one, long range, slow, huge dmg)
Walls are `wall` entities (cls 'bld', block movement: sim treats walls as obstacles via world.obstacles push/pop that defense.js maintains).

## Engine guarantees (engine.js)
- `world.makeMesh(kind, team)` returns a primitive-built mesh (no external models). Team-colored. Sizes: warden r=1.2 (3 capsules), raider r=1.6, tank r=2.2, harvester r=2, cc r=8, barracks/factory r=5, turrets r=1.5, wall segment 4×1.5×2 box, gate r=2.5.
- Three views cycled by HUD button: `aerial` (ortho top-down), `tactical` (perspective, 68° down), `low` (perspective, 40°, closer). `world.setView(name)`.
- Camera pan: two-finger drag / right-mouse drag. Pinch/wheel zoom within limits. One-finger drag on ground = box select. Tap = select/command. `touch-action:none`, pointer events only.
- `world.project(x,y,z)` → screen px for overlay drawing.
- Overlay 2D canvas `#overlay` sits above the WebGL canvas for selection rings, health bars, drag box (engine/hud draws these from world.entities + input.selected).

## Testing
Each owner runs `node test/smoke.mjs` (Playwright, 844×390 viewport, loads index.html via file server, waits 5s, fails on any console error, screenshots to `test/out/<module>.png`). Keep a `TODO.md` in your module header comment listing anything stubbed.
