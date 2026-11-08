// Vanguard characters: animated power-armor soldiers from assets/chars/soldier.glb (built by
// tools/convert-soldier.mjs from the Mixamo clips). Owner: Engine (GRAPHICS-A).
// The GLB is one SkinnedMesh (rigid-skinned armor pieces + rifle on the right hand), one material.
// Vertex colour RGBA: rgb = albedo, a = how much the team colour tints it. Near-black verts = visor
// (glossy + teal glow) and bright cyan verts = light strips (emissive); both handled in the shader patch.
// TODO.md (characters): add a real 'idle with rifle' clip if the user exports one from Mixamo.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

export const SOLDIER_HEIGHT = 1.9;          // world units (helmet top)
const SRC_HEIGHT = 188;                      // rig units (cm) at the helmet top, from the converter bbox
export const WALK_SPEED = 1.19 * SOLDIER_HEIGHT / 1.86; // world u/s that the walk clip covers at timeScale 1
export const TEAM_COLORS = { 0: 0x2f6fe0, 1: 0xc8322e };

let template = null;
const clips = {};
const mats = new Map();

// Faction looks. The GLB's vertex colours carry part classes (see tools/convert-soldier.html C table):
// body (a=1,rgb=1), mid (a=1,rgb=.8), trim (a=1,rgb=.62), light (a=.55), visor (near black),
// glow strips (cyan), gun-light (grey .42). Each faction maps the classes to colour/emissive.
const hex = (h) => new THREE.Color(h);
export const FACTIONS = ['vanguard', 'volcanic', 'earth', 'storm']; // default faction per team index
const STYLE = {
  vanguard: { // Vanguard industrial: steel-blue painted plates, yellow hazard trim, welder visor (thin cyan strip)
    body: hex(0x2f5f8f), mid: hex(0x264c72), light: hex(0x4a78a6), rough: 0.5, metal: 0.45,
    trimCol: hex(0xe0b020), trimEm: hex(0x000000), visorEm: hex(0x0a1418),
    glowEm: hex(0x39d8ff).multiplyScalar(0.9), gunEm: hex(0x000000),
  },
  volcanic: { // Volcanic Clans: blackened iron/obsidian, magma seams, ember lenses, glowing barrel
    body: hex(0x1c1715), mid: hex(0x2a211d), light: hex(0x3a2b24), rough: 0.55, metal: 0.5,
    trimCol: hex(0x110d0b), trimEm: hex(0xff6a1a).multiplyScalar(1.3), visorEm: hex(0xff6a1a).multiplyScalar(2.0),
    glowEm: hex(0xff6a1a).multiplyScalar(1.8), gunEm: hex(0xff4a10).multiplyScalar(0.55),
  },
  earth: { // Earth Cult: bark-brown plates, faint gold markings, golden sun visor
    body: hex(0x5a3e26), mid: hex(0x4a3320), light: hex(0x6e5034), rough: 0.8, metal: 0.05,
    trimCol: hex(0xc9a227), trimEm: hex(0xc9a227).multiplyScalar(0.15), visorEm: hex(0xffc84a).multiplyScalar(1.6),
    glowEm: hex(0xffc84a).multiplyScalar(1.2), gunEm: hex(0x000000), scaleY: 1.25, hideGun: true, // crossbow instead
  },
  storm: { // Storm Nomads: bone-white armor, crimson sailcloth, blue-white electric visor
    body: hex(0xe8e2d0), mid: hex(0xcfc7b2), light: hex(0xf4f0e6), rough: 0.6, metal: 0.1,
    trimCol: hex(0x9a1f1f), trimEm: hex(0x000000), visorEm: hex(0xbfe4ff).multiplyScalar(2.0),
    glowEm: hex(0x9fd8ff).multiplyScalar(1.6), gunEm: hex(0x6fbfff).multiplyScalar(0.4),
  },
};
const factionOf = (team, f) => (STYLE[f] ? f : FACTIONS[team] || 'vanguard');

function teamMaterial(faction, hero = false) {
  const key = faction + (hero ? ':hero' : '');
  if (mats.has(key)) return mats.get(key);
  const base = STYLE[faction] || STYLE.vanguard, k = hero ? 1.5 : 1, st = { ...base };
  for (const n of ['trimEm', 'visorEm', 'glowEm', 'gunEm']) st[n] = base[n].clone().multiplyScalar(k);
  const m = new THREE.MeshStandardMaterial({
    color: st.body, vertexColors: true, metalness: st.metal, roughness: st.rough,
    envMapIntensity: 1.0, // lit by scene.environment (engine scales it, see trackEnv)
  });
  const U = { uTrimCol: { value: st.trimCol }, uMid: { value: st.mid }, uLight: { value: st.light }, uTrimEm: { value: st.trimEm },
    uVisorEm: { value: st.visorEm }, uGlowEm: { value: st.glowEm }, uGunEm: { value: st.gunEm },
    uHideGun: { value: st.hideGun ? 1 : 0 } };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.fragmentShader = 'uniform vec3 uTrimCol, uMid, uLight, uTrimEm, uVisorEm, uGlowEm, uGunEm;\nuniform float uHideGun;\n' + sh.fragmentShader
      .replace('#include <color_fragment>', `
  float vSum = 3.0; vec3 partEm = vec3(0.0);
  #if defined( USE_COLOR_ALPHA )
    vSum = vColor.r + vColor.g + vColor.b;
    if ( uHideGun > 0.5 && vColor.a > 0.1 && vColor.a < 0.3 ) discard;   // rifle verts (a=0.2) for non-rifle factions
    if ( vColor.a > 0.9 ) {
      if ( vColor.r > 0.9 ) diffuseColor.rgb = diffuseColor.rgb;          // body: faction colour
      else if ( vColor.r > 0.72 ) diffuseColor.rgb = uMid;                // mid plates
      else { diffuseColor.rgb = uTrimCol; partEm = uTrimEm; } // trim: hazard paint / magma seams
    } else if ( vColor.a > 0.3 ) diffuseColor.rgb = uLight;               // light plates
    else if ( vSum < 0.15 ) { diffuseColor.rgb = vec3(0.01); partEm = uVisorEm; }
    else if ( vColor.b > 0.9 && vColor.r < 0.7 ) { diffuseColor.rgb = vec3(0.05); partEm = uGlowEm; }
    else { diffuseColor.rgb = vColor.rgb; if ( vColor.r > 0.35 && vColor.r < 0.5 ) partEm = uGunEm; }
  #endif`)
      .replace('#include <emissivemap_fragment>', `totalEmissiveRadiance += partEm;`);
  };
  mats.set(key, m);
  return m;
}

// ---- bone attachments (faction gear), authored in rig space (cm, T-pose, facing +Z) like the converter
const attach = {}; // team -> { head, headLeader, cape, glow, glowLeader } BufferGeometry in bone-local space
const attachMats = {};
function buildAttachments() {
  const rest = {}; // bone name -> inverse rest matrixWorld (rig space -> bone local)
  template.updateMatrixWorld(true);
  template.traverse((o) => { if (o.isBone) rest[o.name] = o.matrixWorld.clone().invert(); });
  const P = (n) => new THREE.Vector3().setFromMatrixPosition(rest['mixamorig' + n].clone().invert());
  const H = P('Head'), S2 = P('Spine2');
  const put = (g, at, off, rot = [0, 0, 0], col = 0xffffff) => {
    g = g.index ? g.toNonIndexed() : g; g.deleteAttribute('uv');
    g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...rot)));
    g.translate(at.x + off[0], at.y + off[1], at.z + off[2]);
    const c = new THREE.Color(col), n = g.attributes.position.count, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    return g;
  };
  const merge = (list, bone) => {
    let n = 0; for (const g of list) n += g.attributes.position.count;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3); let o = 0;
    for (const g of list) { pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3); col.set(g.attributes.color.array, o * 3); o += g.attributes.position.count; }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3)); out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (bone === 'gunMount') out.userData.bone = 'gunMount'; // authored directly in the mount frame
    else { out.applyMatrix4(rest['mixamorig' + bone]); out.userData.bone = 'mixamorig' + bone; }
    out.computeBoundingSphere();
    return out;
  };
  const IRON = 0x2a2420, IRON2 = 0x3b322c, ASH = 0x6a2a20, ASH2 = 0x4e1f19;
  // Volcanic Clans: respirator mask + side filters (+ horns for the squad leader), ember lenses, ash-red cape
  const head = () => [
    put(new THREE.BoxGeometry(12, 10, 8), H, [0, 4, 14.5], [0.25, 0, 0], IRON),                // snout
    put(new THREE.CylinderGeometry(3.6, 3.6, 3, 8), H, [0, 1.5, 18.8], [Math.PI / 2 + 0.25, 0, 0], IRON2), // intake
    ...[-1, 1].map((sx) => put(new THREE.CylinderGeometry(3.8, 3.8, 9, 8), H, [sx * 10.5, 2, 10], [0.9, 0, sx * 0.5], IRON2)), // filters
  ];
  const horns = () => [-1, 1].map((sx) => put(new THREE.ConeGeometry(2.6, 13, 6), H, [sx * 9, 23, 1], [-0.25, 0, -sx * 0.55], 0xd8c7a0));
  const lenses = () => [-1, 1].map((sx) => put(new THREE.CylinderGeometry(2.9, 2.9, 2, 10), H, [sx * 5.6, 11, 14.6], [Math.PI / 2 - 0.1, 0, 0], 0xffffff));
  const cape = [];
  [[-10, 46, 0.22, ASH], [0, 40, 0.18, ASH2], [10, 50, 0.25, ASH]].forEach(([x, h, tilt, c]) => cape.push(put(new THREE.BoxGeometry(11, h, 1.4), S2, [x, 14 - h / 2, -32 - h * 0.12], [tilt, 0, 0], c)));
  attach.volcanic = { head: merge(head(), 'Head'), headLeader: merge([...head(), ...horns()], 'Head'), glow: merge(lenses(), 'Head'), cape: merge(cape, 'Spine2') };
  // Vanguard industrial: welder visor plate (dark glass) with a thin cyan strip, chunky rebreather;
  // the squad leader adds a yellow helmet stripe
  const vHead = () => [
    put(new THREE.BoxGeometry(24, 9, 3), H, [0, 11, 14.4], [0, 0, 0], 0x0b0f12),               // welder glass
    put(new THREE.BoxGeometry(14, 9, 9), H, [0, 2.5, 14], [0.2, 0, 0], 0x3a3f45),              // rebreather
    ...[-1, 1].map((sx) => put(new THREE.CylinderGeometry(3, 3, 6, 8), H, [sx * 8.5, 1, 13], [Math.PI / 2, 0, 0], 0x23272c)),
  ];
  attach.vanguard = {
    head: merge(vHead(), 'Head'),
    headLeader: merge([...vHead(), put(new THREE.BoxGeometry(5, 3, 30), H, [0, 25.3, 1], [0, 0, 0], 0xe0b020)], 'Head'),
    glow: merge([put(new THREE.BoxGeometry(20, 1.4, 1), H, [0, 11.5, 16.1], [0, 0, 0], 0x39d8ff)], 'Head'),
  };
  // Earth Cult: leafy shoulder mantle; Storm Nomads: crimson sailcloth wraps over shoulders + hanging tails
  const LEAF = [0x3f6b2a, 0x4f7f32, 0x35592a];
  const mantle = [];
  for (let i = 0; i < 12; i++) { // leaf shingles draped over both shoulders and the upper back
    const x = (i % 6 / 5 - 0.5) * 50, row = i < 6 ? 0 : 1, sx = Math.sign(x) || 1;
    const g = new THREE.ConeGeometry(8.5, 18, 4); g.scale(1, 1, 0.35);
    mantle.push(put(g, S2, [x, 31 - Math.abs(x) * 0.18 - row * 5, row ? -16 : 2], [row ? 0.9 : -0.5, 0, -sx * (0.7 + Math.abs(x) * 0.02)], LEAF[i % 3]));
  }
  for (let i = 0; i < 9; i++) { // leafy cloak hanging over the back pack
    const g = new THREE.ConeGeometry(9, 22, 4); g.scale(1, 1, 0.3);
    mantle.push(put(g, S2, [((i % 3) - 1) * 13, 22 - Math.floor(i / 3) * 13, -33 - Math.floor(i / 3) * 1.5], [Math.PI + 0.15, 0, ((i % 3) - 1) * 0.25], LEAF[(i + 1) % 3]));
  }
  attach.earth = { cape: merge(mantle, 'Spine2'), glow: merge([put(new THREE.BoxGeometry(22, 3.5, 2), H, [0, 11, 15.4], [0, 0, 0], 0xffc84a)], 'Head') };
  const CR = 0x8c1c1c, CR2 = 0x6e1616;
  attach.storm = {
    cape: merge([put(new THREE.BoxGeometry(50, 6, 34), S2, [0, 17, -2], [0, 0, 0], CR), put(new THREE.BoxGeometry(9, 40, 1.2), S2, [-6, -6, -31], [0.2, 0, 0.05], CR2), put(new THREE.BoxGeometry(8, 30, 1.2), S2, [7, -2, -31], [0.25, 0, -0.08], CR)], 'Spine2'),
    head: merge([put(new THREE.TorusGeometry(15, 3, 6, 14), H, [0, 3, 0], [Math.PI / 2, 0, 0], CR)], 'Head'),
    glow: merge([put(new THREE.BoxGeometry(22, 3, 2), H, [0, 11, 15.4], [0, 0, 0], 0xbfe4ff)], 'Head'),
  };
  // ---- weapons / exo parts. gunMount frame: +Z muzzle, +Y up, origin at the grip (cm)
  const O = new THREE.Vector3(), HIP = P('Hips');
  const WOOD = 0x5a3e26, WOOD2 = 0x3e2a19, GOLD = 0xc9a227, BONE = 0xd8c7a0, STEEL = 0x8a9099, DARKM = 0x2a2d31;
  attach.earth.more = [
    [merge([put(new THREE.BoxGeometry(5, 6, 38), O, [0, 1, 8], [0, 0, 0], WOOD),                       // crossbow stock
      ...[-1, 1].map((sx) => put(new THREE.BoxGeometry(30, 3, 3.5), O, [sx * 14, 3, 31], [0, sx * 0.35, 0], WOOD2)), // limbs
      ...[-1, 1].map((sx) => put(new THREE.BoxGeometry(3, 4, 4), O, [sx * 28, 3, 26], [0, 0, 0], GOLD)),
      put(new THREE.BoxGeometry(55, 0.8, 0.8), O, [0, 3, 24], [0, 0, 0], 0xd0c8b0),                      // string
      put(new THREE.CylinderGeometry(0.9, 0.9, 30, 5), O, [0, 5, 22], [Math.PI / 2, 0, 0], BONE)], 'gunMount'), 'dark'],
  ];
  attach.storm.more = [
    [merge([put(new THREE.CylinderGeometry(1.7, 1.7, 30, 6), HIP, [-20, -12, 5], [0, 0, 0.12], DARKM),   // shock hammer on right hip
      put(new THREE.BoxGeometry(9, 9, 13), HIP, [-22, -29, 5], [0, 0, 0.12], STEEL)], 'Hips'), 'dark'],
    [merge([put(new THREE.BoxGeometry(9.6, 2.4, 13.6), HIP, [-22, -29, 5], [0, 0, 0.12], 0xbfe4ff)], 'Hips'), 'glow'],
  ];
  attach.volcanic.more = [
    [merge([put(new THREE.CylinderGeometry(1.6, 1.6, 11, 6), HIP, [20, 2, 4], [0, 0, -0.12], IRON2),    // hip blade hilt + guard
      put(new THREE.BoxGeometry(9, 1.8, 4), HIP, [20.5, -4, 4], [0, 0, -0.12], IRON)], 'Hips'), 'dark'],
    [merge([put(new THREE.BoxGeometry(1.8, 28, 5.5), HIP, [22.5, -19, 4], [0, 0, -0.12], 0xff6a1a)], 'Hips'), 'glow'],
  ];
  attach.vanguard.more = ['Left', 'Right'].map((sd) => { // exo leg pistons
    const sx = sd === 'Left' ? 1 : -1, U = P(sd + 'UpLeg');
    return [merge([put(new THREE.CylinderGeometry(1.5, 1.5, 34, 6), U, [sx * 12.5, -22, -3], [0, 0, 0], STEEL),
      put(new THREE.CylinderGeometry(2.6, 2.6, 12, 6), U, [sx * 12.5, -9, -3], [0, 0, 0], DARKM),
      put(new THREE.BoxGeometry(5, 2.5, 5), U, [sx * 12.5, -2, -3], [0, 0, 0], 0xe0b020)], sd + 'UpLeg'), 'dark'];
  });
  attachMats.dark = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.4 });
  attachMats.glow1 = new THREE.MeshBasicMaterial({ color: hex(0xff6a1a).multiplyScalar(1.6), toneMapped: true });
  attachMats.glow0 = new THREE.MeshBasicMaterial({ vertexColors: true, color: hex(0xffffff).multiplyScalar(1.5) });
  attachMats.glowHero = new THREE.MeshBasicMaterial({ vertexColors: true, color: hex(0xffffff).multiplyScalar(2.4) });
}
// Adds faction gear to a soldier body (anything containing the mixamorig bones). Used by makeSoldier and
// by js/heroes.js for hero variants ({hero:true} → leader head + brighter glow).
export function attachFactionProps(body, faction, { hero = false, leader = false } = {}) {
  const set = attach[faction]; if (!set) return;
  leader = leader || hero;
  const add = (geo, mat) => {
    if (!geo) return;
    const bone = body.getObjectByName(geo.userData.bone); if (!bone) return;
    const m = new THREE.Mesh(geo, mat); m.castShadow = mat.isMeshStandardMaterial; m.frustumCulled = false; bone.add(m);
  };
  add(leader && set.headLeader ? set.headLeader : set.head, attachMats.dark);
  add(set.cape, attachMats.dark);
  add(set.glow, faction === 'volcanic' ? attachMats.glow1 : hero ? attachMats.glowHero : attachMats.glow0);
  for (const [geo, kind] of set.more || []) add(geo, kind === 'glow' ? (hero ? attachMats.glowHero : attachMats.glow0) : attachMats.dark);
}

// Loads the GLB once. Resolves to true on success; throws on failure (engine falls back to primitives).
export async function loadCharacters(world) {
  const gltf = await new GLTFLoader().loadAsync('assets/chars/soldier.glb');
  template = gltf.scene;
  for (const c of gltf.animations) clips[c.name] = c;
  for (const n of ['idle', 'walk', 'fire', 'die']) if (!clips[n]) throw new Error('soldier.glb missing clip ' + n);
  template.traverse((o) => { if (o.isSkinnedMesh) { o.geometry.computeBoundingSphere(); } });
  try { buildAttachments(); } catch (err) { console.warn('[characters] faction gear failed', err?.message); }
  world && (world.characters = { clips: Object.keys(clips), height: SOLDIER_HEIGHT });
  return true;
}
export const charactersReady = () => !!template;
export const clipNames = () => Object.keys(clips);

// One soldier: { root, mixer, actions, play(name, fade), current }. Faces local +X like every engine model.
// opts: { faction ('vanguard'|'volcanic'|'earth'|'storm', default by team), leader, hero (1.6x, brighter) }
export function makeSoldier(team, { faction, leader = false, hero = false } = {}) {
  if (!template) throw new Error('characters not loaded');
  faction = factionOf(team, faction);
  const body = SkeletonUtils.clone(template);
  const m = teamMaterial(faction, hero);
  body.traverse((o) => {
    if (o.isSkinnedMesh) {
      o.material = m; o.castShadow = true; o.receiveShadow = false;
      o.frustumCulled = false; // engine culls whole squads itself (rest-pose bounds are wrong once animated)
    }
  });
  attachFactionProps(body, faction, { hero, leader });
  const s = SOLDIER_HEIGHT / SRC_HEIGHT * (hero ? 1.6 : 1);
  body.scale.setScalar(s);
  body.scale.y *= STYLE[faction].scaleY || 1;
  body.rotation.y = Math.PI / 2; // rig faces +Z; engine models face +X
  const root = new THREE.Group(); root.add(body); root.name = 'soldier';
  const mixer = new THREE.AnimationMixer(body);
  const actions = {};
  for (const [n, c] of Object.entries(clips)) {
    const a = mixer.clipAction(c);
    if (n === 'die') { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
    actions[n] = a;
  }
  const sol = {
    root, body, mixer, actions, current: null,
    play(name, fade = 0.2, { offset = Math.random() } = {}) {
      const next = actions[name];
      if (!next || sol.current === name) return next;
      const prev = sol.current ? actions[sol.current] : null;
      next.reset(); next.enabled = true; next.setEffectiveWeight(1);
      if (name !== 'die') next.time = offset * next.getClip().duration;
      next.play();
      if (prev && fade > 0) prev.crossFadeTo(next, fade, false);
      else if (prev) prev.stop();
      sol.current = name;
      return next;
    },
  };
  return sol;
}
