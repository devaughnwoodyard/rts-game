// heroes.js — Vanguard heroes (owner: HEROES). One unique hero per faction, trained at the cc.
// createHeroes(world, sim) → world.heroes = { cast, update, list, train, spawnNow, state, defs }.
//
// TODO.md (HEROES):
//  - Relies on SIM-v2: spawn('hero', team, x, z, {stats,...}) → isUnit hero; e.stats re-synced every step; e.status
//    {rooted, stunned, dmgMul, until} with timestamps in world.clock.t. If spawn gives a non-unit, we respawn as
//    'warden' and override fields; if sim lacks status support we enforce dmgMul via the synchronous 'hit' event and
//    roots/stuns by snapping position / holding cooldown after sim.update.
//  - Basic attacks are sim-driven (shot.kind === 'hero'); fx.js styles them by looking up the nearest hero.
//  - HUD: own button in #hud (.v-hero), bottom-right above the build panel. A 'hero' entry in hud.js's cc panel
//    could replace it later (call world.heroes.train(0)).
//  - Ability damage is raw (no RPS). Rootbind roots around the target point, heals around the hero.
import * as THREE from 'three';

const DEFS = {
  vanguard: {
    name: 'Ironclad', ability: 'bulwark', abilityName: 'Bulwark', cd: 30, castRange: 16, color: '#39d8ff',
    stats: { hp: 1400, speed: 6.4, range: 16, dps: 34, cooldown: 0.6, r: 1.6, sight: 26 }, passiveMul: 0.75,
  },
  storm: {
    name: 'Thunderwarden', ability: 'chain', abilityName: 'Chain Lightning', cd: 18, castRange: 14, color: '#bfe4ff',
    stats: { hp: 1200, speed: 10.5, range: 3, dps: 48, cooldown: 0.8, r: 1.5, sight: 22 },
  },
  volcanic: {
    name: 'Magmablade', ability: 'eruption', abilityName: 'Eruption Slash', cd: 20, castRange: 16, color: '#ff6a1a',
    stats: { hp: 1100, speed: 8.5, range: 14, dps: 22, cooldown: 0.5, r: 1.5, sight: 22 }, bladeMul: 2.5, bladeRange: 5,
  },
  earth: {
    name: 'Sylvan Warden', ability: 'rootbind', abilityName: 'Rootbind', cd: 24, castRange: 30, color: '#ffc84a',
    stats: { hp: 1000, speed: 7.6, range: 30, dps: 24, cooldown: 1.3, r: 1.4, sight: 34 },
  },
};
const COST = 600, TRAIN_T = 60, RESPAWN_T = 90, AI_MIN_T = 240, AI_MIN_CR = 900;
const FACTION_BY_TEAM = ['vanguard', 'volcanic', 'earth', 'storm'];

export async function createHeroes(world, sim) {
  if (!sim) return null;
  let chars = null;
  try { chars = await import('./characters.js'); if (!chars.charactersReady?.()) chars = null; }
  catch (err) { console.warn('[heroes] characters.js unavailable, primitive heroes:', err?.message); chars = null; }

  const ents = world.entities;
  const bus = world.bus;
  const now = () => world.clock?.t ?? sim.time ?? 0;
  const emit = (name, detail) => { try { bus.dispatchEvent(new CustomEvent(name, { detail })); } catch (_) {} };
  const message = (text, ms = 2000) => { if (world.ui) world.ui.message = text; emit('message', { text, ms }); };
  const teamCount = sim.teamCount ?? world.teams?.count ?? 2;
  const factionOf = (t) => world.factions?.[t] || FACTION_BY_TEAM[t] || 'vanguard';
  const ccOf = (t) => { const h = sim.hq?.[t]; if (h && h.state !== 'dead') return h; return ents.find(e => e.kind === 'cc' && e.team === t && e.state !== 'dead') || null; };
  let simV2 = null; // decided on first spawn: does sim honor e.stats/e.status natively?

  // per-team state
  const T = [];
  for (let t = 0; t < teamCount; t++) T.push({ team: t, state: 'none', t: 0, total: 0, hero: null, cdUntil: 0, respawnAt: 0, mesh: null });

  // ------------------------------------------------------------ queries
  const isEnemy = (team, o) => o.team !== team && o.team >= 0 && o.state !== 'dead' && o.cls !== 'neutral';
  const qbuf = [];
  function around(x, z, r) {
    if (sim.near) { try { return sim.near(x, z, r, qbuf).slice(); } catch (_) {} }
    return ents.filter(o => Math.hypot(o.x - x, o.z - z) <= r + (o.r || 0));
  }
  function enemiesNear(team, x, z, r, unitsOnly) {
    return around(x, z, r).filter(o => isEnemy(team, o) && (!unitsOnly || o.isUnit) && Math.hypot(o.x - x, o.z - z) - (o.r || 0) <= r);
  }
  function nearestEnemy(h, r, { visibleOnly = false, unitsFirst = true } = {}) {
    let best = null, bs = Infinity;
    for (const o of enemiesNear(h.team, h.x, h.z, r)) {
      if (visibleOnly && o.hidden) continue;
      const s = Math.hypot(o.x - h.x, o.z - h.z) - (o.r || 0) + (unitsFirst && !o.isUnit ? 8 : 0);
      if (s < bs) { bs = s; best = o; }
    }
    return best;
  }

  // ------------------------------------------------------------ status helpers
  function addStatus(e, patch, perm) {
    const s = e.status || (e.status = {});
    const t = now();
    let until = s.until ?? 0;
    for (const k of ['rooted', 'stunned']) if (patch[k] != null) { s[k] = Math.max(typeof s[k] === 'number' ? s[k] : 0, patch[k]); until = Math.max(until, patch[k]); }
    if (patch.dmgMul != null) s.dmgMul = patch.dmgMul;
    if (perm || e.hero) s.until = undefined; else s.until = Math.max(until, t);
    if (!simV2) { if (s.rooted > t || s.stunned > t) e._hxAnchor = e._hxAnchor || { x: e.x, z: e.z }; }
    fallbackStatus.add(e);
  }
  const fallbackStatus = new Set();
  function enforceFallback() { // only when sim doesn't support e.status
    const t = now();
    for (const e of fallbackStatus) {
      const s = e.status;
      if (!s || e.state === 'dead') { fallbackStatus.delete(e); continue; }
      const noMove = s.rooted > t || s.stunned > t;
      if (simV2) { if (!noMove && !(s.dmgMul != null)) fallbackStatus.delete(e); continue; }
      if (noMove && e._hxAnchor) { e.x = e._hxAnchor.x; e.z = e._hxAnchor.z; e.mesh?.position?.set?.(e.x, 0, e.z); }
      else e._hxAnchor = null;
      if (s.stunned > t) e.cooldown = Math.max(e.cooldown || 0, s.stunned - t + 0.05);
      if (!noMove && s.dmgMul == null) fallbackStatus.delete(e);
    }
  }
  // dmgMul fallback: 'hit' is dispatched synchronously before sim's kill check, so we can refund damage.
  bus.addEventListener('hit', (ev) => {
    if (simV2 !== false) return;
    const d = ev.detail, v = d?.victim, s = v?.status;
    if (!s || s.dmgMul == null || !(d.dmg > 0)) return;
    v.hp += d.dmg * (1 - Math.max(0, s.dmgMul));
  });

  // ------------------------------------------------------------ meshes
  const M = {};
  function mats() {
    if (M.ready) return M;
    const std = (c, o = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.55, metalness: 0.4, ...o });
    const glow = (c, k = 1) => new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(k) });
    Object.assign(M, {
      ready: true,
      steel: std(0x4b5560, { metalness: 0.7, roughness: 0.4 }), steelDark: std(0x262c33, { metalness: 0.7, roughness: 0.45 }),
      hazard: std(0xe0b020, { metalness: 0.3 }), piston: std(0xb8c2cc, { metalness: 0.9, roughness: 0.25 }),
      cyan: glow(0x39d8ff, 1.6), white: glow(0xdff4ff, 2.2), bone: std(0xe8e2d0, { metalness: 0.1, roughness: 0.6 }),
      crimson: std(0x8c1c1c, { metalness: 0, roughness: 0.9, side: THREE.DoubleSide }), crimson2: std(0x6e1616, { metalness: 0, roughness: 0.9, side: THREE.DoubleSide }),
      haft: std(0x3a2a1c, { metalness: 0.1, roughness: 0.8 }), obsidian: std(0x141012, { metalness: 0.6, roughness: 0.3 }),
      ember: glow(0xff4a10, 2.0), hot: glow(0xffb060, 2.4), horn: std(0xd8c7a0, { metalness: 0.05, roughness: 0.7 }),
      bark: std(0x5a3e26, { metalness: 0.0, roughness: 0.95 }), gold: glow(0xffc84a, 1.8),
      leaf: std(0x4f7f32, { metalness: 0, roughness: 0.85, side: THREE.DoubleSide }), leaf2: std(0x35592a, { metalness: 0, roughness: 0.85, side: THREE.DoubleSide }),
      ring: new THREE.MeshBasicMaterial({ color: 0xffc840, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }),
      chevron: new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffd24a).multiplyScalar(1.4) }),
    });
    M.ringGeo = new THREE.RingGeometry(1.55, 1.9, 40).rotateX(-Math.PI / 2);
    const sh = new THREE.Shape();
    sh.moveTo(-0.45, 0.3); sh.lineTo(0, -0.15); sh.lineTo(0.45, 0.3); sh.lineTo(0.45, 0.05); sh.lineTo(0, -0.42); sh.lineTo(-0.45, 0.05); sh.closePath();
    M.chevGeo = new THREE.ExtrudeGeometry(sh, { depth: 0.12, bevelEnabled: false }).translate(0, 0, -0.06);
    return M;
  }

  // Props authored in rig space (cm, T-pose, character faces +Z, right hand at -X), parented to bones.
  function rigAttacher(body) {
    body.updateMatrixWorld(true);
    const bodyInv = body.matrixWorld.clone().invert();
    const groups = {};
    return (boneName, mesh, pos, rot = [0, 0, 0], scl) => {
      const bone = body.getObjectByName('mixamorig' + boneName);
      if (!bone) return null;
      let g = groups[boneName];
      if (!g) {
        const rig = bodyInv.clone().multiply(bone.matrixWorld); // bone in body-local (rig) space
        g = groups[boneName] = new THREE.Group();
        rig.invert().decompose(g.position, g.quaternion, g.scale);
        bone.add(g);
      }
      mesh.position.set(pos[0], pos[1], pos[2]); mesh.rotation.set(rot[0], rot[1], rot[2]);
      if (scl) mesh.scale.set(...scl);
      mesh.castShadow = !mesh.material.isMeshBasicMaterial; mesh.frustumCulled = false;
      g.add(mesh);
      return mesh;
    };
  }
  const G = {
    box: (w, h, d) => new THREE.BoxGeometry(w, h, d),
    cyl: (rt, rb, h, s = 8) => new THREE.CylinderGeometry(rt, rb, h, s),
    cone: (r, h, s = 6) => new THREE.ConeGeometry(r, h, s),
  };
  const mk = (geo, mat) => new THREE.Mesh(geo, mat);

  // Clone of the soldier geometry with the built-in rifle collapsed into the hand (degenerate tris = invisible).
  function noRifleGeometry(sk) {
    const g = sk.geometry.clone();
    const names = sk.skeleton.bones.map(b => b.name);
    const hi = names.indexOf('mixamorigRightHand');
    if (hi < 0) return g;
    const hp = new THREE.Vector3().setFromMatrixPosition(sk.skeleton.boneInverses[hi].clone().invert());
    const pos = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight, col = g.attributes.color;
    for (let i = 0; i < pos.count; i++) {
      let w = 0; for (let k = 0; k < 4; k++) if (si.getComponent(i, k) === hi) w += sw.getComponent(i, k);
      if (w < 0.5) continue;
      const glove = col && Math.abs(col.getX(i) - 0.16) < 0.03 && Math.abs(col.getZ(i) - 0.19) < 0.03;
      if (!glove) pos.setXYZ(i, hp.x, hp.y, hp.z);
    }
    pos.needsUpdate = true; g.computeBoundingSphere();
    return g;
  }

  function buildHeroMesh(team, faction) {
    mats();
    const root = new THREE.Group(); root.name = 'hero';
    let sol = null, sk = null, height = 3.4;
    const vis = {}; // swappable visuals
    if (chars) {
      try {
        sol = chars.makeSoldier(team, { faction, hero: true });
        sol.body.traverse(o => { if (o.isSkinnedMesh) sk = o; });
      } catch (err) { console.warn('[heroes] makeSoldier failed', err?.message); sol = null; }
    }
    if (sol) {
      const body = sol.body;
      const base = chars.SOLDIER_HEIGHT / 188;
      if (faction === 'earth') { body.scale.set(base * 1.2, base * 1.9, base * 1.2); height = chars.SOLDIER_HEIGHT * 1.9 + 0.4; }
      else { body.scale.setScalar(base * 1.6); height = chars.SOLDIER_HEIGHT * 1.6 + 0.35; }
      const at = rigAttacher(body);
      if (faction === 'vanguard') propsIronclad(at);
      else if (faction === 'storm') propsThunder(at);
      else if (faction === 'volcanic') propsMagma(at, vis);
      else if (faction === 'earth') propsSylvan(at);
      if (sk && (faction === 'storm' || faction === 'earth' || faction === 'volcanic')) {
        vis.geoFull = sk.geometry; vis.geoNoRifle = noRifleGeometry(sk); vis.sk = sk;
        if (faction !== 'volcanic') sk.geometry = vis.geoNoRifle;
      }
      root.add(sol.root);
    } else {
      // primitive fallback
      const col = world.colors?.[team] ?? 0x888888;
      const m = new THREE.MeshStandardMaterial({ color: col, roughness: 0.6, metalness: 0.3 });
      const sy = faction === 'earth' ? 1.25 : 1;
      const b = mk(new THREE.CapsuleGeometry(0.55, 1.4 * sy, 4, 10), m); b.position.y = 1.3 * sy; root.add(b);
      const hd = mk(new THREE.SphereGeometry(0.42, 10, 8), m); hd.position.y = 2.6 * sy; root.add(hd);
      const gun = mk(G.box(1.4, 0.2, 0.2), M.steelDark); gun.position.set(0.7, 1.6 * sy, -0.35); root.add(gun);
      height = 3.2 * sy;
    }
    const ring = mk(M.ringGeo, M.ring); ring.position.y = 0.06; ring.renderOrder = 2; ring.name = 'heroRing';
    ring.raycast = () => {};
    root.add(ring);
    const chev = mk(M.chevGeo, M.chevron); chev.position.y = height + 0.55; chev.name = 'heroChevron';
    chev.raycast = () => {};
    root.add(chev);
    if (world.contactShadow) root.add(world.contactShadow(1.0));
    root.userData.kind = 'hero'; root.userData.height = height; root.userData.hero = true;
    return { root, sol, vis, chev, ring, height, mode: 'rifle', dying: 0, last: null, speed: 0 };
  }

  function propsIronclad(at) {
    // shoulder plates (with hazard stripe)
    for (const s of [1, -1]) {
      const bone = s > 0 ? 'LeftArm' : 'RightArm';
      at(bone, mk(G.box(24, 9, 26), M.steel), [s * 19, 155, -7], [0, 0, -s * 0.32]);
      at(bone, mk(G.box(25, 3, 6), M.hazard), [s * 19, 158.5, 6], [0, 0, -s * 0.32]);
      // arm pistons (upper + fore)
      at(bone, mk(G.cyl(2.6, 2.6, 22), M.steelDark), [s * 29, 137, -14], [0, 0, Math.PI / 2]);
      at(bone, mk(G.cyl(1.4, 1.4, 26), M.piston), [s * 31, 137, -14], [0, 0, Math.PI / 2]);
      const fa = s > 0 ? 'LeftForeArm' : 'RightForeArm';
      at(fa, mk(G.cyl(2.4, 2.4, 18), M.steelDark), [s * 56, 137, -13], [0, 0, Math.PI / 2]);
      at(fa, mk(G.box(20, 10, 14), M.steel), [s * 57, 145, -6], [0, 0, 0]);
      // leg frame + pistons
      const ul = s > 0 ? 'LeftUpLeg' : 'RightUpLeg', ll = s > 0 ? 'LeftLeg' : 'RightLeg';
      at(ul, mk(G.box(5, 40, 5), M.steelDark), [s * 18, 76, -2], [0, 0, 0]);
      at(ul, mk(G.cyl(2.8, 2.8, 26), M.steelDark), [s * 15, 78, -12], [0, 0, 0]);
      at(ul, mk(G.cyl(1.5, 1.5, 34), M.piston), [s * 15, 72, -12], [0, 0, 0]);
      at(ll, mk(G.box(5, 42, 5), M.steelDark), [s * 17, 32, -2], [0, 0, 0]);
      at(ll, mk(G.cyl(2.6, 2.6, 22), M.steelDark), [s * 14, 36, -13], [0, 0, 0]);
      at(ll, mk(G.cyl(1.4, 1.4, 30), M.piston), [s * 14, 28, -13], [0, 0, 0]);
      at(ll, mk(G.box(14, 8, 10), M.steel), [s * 9, 55, 9], [0, 0, 0]); // knee guard
    }
    // back power pack + cyan core + exhausts
    at('Spine2', mk(G.box(34, 40, 18), M.steelDark), [0, 138, -32], [0, 0, 0]);
    at('Spine2', mk(G.box(30, 4, 19), M.hazard), [0, 120, -32], [0, 0, 0]);
    at('Spine2', mk(G.cyl(6, 6, 22, 10), M.cyan), [0, 138, -41], [0, 0, 0]);
    for (const s of [1, -1]) at('Spine2', mk(G.cyl(3.5, 4.5, 16, 8), M.steel), [s * 11, 166, -34], [0, 0, 0]);
    at('Spine2', mk(G.box(40, 8, 26), M.steel), [0, 128, 6], [0, 0, 0]); // chest frame bar
    // long laser rifle: barrel extension + emitter + coil glow on the built-in rifle
    at('RightHand', mk(G.cyl(2.6, 3.2, 54, 8), M.steelDark), [-158, 141, -6], [0, 0, Math.PI / 2]);
    at('RightHand', mk(G.cyl(4.2, 4.2, 6, 10), M.cyan), [-186, 141, -6], [0, 0, Math.PI / 2]);
    for (let i = 0; i < 3; i++) at('RightHand', mk(G.cyl(3.6, 3.6, 2.5, 10), M.cyan), [-140 - i * 12, 141, -6], [0, 0, Math.PI / 2]);
    at('RightHand', mk(G.box(30, 6, 7), M.steel), [-112, 150, -6], [0, 0, 0]); // top rail/scope
  }

  function propsThunder(at) {
    // crimson sailcloth cape (two panels) from the shoulders down past the knees
    at('Spine2', mk(G.box(46, 80, 1.6), M.crimson), [0, 104, -28], [0.16, 0, 0]);
    at('Spine2', mk(G.box(18, 64, 1.6), M.crimson2), [-17, 98, -30], [0.22, 0, 0.08]);
    at('Spine2', mk(G.box(16, 70, 1.6), M.crimson2), [16, 96, -31], [0.26, 0, -0.06]);
    // bone-white pauldrons
    for (const s of [1, -1]) {
      at(s > 0 ? 'LeftArm' : 'RightArm', mk(G.box(22, 10, 24), M.bone), [s * 18, 154, -7], [0, 0, -s * 0.38]);
      at(s > 0 ? 'LeftForeArm' : 'RightForeArm', mk(G.box(20, 11, 13), M.bone), [s * 57, 144, -7], [0, 0, 0]);
    }
    // big two-handed hammer: long haft up from the right hand, emissive blue-white head
    at('RightHand', mk(G.cyl(2.4, 2.4, 140, 8), M.haft), [-78, 186, -7], [0, 0, 0]);
    at('RightHand', mk(G.cyl(3.2, 3.2, 8, 8), M.bone), [-78, 118, -7], [0, 0, 0]);
    at('RightHand', mk(G.box(22, 26, 46), M.bone), [-78, 258, -7], [0, 0, 0]);
    at('RightHand', mk(G.box(24, 20, 50), M.white), [-78, 258, -7], [0, 0, 0]);
    for (const s of [1, -1]) at('RightHand', mk(G.box(26, 30, 4), M.bone), [-78, 258, -7 + s * 23], [0, 0, 0]);
    at('RightHand', mk(G.cone(6, 16, 6), M.white), [-78, 279, -7], [0, 0, 0]);
  }

  function propsMagma(at, vis) {
    // big swept horns + ember eyes on the gas mask
    for (const s of [1, -1]) {
      at('Head', mk(G.cone(4.2, 26, 6), M.horn), [s * 13, 186, -2], [-0.35, 0, -s * 0.8]);
      at('Head', mk(G.cone(2.4, 14, 6), M.horn), [s * 24, 199, -6], [-0.6, 0, -s * 0.2]);
      at('Head', mk(G.cyl(2.2, 2.2, 3, 8), M.ember), [s * 5.6, 171, 15.5], [Math.PI / 2, 0, 0]);
    }
    // obsidian shoulder spikes
    for (const s of [1, -1]) {
      const b = s > 0 ? 'LeftArm' : 'RightArm';
      at(b, mk(G.box(20, 8, 22), M.obsidian), [s * 18, 154, -7], [0, 0, -s * 0.35]);
      at(b, mk(G.cone(3.5, 16, 5), M.obsidian), [s * 20, 164, -7], [0, 0, -s * 0.5]);
      at(b, mk(G.box(16, 1.6, 23), M.ember), [s * 18, 151, -7], [0, 0, -s * 0.35]);
    }
    // glowing red-hot curved blade in the right hand
    const blade = new THREE.Group();
    blade.add(mk(G.cyl(2.4, 2.4, 16, 8), M.obsidian).rotateZ(Math.PI / 2).translateY(0));
    const guard = mk(G.box(4, 16, 12), M.obsidian); guard.position.set(-9, 0, 0); blade.add(guard);
    for (let i = 0; i < 5; i++) {
      const seg = new THREE.Group();
      seg.add(mk(G.box(17, 6.5 - i * 0.6, 1.8), M.ember));
      const edge = mk(G.box(17, 1.6, 2.2), M.hot); edge.position.y = -(3.2 - i * 0.3); seg.add(edge);
      const a = 0.11 * i;
      seg.position.set(-19 - i * 15.5, i * i * 1.25, 0); seg.rotation.z = -a;
      blade.add(seg);
    }
    at('RightHand', blade, [-74, 143, -3], [0, 0, 0.12]);
    vis.blade = blade;
    // spare rifle slung diagonally across the back (shown while the blade is drawn)
    const sling = new THREE.Group();
    sling.add(mk(G.box(74, 7, 5), M.obsidian));
    const mag = mk(G.box(5, 12, 4), M.obsidian); mag.position.set(6, -8, 0); sling.add(mag);
    const brl = mk(G.box(16, 2.5, 2.5), M.ember); brl.position.set(-40, 1, 0); sling.add(brl);
    const strap = mk(G.box(80, 2, 1), M.haft); strap.position.set(0, 3, 2); sling.add(strap);
    at('Spine2', sling, [0, 140, -27], [0, 0, 0.75]);
    vis.sling = sling;
  }

  function propsSylvan(at) {
    // leafy shoulder mantle (layered broad leaves)
    const L = [M.leaf, M.leaf2];
    for (let i = 0; i < 14; i++) {
      const a = (i / 13 - 0.5) * 3.0, r = 22 + (i % 2) * 3;
      at('Spine2', mk(G.cone(9, 22, 3), L[i % 2]), [Math.sin(a) * r, 160 - Math.abs(a) * 4 - (i % 2) * 3, Math.cos(a) * 8 - 6], [Math.PI / 2 + 0.75, 0, -a * 0.7], [1, 1, 0.25]);
    }
    for (let i = 0; i < 6; i++) { const a = (i / 5 - 0.5) * 2; at('Spine2', mk(G.cone(8, 30, 3), L[(i + 1) % 2]), [Math.sin(a) * 15, 140, -22], [-0.25, a * 0.3, 0], [1, 1, 0.3]); }
    // glowing gold vein markings on limbs, chest and face
    for (const s of [1, -1]) {
      at(s > 0 ? 'LeftArm' : 'RightArm', mk(G.box(26, 1.1, 1.2), M.gold), [s * 29, 149, 2], [0, 0, s * 0.08]);
      at(s > 0 ? 'LeftArm' : 'RightArm', mk(G.box(14, 1.1, 1.2), M.gold), [s * 25, 141, 3], [0, 0, -s * 0.35]);
      at(s > 0 ? 'LeftForeArm' : 'RightForeArm', mk(G.box(24, 1.1, 1.2), M.gold), [s * 57, 145, 3], [0, 0, s * 0.12]);
      at(s > 0 ? 'LeftUpLeg' : 'RightUpLeg', mk(G.box(1.2, 34, 1.2), M.gold), [s * 9, 78, 11], [0, 0, s * 0.1]);
      at(s > 0 ? 'LeftLeg' : 'RightLeg', mk(G.box(1.2, 36, 1.2), M.gold), [s * 9, 32, 14], [0.1, 0, -s * 0.06]);
      at('Spine2', mk(G.box(1.2, 26, 1.2), M.gold), [s * 7, 138, 17], [0, 0, s * 0.4]);
      at('Head', mk(G.box(1, 9, 1), M.gold), [s * 6, 166, 16], [0, 0, s * 0.3]);
    }
    at('Spine2', mk(G.box(1.2, 18, 1.2), M.gold), [0, 128, 18], [0, 0, 0]);
    // branch crown
    for (const [x, rz, h] of [[-9, 0.5, 22], [9, -0.5, 22], [-4, 0.15, 16], [4, -0.15, 16]]) at('Head', mk(G.cone(1.6, h, 5), M.bark), [x, 192, -3], [-0.2, 0, rz]);
    // crossbow
    at('RightHand', mk(G.box(54, 5, 5), M.bark), [-104, 142, -7], [0, 0, 0]);
    at('RightHand', mk(G.box(4, 3.5, 30), M.bark), [-128, 142, 7], [0, 0.45, 0]);
    at('RightHand', mk(G.box(4, 3.5, 30), M.bark), [-128, 142, -21], [0, -0.45, 0]);
    at('RightHand', mk(G.box(1, 1, 44), M.gold), [-120, 142, -7], [0, 0, 0]);
    at('RightHand', mk(G.box(30, 1.4, 1.4), M.gold), [-118, 145.5, -7], [0, 0, 0]);
  }

  function setMagmaMode(hm, mode) {
    if (hm.mode === mode || !hm.vis) return;
    hm.mode = mode;
    const v = hm.vis;
    if (v.sk && v.geoFull && v.geoNoRifle) v.sk.geometry = mode === 'blade' ? v.geoNoRifle : v.geoFull;
    if (v.blade) v.blade.visible = mode === 'blade';
    if (v.sling) v.sling.visible = mode === 'blade';
  }

  // ------------------------------------------------------------ spawn / train
  function heroStats(def) { return { ...def.stats }; }
  function spawnHero(team, x, z) {
    const faction = factionOf(team), def = DEFS[faction];
    const st = T[team];
    const stats = heroStats(def);
    const opts = { faction, hero: true, stats, hp: stats.hp, hpMax: stats.hp, cls: 'inf', supply: 0, heroName: def.name };
    let e = null;
    try { e = sim.spawn('hero', team, x, z, opts); } catch (err) { console.warn('[heroes] spawn(hero) rejected:', err?.message); e = null; }
    if (!e || !e.isUnit) {
      if (e) { const i = ents.indexOf(e); if (i >= 0) ents.splice(i, 1); if (e.mesh) world.scene.remove(e.mesh); try { sim.kill?.(e); } catch (_) {} }
      e = sim.spawn('warden', team, x, z, { ...opts, kind: 'hero' });
      simV2 = false;
    } else if (simV2 == null) simV2 = true;
    Object.assign(e, { kind: 'hero', hero: true, faction, cls: 'inf', supply: 0, stats });
    e.hp = e.hpMax = stats.hp;
    syncFields(e);
    // swap sim's placeholder mesh for ours
    if (e.mesh) { world.scene.remove(e.mesh); if (e.mesh.userData) e.mesh.userData.entity = null; }
    const hm = buildHeroMesh(team, faction);
    hm.root.position.set(e.x, 0, e.z); hm.root.rotation.y = e.rot || 0;
    hm.root.userData.entity = e;
    e.mesh = hm.root;
    world.scene.add(hm.root);
    if (faction === 'volcanic') { hm.mode = null; setMagmaMode(hm, 'rifle'); }
    if (hm.sol) hm.sol.play('idle', 0);
    e._hm = hm;
    st.hero = e; st.state = 'alive'; st.mesh = hm;
    if (def.passiveMul) addStatus(e, { dmgMul: def.passiveMul }, true);
    emit('built', { entity: e });
    if (team === 0) message(`${def.name} ready`, 2000);
    return e;
  }
  function syncFields(e) { // sim v1 fallback: mirror stats onto the fields sim reads
    const s = e.stats; if (!s) return;
    e.speed = s.speed; e.range = s.range; e.dps = s.dps; e.fireRate = s.cooldown; e.r = s.r;
  }
  function spawnAtCc(team) {
    const cc = ccOf(team); if (!cc) return null;
    const dx = -cc.x, dz = -cc.z, l = Math.hypot(dx, dz) || 1, off = cc.r + 5;
    return spawnHero(team, cc.x + dx / l * off, cc.z + dz / l * off);
  }
  function train(team) {
    const st = T[team]; if (!st) return false;
    if (st.state !== 'none') { if (team === 0) message(st.state === 'training' ? 'Hero already training' : 'Hero already summoned'); return false; }
    if (!ccOf(team)) return false;
    if (!sim.spendCrystals(team, COST)) { if (team === 0) message('Not enough crystals'); return false; }
    st.state = 'training'; st.t = 0; st.total = TRAIN_T;
    if (team === 0) message(`Training ${DEFS[factionOf(team)].name}`, 1500);
    return true;
  }

  // ------------------------------------------------------------ abilities
  function cast(hero, id, target) {
    if (!hero || hero.state === 'dead' || !hero.hero) return false;
    const def = DEFS[hero.faction]; if (!def) return false;
    id = id || def.ability;
    if (id !== def.ability) return false;
    const st = T[hero.team], t = now();
    if (st && st.cdUntil > t) return false;
    if (hero.status && (hero.status.stunned > t)) return false;
    let ok = false;
    if (id === 'bulwark') ok = castBulwark(hero, def);
    else if (id === 'chain') ok = castChain(hero, def, target);
    else if (id === 'eruption') ok = castEruption(hero, def, target);
    else if (id === 'rootbind') ok = castRootbind(hero, def, target);
    if (ok && st) st.cdUntil = t + def.cd;
    return ok;
  }
  const pickTarget = (hero, def, target) => {
    if (target && target.state !== 'dead' && target.x != null && target.team != null && isEnemy(hero.team, target) &&
        Math.hypot(target.x - hero.x, target.z - hero.z) - (target.r || 0) <= def.castRange) return target;
    return nearestEnemy(hero, def.castRange, { visibleOnly: hero.team === 0 });
  };
  function castBulwark(h, def) {
    const t = now();
    h._bulwarkUntil = t + 6;
    addStatus(h, { dmgMul: 0.3 }, true);
    const taunted = [];
    for (const o of enemiesNear(h.team, h.x, h.z, def.castRange, true)) {
      if (!(o.dps > 0)) continue;
      o.target = h; o.state = 'attack'; o.autoTarget = false; o.dest = null; taunted.push(o);
    }
    emit('ability', { hero: h, id: 'bulwark', x: h.x, z: h.z, targets: taunted, duration: 6 });
    return true;
  }
  function castChain(h, def, target) {
    const first = pickTarget(h, def, target);
    if (!first) return false;
    const t = now(), hit = [first], pts = [{ x: h.x, z: h.z }];
    let cur = first, dmg = 220;
    for (let k = 0; k < 5 && cur; k++) {
      pts.push({ x: cur.x, z: cur.z });
      if (cur.isUnit) addStatus(cur, { stunned: t + 1 });
      sim.damage(cur, h, dmg);
      dmg *= 0.8;
      if (k === 4) break;
      let nx = null, nd = Infinity;
      for (const o of enemiesNear(h.team, cur.x, cur.z, 12, true)) {
        if (hit.includes(o)) continue;
        const d = Math.hypot(o.x - cur.x, o.z - cur.z);
        if (d < nd) { nd = d; nx = o; }
      }
      if (nx) hit.push(nx);
      cur = nx;
    }
    emit('ability', { hero: h, id: 'chain', x: first.x, z: first.z, targets: hit, points: pts });
    return true;
  }
  const dashes = [];
  function castEruption(h, def, target) {
    const tg = pickTarget(h, def, target);
    if (!tg) return false;
    const dx = tg.x - h.x, dz = tg.z - h.z, dist = Math.hypot(dx, dz) || 1;
    const ux = dx / dist, uz = dz / dist;
    const len = Math.min(14, Math.max(0, dist - (tg.r || 1) - 1.2));
    const x0 = h.x, z0 = h.z, x1 = x0 + ux * len, z1 = z0 + uz * len;
    const hit = [];
    const tan = Math.tan(0.75);
    for (const o of enemiesNear(h.team, x0 + ux * len / 2, z0 + uz * len / 2, len / 2 + 9)) {
      const rx = o.x - x0, rz = o.z - z0, along = rx * ux + rz * uz, perp = Math.abs(rx * uz - rz * ux) - (o.r || 0);
      const inPath = along >= -1 && along <= len && perp <= 2.5;
      const a2 = along - len, inCone = a2 > 0 && a2 <= 6 + (o.r || 0) && perp <= 2 + a2 * tan;
      if (inPath || inCone) hit.push(o);
    }
    for (const o of hit) sim.damage(o, h, 250);
    dashes.push({ h, x0, z0, x1, z1, t: 0, dur: 0.18 });
    h.rot = Math.atan2(-uz, ux);
    patches.push({ team: h.team, hero: h, x: x1 + ux * 3, z: z1 + uz * 3, r: 4, until: now() + 4, tick: 0 });
    emit('ability', { hero: h, id: 'eruption', x: x1, z: z1, targets: hit, from: { x: x0, z: z0 }, to: { x: x1, z: z1 }, dir: { x: ux, z: uz },
      patch: { x: x1 + ux * 3, z: z1 + uz * 3, r: 4, duration: 4 } });
    return true;
  }
  const patches = [];
  const heals = [];
  function castRootbind(h, def, target) {
    const tg = pickTarget(h, def, target);
    if (!tg) return false;
    const t = now(), cx = tg.x, cz = tg.z;
    const rooted = enemiesNear(h.team, cx, cz, 8, true);
    for (const o of rooted) addStatus(o, { rooted: t + 3 });
    const allies = around(h.x, h.z, 10).filter(o => o.team === h.team && o.isUnit && o.state !== 'dead' && Math.hypot(o.x - h.x, o.z - h.z) <= 10 + (o.r || 0));
    heals.push({ allies, left: 200, per: 200 / 3, until: t + 3, acc: 0 });
    emit('ability', { hero: h, id: 'rootbind', x: cx, z: cz, targets: rooted, allies, r: 8, healR: 10, duration: 3 });
    return true;
  }

  function updateEffects(dt) {
    const t = now();
    for (let i = dashes.length - 1; i >= 0; i--) {
      const d = dashes[i]; d.t += dt;
      const f = Math.min(1, d.t / d.dur), h = d.h;
      if (h.state !== 'dead') { h.x = d.x0 + (d.x1 - d.x0) * f; h.z = d.z0 + (d.z1 - d.z0) * f; h.mesh?.position?.set?.(h.x, 0, h.z); }
      if (f >= 1) dashes.splice(i, 1);
    }
    for (let i = patches.length - 1; i >= 0; i--) {
      const p = patches[i];
      if (t > p.until) { patches.splice(i, 1); continue; }
      p.tick += dt;
      while (p.tick >= 0.5) {
        p.tick -= 0.5;
        for (const o of enemiesNear(p.team, p.x, p.z, p.r)) sim.damage(o, p.hero?.state !== 'dead' ? p.hero : null, 40 * 0.5);
      }
    }
    for (let i = heals.length - 1; i >= 0; i--) {
      const hl = heals[i];
      hl.acc += dt;
      while (hl.acc >= 0.5 && hl.left > 0) {
        hl.acc -= 0.5;
        const amt = Math.min(hl.left, hl.per * 0.5); hl.left -= amt;
        for (const a of hl.allies) if (a.state !== 'dead') a.hp = Math.min(a.hpMax, a.hp + amt);
      }
      if (hl.left <= 0 || t > hl.until + 0.6) heals.splice(i, 1);
    }
  }

  // ------------------------------------------------------------ per-frame hero logic
  function heroTick(st, dt) {
    const h = st.hero, hm = h._hm, def = DEFS[h.faction], t = now();
    if (!simV2) syncFields(h);
    // Ironclad passive / bulwark
    if (def.passiveMul) { const s = h.status || (h.status = {}); s.until = undefined; s.dmgMul = h._bulwarkUntil > t ? 0.3 : def.passiveMul; }
    // Magmablade: rifle at range, blade (x2.5) up close; charges in when the target is near
    if (h.faction === 'volcanic') {
      const tg = h.target && h.target.state !== 'dead' ? h.target : null;
      const d = tg ? Math.hypot(tg.x - h.x, tg.z - h.z) - (tg.r || 0) : Infinity;
      const blade = d <= def.bladeRange + 0.2 || (d <= 9 && tg?.isUnit);
      h.stats.range = blade ? 4.5 : def.stats.range;
      h.stats.dps = d <= def.bladeRange + 0.2 ? def.stats.dps * def.bladeMul : def.stats.dps;
      setMagmaMode(hm, blade ? 'blade' : 'rifle');
      if (!simV2) syncFields(h);
    }
    // AI auto-cast
    if (st.team !== 0 && st.cdUntil <= t) {
      if (def.ability === 'bulwark') {
        const n = enemiesNear(h.team, h.x, h.z, def.castRange, true).length;
        if (n >= 2 || (h.hp < h.hpMax * 0.4 && n >= 1)) cast(h, 'bulwark');
      } else if (enemiesNear(h.team, h.x, h.z, def.castRange, true).length >= 2) cast(h, def.ability, h.target);
    }
    animate(h, hm, dt);
  }

  function animate(h, hm, dt) {
    const root = hm.root;
    root.visible = !h.hidden;
    hm.chev.position.y = hm.height + 0.55 + Math.sin(now() * 3) * 0.15;
    hm.chev.rotation.y += dt * 2;
    const p = root.position;
    if (hm.last && dt > 0) { const v = Math.hypot(p.x - hm.last.x, p.z - hm.last.z) / dt; hm.speed += (Math.min(v, 30) - hm.speed) * Math.min(1, dt * 8); }
    hm.last = hm.last || {}; hm.last.x = p.x; hm.last.z = p.z;
    const sol = hm.sol; if (!sol) return;
    const melee = h.faction === 'storm' || (h.faction === 'volcanic' && hm.mode === 'blade');
    let want = 'idle';
    if (hm.speed > 0.6 || h.state === 'move') want = 'walk';
    else if (h.state === 'attack' && h.target) want = melee && sol.actions.melee ? 'melee' : 'fire';
    if (sol.current !== want) sol.play(want, 0.2);
    const a = sol.actions[want];
    if (a) {
      if (want === 'walk') a.timeScale = Math.max(0.8, Math.min(2.2, hm.speed / ((chars?.WALK_SPEED || 1.2) * (hm.height / 2.2))));
      else if (want === 'fire' || want === 'melee') a.timeScale = Math.max(0.7, Math.min(1.8, a.getClip().duration / (h.fireRate || 1)));
      else a.timeScale = 1;
    }
    if (root.visible) sol.mixer.update(dt);
  }

  // death: replay 'die' on our mesh, then fade out
  const dying = [];
  bus.addEventListener('died', (ev) => {
    const e = ev.detail?.entity;
    if (!e?.hero || !e._hm) return;
    const st = T[e.team];
    if (st && st.hero === e) { st.hero = null; st.state = 'dead'; st.respawnAt = now() + RESPAWN_T; if (e.team === 0) message(`${DEFS[e.faction]?.name || 'Hero'} has fallen — respawn in ${RESPAWN_T}s`, 3000); }
    const hm = e._hm;
    hm.root.userData.entity = null;
    hm.root.position.set(e.x, 0, e.z);
    if (!hm.root.parent) world.scene.add(hm.root);
    hm.ring.visible = hm.chev.visible = false;
    if (hm.sol) hm.sol.play('die', 0.15);
    dying.push({ hm, t: 0 });
  });
  function updateDying(dt) {
    for (let i = dying.length - 1; i >= 0; i--) {
      const d = dying[i]; d.t += dt;
      d.hm.sol?.mixer.update(dt);
      if (d.t > 3.5) d.hm.root.position.y = -(d.t - 3.5) * 1.2; // sink into the ground
      if (d.t > 5) { d.hm.root.parent?.remove(d.hm.root); dying.splice(i, 1); }
    }
  }

  // ------------------------------------------------------------ HUD button
  const hud = makeHud();
  function makeHud() {
    const root = document.getElementById('hud'); if (!root) return null;
    const def = DEFS[factionOf(0)];
    if (!document.getElementById('v-hero-css')) {
      const css = document.createElement('style'); css.id = 'v-hero-css';
      css.textContent = `
.v-hero { position: absolute; right: calc(14px + var(--sar, 0px)); bottom: calc(118px + var(--sab, 0px)); display: none;
  flex-direction: column; align-items: center; gap: 2px; pointer-events: none; }
.v-hero.on { display: flex; }
#hud .v-hero button { width: 56px; height: 56px; border-radius: 50%; padding: 0; position: relative; overflow: visible;
  border: 2px solid #ffc840; box-shadow: 0 0 10px rgba(255,200,64,0.45); background: radial-gradient(circle at 50% 35%, #26384a, #0b1118 75%); }
#hud .v-hero button.cd { border-color: #6b7a88; box-shadow: none; }
#hud .v-hero button.ready { animation: vHeroPulse 1.6s ease-in-out infinite; }
@keyframes vHeroPulse { 50% { box-shadow: 0 0 18px rgba(255,200,64,0.85); } }
.v-hero svg.rings { position: absolute; inset: -5px; width: 66px; height: 66px; pointer-events: none; transform: rotate(-90deg); }
.v-hero svg.glyph { width: 32px; height: 32px; display: block; margin: auto; }
.v-hero .lbl { font-size: 11px; font-weight: 700; color: #ffe08a; text-shadow: 0 1px 2px #000; white-space: nowrap; text-align: center; line-height: 1.15; }
.v-hero .lbl small { display: block; font-weight: 600; color: #8feaff; font-size: 11px; }
.v-hero .cdt { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 16px; color: #fff; text-shadow: 0 1px 3px #000; }`;
      document.head.appendChild(css);
    }
    const GLYPH = {
      vanguard: '<path d="M16 3 L27 7 V15 C27 22 22 27 16 29 C10 27 5 22 5 15 V7 Z" fill="none" stroke="#39d8ff" stroke-width="2.4"/><path d="M11 15 h10 M16 10 v10" stroke="#ffc840" stroke-width="2.4"/>',
      storm: '<path d="M18 2 L7 18 H15 L12 30 L25 12 H17 Z" fill="#bfe4ff" stroke="#fff" stroke-width="0.8"/>',
      volcanic: '<path d="M16 2 C20 9 26 12 24 20 C23 26 19 29 16 29 C11 29 7 25 8 19 C9 15 12 14 12 9 C14 11 15 13 15 15 C17 11 17 7 16 2 Z" fill="#ff6a1a"/><path d="M16 17 C18 20 19 23 16 26 C13 24 14 20 16 17 Z" fill="#ffd27a"/>',
      earth: '<path d="M6 26 C6 14 14 5 27 4 C27 17 19 26 6 26 Z" fill="#4f9f3a"/><path d="M6 26 L22 9" stroke="#ffc84a" stroke-width="2"/>',
    };
    const wrap = document.createElement('div'); wrap.className = 'v-hero';
    const btn = document.createElement('button'); btn.type = 'button'; btn.setAttribute('aria-label', def.name);
    const C = 2 * Math.PI * 30;
    btn.innerHTML = `<svg class="rings" viewBox="0 0 66 66"><circle cx="33" cy="33" r="30" fill="none" stroke="rgba(0,0,0,0.35)" stroke-width="4"/>
      <circle class="pr" cx="33" cy="33" r="30" fill="none" stroke="#ffc840" stroke-width="4" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C}"/></svg>
      <svg class="glyph" viewBox="0 0 32 32">${GLYPH[factionOf(0)] || GLYPH.vanguard}</svg><div class="cdt"></div>`;
    const lbl = document.createElement('div'); lbl.className = 'lbl';
    wrap.append(btn, lbl); root.appendChild(wrap);
    const pr = btn.querySelector('.pr'), cdt = btn.querySelector('.cdt'), glyph = btn.querySelector('svg.glyph');
    let pressT = 0, longFired = false, timer = null;
    btn.addEventListener('pointerdown', (e) => {
      e.stopPropagation(); pressT = performance.now(); longFired = false;
      clearTimeout(timer);
      timer = setTimeout(() => { const h = T[0].hero; if (h) { longFired = true; selectHero(h); } }, 500);
    });
    const end = (e) => { e?.stopPropagation?.(); clearTimeout(timer); };
    btn.addEventListener('pointerup', (e) => { end(e); if (!longFired) onTap(); });
    btn.addEventListener('pointercancel', end);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    return { wrap, btn, lbl, pr, cdt, glyph, C, def, key: '' };
  }
  function selectHero(h) {
    const sel = world.input?.selected; if (!sel) return;
    sel.clear(); sel.add(h);
    world.jumpTo?.(h.x, h.z);
    emit('select', { selected: sel });
  }
  function onTap() {
    const st = T[0];
    if (st.state === 'none') { train(0); return; }
    if (st.state !== 'alive' || !st.hero) return;
    const h = st.hero, def = DEFS[h.faction];
    if (st.cdUntil > now()) { message(`${def.abilityName} recharging`, 1000); return; }
    if (!cast(h, def.ability)) message('No target in range', 1200);
  }
  function updateHud() {
    if (!hud) return;
    const st = T[0], t = now(), def = hud.def;
    const sel = world.input?.selected;
    const ccSel = sel && [...sel].some(e => e.kind === 'cc' && e.team === 0);
    const show = st.state !== 'none' || ccSel;
    let frac = 0, label = '', sub = '', cd = '', cls = '';
    if (st.state === 'none') { label = def.name; sub = `◆ ${COST}`; frac = 0; cls = (world.sim?.crystals?.[0] ?? 0) >= COST ? 'ready' : 'cd'; }
    else if (st.state === 'training') { label = def.name; sub = `Training ${Math.ceil(st.total - st.t)}s`; frac = st.t / st.total; cls = 'cd'; }
    else if (st.state === 'dead') { label = def.name; const left = Math.max(0, st.respawnAt - t); sub = `Respawn ${Math.ceil(left)}s`; frac = 1 - left / RESPAWN_T; cls = 'cd'; cd = Math.ceil(left) + ''; }
    else { // alive: ability
      const left = Math.max(0, st.cdUntil - t);
      label = def.abilityName; frac = left > 0 ? 1 - left / def.cd : 1; cls = left > 0 ? 'cd' : 'ready';
      cd = left > 0 ? Math.ceil(left) + '' : '';
      sub = st.hero ? `${Math.ceil(st.hero.hp)} hp` : '';
    }
    const key = `${show}|${label}|${sub}|${cd}|${cls}|${Math.round(frac * 100)}`;
    if (key === hud.key) return;
    hud.key = key;
    hud.wrap.classList.toggle('on', !!show);
    hud.btn.className = cls;
    hud.lbl.innerHTML = `${label}<small>${sub}</small>`;
    hud.cdt.textContent = cd;
    hud.glyph.style.opacity = cd ? 0.35 : 1;
    hud.pr.setAttribute('stroke-dashoffset', String(hud.C * (1 - Math.max(0, Math.min(1, frac)))));
    hud.pr.setAttribute('stroke', st.state === 'alive' ? def.color : '#ffc840');
  }

  // ------------------------------------------------------------ frame
  let lastStamp = -1;
  function update(dtIn) {
    const stamp = world.clock?.t;
    if (stamp === lastStamp) return; // guard against being driven twice per frame
    lastStamp = stamp;
    const dt = typeof dtIn === 'number' ? dtIn : world.clock?.dt ?? 0;
    if (world.ui?.gameOver) { updateDying(dt); updateHud(); return; }
    const t = now();
    for (const st of T) {
      if (st.state === 'training') {
        if (!ccOf(st.team)) { st.state = 'none'; continue; }
        st.t += dt;
        if (st.t >= st.total) spawnAtCc(st.team) || (st.state = 'none');
      } else if (st.state === 'dead') {
        if (t >= st.respawnAt) { if (ccOf(st.team)) spawnAtCc(st.team); else st.state = 'none'; }
      } else if (st.state === 'alive') {
        const h = st.hero;
        if (!h || h.state === 'dead' || !ents.includes(h)) {
          if (st.state === 'alive') { st.state = 'dead'; st.hero = null; st.respawnAt = t + RESPAWN_T; }
          continue;
        }
        heroTick(st, dt);
      } else if (st.team !== 0 && st.state === 'none') {
        if ((sim.time ?? t) >= AI_MIN_T && (sim.crystals?.[st.team] ?? 0) >= AI_MIN_CR && ccOf(st.team)) train(st.team);
      }
    }
    updateEffects(dt);
    enforceFallback();
    updateDying(dt);
    updateHud();
  }
  world.onFrame?.((dt) => update(dt));

  const api = {
    cast, update, train, spawnNow: (team, x, z) => (x != null ? spawnHero(team, x, z) : spawnAtCc(team)),
    list: () => T.map(s => s.hero).filter(Boolean),
    get: (team) => T[team]?.hero || null,
    state: T, defs: DEFS, cost: COST, select: selectHero,
    get patches() { return patches; },
  };
  world.heroes = api;
  return api;
}
