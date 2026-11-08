// Integrator-owned bootstrap. Wires modules in the order the contract defines.
// Workers: do not edit. If your module isn't ready, main.js tolerates a missing export.
import { createEngine } from './engine.js';

const world = await createEngine();
window.world = world; // for smoke tests / debugging

async function optional(path, name) {
  try { const m = await import(path); return m[name]; }
  catch (e) { console.warn(`[main] ${path} not loaded:`, e.message); return null; }
}

const createSim     = await optional('./sim.js', 'createSim');
const createDefense = await optional('./defense.js', 'createDefense');
const createFx      = await optional('./fx.js', 'createFx');
const createHud     = await optional('./hud.js', 'createHud');

const sim     = createSim     ? createSim(world)          : null;
const defense = createDefense ? createDefense(sim, world) : null;
const fx      = createFx      ? createFx(world)           : null;
const hud     = createHud     ? createHud(world, sim)     : null;

world.onFrame((dt) => {
  sim?.update?.(dt);
  defense?.update?.(dt);
  fx?.update?.(dt);
  hud?.update?.(dt);
});
