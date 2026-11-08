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
const STYLE = {
  0: { // Vanguard cyberpunk: glossy near-black, cyan visor + neon trim, magenta accents
    body: hex(0x161a22), mid: hex(0x222a3a), light: hex(0x2b3550), rough: 0.26, metal: 0.65,
    trimEm: hex(0x39d8ff).multiplyScalar(1.4), visorEm: hex(0x39d8ff).multiplyScalar(2.0),
    glowEm: hex(0xff3dbd).multiplyScalar(1.6), gunEm: hex(0x000000),
  },
  1: { // Volcanic Clans: blackened iron/obsidian, magma seams, ember lenses, glowing barrel
    body: hex(0x1c1715), mid: hex(0x2a211d), light: hex(0x3a2b24), rough: 0.55, metal: 0.5,
    trimEm: hex(0xff6a1a).multiplyScalar(1.3), visorEm: hex(0xff6a1a).multiplyScalar(2.0),
    glowEm: hex(0xff6a1a).multiplyScalar(1.8), gunEm: hex(0xff4a10).multiplyScalar(0.55),
  },
};

function teamMaterial(team) {
  if (mats.has(team)) return mats.get(team);
  const st = STYLE[team] || STYLE[0];
  const m = new THREE.MeshStandardMaterial({
    color: st.body, vertexColors: true, metalness: st.metal, roughness: st.rough,
    envMapIntensity: 1.0, // lit by scene.environment (engine scales it, see trackEnv)
  });
  const U = { uMid: { value: st.mid }, uLight: { value: st.light }, uTrimEm: { value: st.trimEm },
    uVisorEm: { value: st.visorEm }, uGlowEm: { value: st.glowEm }, uGunEm: { value: st.gunEm } };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.fragmentShader = 'uniform vec3 uMid, uLight, uTrimEm, uVisorEm, uGlowEm, uGunEm;\n' + sh.fragmentShader
      .replace('#include <color_fragment>', `
  float vSum = 3.0; vec3 partEm = vec3(0.0);
  #if defined( USE_COLOR_ALPHA )
    vSum = vColor.r + vColor.g + vColor.b;
    if ( vColor.a > 0.9 ) {
      if ( vColor.r > 0.9 ) diffuseColor.rgb = diffuseColor.rgb;          // body: faction colour
      else if ( vColor.r > 0.72 ) diffuseColor.rgb = uMid;                // mid plates
      else { diffuseColor.rgb = diffuseColor.rgb * 0.6; partEm = uTrimEm; } // trim: neon / magma seams
    } else if ( vColor.a > 0.3 ) diffuseColor.rgb = uLight;               // light plates
    else if ( vSum < 0.15 ) { diffuseColor.rgb = vec3(0.01); partEm = uVisorEm; }
    else if ( vColor.b > 0.9 && vColor.r < 0.7 ) { diffuseColor.rgb = vec3(0.05); partEm = uGlowEm; }
    else { diffuseColor.rgb = vColor.rgb; if ( vColor.r > 0.35 && vColor.r < 0.5 ) partEm = uGunEm; }
  #endif`)
      .replace('#include <emissivemap_fragment>', `totalEmissiveRadiance += partEm;`);
  };
  mats.set(team, m);
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
    out.applyMatrix4(rest['mixamorig' + bone]); out.computeBoundingSphere();
    out.userData.bone = 'mixamorig' + bone;
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
  attach[1] = { head: merge(head(), 'Head'), headLeader: merge([...head(), ...horns()], 'Head'), glow: merge(lenses(), 'Head'), cape: merge(cape, 'Spine2') };
  // Vanguard: cyan visor strip across the helmet front + magenta crest light
  attach[0] = { glow: merge([put(new THREE.BoxGeometry(23, 4.2, 3), H, [0, 11, 14.2], [0, 0, 0]), put(new THREE.BoxGeometry(2, 3, 18), H, [0, 27.2, 2], [0, 0, 0], 0xff3dbd)], 'Head') };
  attachMats.dark = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.4 });
  attachMats.glow1 = new THREE.MeshBasicMaterial({ color: hex(0xff6a1a).multiplyScalar(1.6), toneMapped: true });
  attachMats.glow0 = new THREE.MeshBasicMaterial({ vertexColors: true, color: hex(0xffffff).multiplyScalar(1.5) });
  // cyan for the visor strip: tint the white verts
  const c0 = attach[0].glow.attributes.color; for (let i = 0; i < c0.count; i++) if (c0.getX(i) > 0.99 && c0.getZ(i) > 0.99) c0.setXYZ(i, 0.22, 0.85, 1);
}
function addGear(body, team, leader) {
  const set = attach[team]; if (!set) return;
  const add = (geo, mat) => {
    if (!geo) return;
    const bone = body.getObjectByName(geo.userData.bone); if (!bone) return;
    const m = new THREE.Mesh(geo, mat); m.castShadow = mat.isMeshStandardMaterial; m.frustumCulled = false; bone.add(m);
  };
  if (team === 1) { add(leader ? set.headLeader : set.head, attachMats.dark); add(set.cape, attachMats.dark); add(set.glow, attachMats.glow1); }
  else add(set.glow, attachMats.glow0);
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
export function makeSoldier(team, { leader = false } = {}) {
  if (!template) throw new Error('characters not loaded');
  const body = SkeletonUtils.clone(template);
  const m = teamMaterial(team);
  body.traverse((o) => {
    if (o.isSkinnedMesh) {
      o.material = m; o.castShadow = true; o.receiveShadow = false;
      o.frustumCulled = false; // engine culls whole squads itself (rest-pose bounds are wrong once animated)
    }
  });
  addGear(body, team, leader);
  const s = SOLDIER_HEIGHT / SRC_HEIGHT;
  body.scale.setScalar(s);
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
