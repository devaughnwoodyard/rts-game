# Vanguard RTS — Module Contract (v1)

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
