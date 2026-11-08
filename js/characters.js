// Vanguard characters: animated power-armor soldiers from assets/chars/soldier.glb (built by
// tools/convert-soldier.mjs from the Mixamo clips). Owner: Engine (GRAPHICS-A).
// The GLB is one SkinnedMesh (rigid-skinned armor pieces + rifle on the right hand), one material.
// Vertex colour RGBA: rgb = albedo, a = how much the team colour tints it. Near-black verts = visor
// (glossy + teal glow) and bright cyan verts = light strips (emissive); both handled in the shader patch.
// TODO.md (characters): add a real 'idle with rifle' clip if the user exports one from Mixamo.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

export const SOLDIER_HEIGHT = 1.6;          // world units (helmet top)
const SRC_HEIGHT = 186;                      // rig units (cm) at the helmet top, from the converter bbox
export const WALK_SPEED = 1.19 * SOLDIER_HEIGHT / 1.86; // world u/s that the walk clip covers at timeScale 1
export const TEAM_COLORS = { 0: 0x2f6fe0, 1: 0xc8322e };

let template = null;
const clips = {};
const mats = new Map();

function teamMaterial(team) {
  if (mats.has(team)) return mats.get(team);
  const m = new THREE.MeshStandardMaterial({
    color: TEAM_COLORS[team] ?? 0x9aa3ad, vertexColors: true, metalness: 0.4, roughness: 0.5,
  });
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <color_fragment>', `
  #if defined( USE_COLOR_ALPHA )
    float vSum = vColor.r + vColor.g + vColor.b;
    diffuseColor.rgb = vColor.rgb * mix( vec3( 1.0 ), diffuseColor.rgb, vColor.a );
  #else
    float vSum = 3.0;
  #endif`)
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = vSum < 0.15 ? 0.12 : roughness;`)
      .replace('#include <metalnessmap_fragment>', `float metalnessFactor = vSum < 0.15 ? 0.9 : metalness;`)
      .replace('#include <emissivemap_fragment>', `
  #if defined( USE_COLOR_ALPHA )
    if ( vSum < 0.15 ) totalEmissiveRadiance += vec3( 0.04, 0.32, 0.42 );
    else if ( vColor.b > 0.9 && vColor.r < 0.7 && vColor.a < 0.1 ) totalEmissiveRadiance += vec3( 0.25, 0.75, 0.9 );
  #endif`);
  };
  mats.set(team, m);
  return m;
}

// Loads the GLB once. Resolves to true on success; throws on failure (engine falls back to primitives).
export async function loadCharacters(world) {
  const gltf = await new GLTFLoader().loadAsync('assets/chars/soldier.glb');
  template = gltf.scene;
  for (const c of gltf.animations) clips[c.name] = c;
  for (const n of ['idle', 'walk', 'fire', 'die']) if (!clips[n]) throw new Error('soldier.glb missing clip ' + n);
  template.traverse((o) => { if (o.isSkinnedMesh) { o.geometry.computeBoundingSphere(); } });
  world && (world.characters = { clips: Object.keys(clips), height: SOLDIER_HEIGHT });
  return true;
}
export const charactersReady = () => !!template;

// One soldier: { root, mixer, actions, play(name, fade), current }. Faces local +X like every engine model.
export function makeSoldier(team) {
  if (!template) throw new Error('characters not loaded');
  const body = SkeletonUtils.clone(template);
  const m = teamMaterial(team);
  body.traverse((o) => {
    if (o.isSkinnedMesh) {
      o.material = m; o.castShadow = true; o.receiveShadow = false;
      o.frustumCulled = false; // engine culls whole squads itself (rest-pose bounds are wrong once animated)
    }
  });
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
