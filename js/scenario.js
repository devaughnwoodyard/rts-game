// Integrator-owned: "10 minutes in" start scenario (default ON; ?start=fresh disables).
// Each faction starts with: its nearest 4 land plots claimed with extractors already built,
// 2 extra harvesters hauling to the processor, banked resources, and one of every unit kind
// standing on its forward line between its base and the map center.
import { FACTIONS } from './roster.js';

export function applyScenario(world, sim) {
  const q = new URLSearchParams(location.search);
  if (q.get('start') === 'fresh' || !sim) return false;
  const econ = world.econ;
  const teams = world.teams?.count ?? 4;
  const ents = () => world.entities;
  const ccOf = (t) => ents().find(e => e.kind === 'cc' && e.team === t);

  for (let t = 0; t < teams; t++) {
    const cc = ccOf(t); if (!cc) continue;
    const faction = world.factions?.[t];

    // 1. Economy: bank resources, claim the nearest plots and build extractors instantly.
    try {
      econ?.add?.(t, 'primary', 4000, false); econ?.add?.(t, 'secondary', 1500, false);
      const plots = (econ?.plots || []).filter(p => p.owner == null || p.owner < 0 || p.owner === t)
        .sort((a, b) => Math.hypot(a.x - cc.x, a.z - cc.z) - Math.hypot(b.x - cc.x, b.z - cc.z)).slice(0, 5);
      for (const p of plots) {
        p.owner = t; p.claiming = -1; p.claimT = p.claimTotal || 0;
        if (!p.ext || p.ext.state === 'dead') econ?.buildExtractor?.(t, p);
      }
      // two housing blocks behind the base so the deployed army fits under the supply cap
      const bx = cc.x / (Math.hypot(cc.x, cc.z) || 1), bz = cc.z / (Math.hypot(cc.x, cc.z) || 1);
      for (const s of [-1, 1]) {
        try { econ?.build?.(t, 'housing', cc.x + bx * 16 + -bz * s * 10, cc.z + bz * 16 + bx * s * 10, { free: true, instant: true }); } catch {}
      }
      for (const e of econ?.extractors || []) if (e.team === t) {
        e.constructing = false; e.built = true; e.buildT = e.buildTotal ?? e.buildT; if (e.stages != null) e.stage = e.stages;
        if (e.stock != null && e.cap != null) e.stock = e.cap * 0.5;
      }
      // leave a realistic mid-game bank (~1000 primary / ~500 secondary after extractor costs)
      const r = econ?.res?.[t];
      if (r) { r.primary = Math.min(r.primary, 1000); r.secondary = Math.min(r.secondary, 500); }
    } catch (err) { console.warn('[scenario] econ setup skipped:', err.message); }

    // 2. Army: one of every unit kind on the forward line (toward map center).
    const units = FACTIONS[faction]?.units || [];
    const dx = -cc.x, dz = -cc.z, L = Math.hypot(dx, dz) || 1;
    const fx = cc.x + dx / L * 38, fz = cc.z + dz / L * 38;   // forward rally point
    const px = -dz / L, pz = dx / L;                          // perpendicular spread
    units.forEach((kind, i) => {
      const off = (i - (units.length - 1) / 2) * 5;
      try { sim.spawn(kind, t, fx + px * off, fz + pz * off); } catch (err) { console.warn('[scenario] spawn', kind, err.message); }
    });
    // start the player's camera on their deployed army
    if (t === 0 && world.camTarget) { world.camTarget.x = fx; world.camTarget.z = fz; }
    // two extra harvesters so the processor is clearly being fed
    const harv = units.find(k => /harvester/.test(k));
    if (harv) for (let i = 0; i < 2; i++) { try { sim.spawn(harv, t, cc.x + (i ? 6 : -6), cc.z + 6); } catch {} }
  }
  world.ui.message = 'Mid-game start: armies deployed, harvesters running';
  return true;
}
