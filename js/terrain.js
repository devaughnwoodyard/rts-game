// Vanguard terrain (owner: TERRAIN). v2 map 512x320, five biomes, splat ground, per-biome features, regional haze.
// TODO.md (terrain):
//  - createTerrain(world) is awaited by engine.js before sim spawns: sets world.map, world.biomeAt, world.obstacles,
//    world.ground, world.terrain {update, minimap, biomeAt, features}, world.regionTint.
//  - Ground: ONE mesh, MeshStandardMaterial + onBeforeCompile splat. Diffuse layers live in a DataArrayTexture
//    (512² per layer). Per fragment: splat + mask + top biome (primary + variant) + 2nd biome = 5 samples
//    (+2 normal-array samples on High). Lava cracks, dune ripples, slab joints, oil stains are shader math.
//  - Features: merged per region (props use the same layer array, triplanar, flat shaded), instanced trees/bushes.
//    ~15 draw calls total. Everything is deterministic (seeded) so obstacles match visuals.
//  - Regional haze multiplies (never overwrites) fx.js day/night: each frame we detect whether fx rewrote
//    fog/background/hemi colour since our last write and re-apply our tint on top of fx's value.
//  - fogview.js (fog-of-war overlay, hidden meshes) is created and ticked from here.
import * as THREE from 'three';
import { createFogView, fogPatch, FOG_GLSL } from './fogview.js';

const MAP = { w: 512, h: 320 };
const HW = MAP.w / 2, HH = MAP.h / 2;
// team bases per CONTRACT v2 (cc), crystal field 25u toward center
const BASES = [{ x: -200, z: 110 }, { x: 200, z: -110 }, { x: -200, z: -110 }, { x: 200, z: 110 }];
const CENTER_FIELDS = [{ x: 0, z: 0 }, { x: -110, z: 0 }, { x: 110, z: 0 }];

// ---------------------------------------------------------------- noise (deterministic)
function hash2(ix, iz, s) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(s, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const sm = (t) => t * t * (3 - 2 * t);
function vnoise(x, z, s = 0) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = sm(x - ix), fz = sm(z - iz);
  const a = hash2(ix, iz, s), b = hash2(ix + 1, iz, s), c = hash2(ix, iz + 1, s), d = hash2(ix + 1, iz + 1, s);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}
function fbm(x, z, s = 0, oct = 4) {
  let v = 0, a = 0.5, n = 0;
  for (let i = 0; i < oct; i++) { v += vnoise(x, z, s + i * 17) * a; n += a; a *= 0.5; x *= 2.03; z *= 2.03; }
  return v / n;
}
function vnoise3(x, y, z, s = 0) { // cheap 3D value noise for rock displacement
  const iy = Math.floor(y), fy = sm(y - iy);
  return vnoise(x + iy * 31.7, z, s) * (1 - fy) + vnoise(x + (iy + 1) * 31.7, z, s) * fy;
}
function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const segDist = (px, pz, ax, az, bx, bz) => {
  const dx = bx - ax, dz = bz - az, t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
};

// ---------------------------------------------------------------- biomes
const BIOMES = ['industrial', 'volcanic', 'forest', 'dunes', 'badlands'];
function biomeRaw(x, z) {
  const wx = x + 26 * (fbm(x * 0.011 + 3.1, z * 0.011 - 1.7, 11, 3) - 0.5) * 2;
  const wz = z + 26 * (fbm(x * 0.011 - 7.3, z * 0.011 + 5.2, 23, 3) - 0.5) * 2;
  const east = smoothstep(-20, 20, wx), south = smoothstep(-20, 20, wz);
  const d = (Math.hypot(wx / 150, wz / 80) - 1) * 100;          // ~units outside the central ellipse
  const bad = 1 - smoothstep(-20, 20, d);
  const k = 1 - bad;
  return [(1 - east) * south * k, east * (1 - south) * k, (1 - east) * (1 - south) * k, east * south * k, bad];
}
export function biomeAt(x, z) {
  const w = biomeRaw(x, z);
  return { industrial: w[0], volcanic: w[1], forest: w[2], dunes: w[3], badlands: w[4] };
}

// ---------------------------------------------------------------- texture layers
// tile = world units per texture repeat; tint = linear multiplier; gray = desaturate on load (tinted per-vertex)
const LAYERS = [
  { f: 'ph/concrete_floor_worn_001', tile: 9, lum: 0.5, tint: [1.04, 1.0, 0.95] },      // 0 industrial concrete
  { f: 'ph/aerial_asphalt_01', tile: 20, lum: 0.3, tint: [0.95, 0.95, 1.0] },          // 1 asphalt
  { f: 'ph/dark_rock', tile: 11, lum: 0.2, tint: [1.0, 0.92, 0.9] },                   // 2 basalt
  { f: 'ph/cracked_red_ground', tile: 13, lum: 0.3, tint: [1.0, 0.8, 0.72] },          // 3 cracked red earth
  { f: 'ph/forest_ground_04', tile: 9, lum: 0.36, tint: [0.95, 1.0, 0.88] },           // 4 forest floor
  { f: 'ph/aerial_grass_rock', tile: 16, lum: 0.36, tint: [0.85, 1.0, 0.78] },         // 5 grass + rock
  { f: 'ph/aerial_sand', tile: 15, lum: 0.66, tint: [1.22, 1.02, 0.78] },              // 6 sand
  { f: 'ph/rock_face', tile: 10, lum: 0.42, tint: [1.15, 0.9, 0.8] },                  // 7 red mountainside rock
  { f: 'ph/rocky_trail', tile: 9, lum: 0.46, tint: [1.0, 0.97, 0.92] },                // 8 badlands gravel
  { f: 'ph/dry_riverbed_rock', tile: 14, lum: 0.42, tint: [0.98, 0.94, 0.9] },         // 9 badlands rock / mesa strata
  { f: 'ph/burned_ground_01', tile: 11, lum: 0.24, tint: [1, 0.95, 0.92] },            // 10 burned ground / slag
  { f: 'tex/rusty_metal_02', tile: 6, lum: 0.5, tint: [1, 1, 1] },                     // 11 rust (cranes)
  { f: 'tex/box_profile_metal_sheet', tile: 5, lum: 0.55, tint: [1, 1, 1], gray: 1 },  // 12 corrugated (containers)
  { f: 'tex/concrete_panels', tile: 8, lum: 0.55, tint: [1, 1, 1] },                   // 13 concrete panels (ruins)
  { f: 'ph/dry_ground_rocks', tile: 12, lum: 0.44, tint: [1.0, 0.95, 0.88] },           // 14 badlands dirt + pebbles
];
const NL = LAYERS.length;
const L = { DIRT: 14, CONC: 0, ASPH: 1, BASALT: 2, CRACK: 3, FOREST: 4, GRASS: 5, SAND: 6, REDROCK: 7, GRAVEL: 8, STRATA: 9, BURN: 10, RUST: 11, CORR: 12, PANEL: 13 };

function loadImage(url) {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('load ' + url)); im.src = url; });
}
async function buildArrays(quality) {
  const S = quality === 'low' ? 256 : 512, wantN = quality === 'high';
  const diff = new Uint8Array(S * S * 4 * NL), nor = wantN ? new Uint8Array(S * S * 4 * NL) : null;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d', { willReadFrequently: true });
  const avg = [];
  const fill = (arr, i, rgba) => { for (let k = 0; k < S * S; k++) arr.set(rgba, (i * S * S + k) * 4); };
  await Promise.all(LAYERS.map(async (ly, i) => {
    const [d, n] = await Promise.all([
      loadImage(`assets/${ly.f}/diff.jpg`).catch(() => null),
      wantN ? loadImage(`assets/${ly.f}/nor_gl.jpg`).catch(() => null) : null,
    ]);
    ly._d = d; ly._n = n;
  }));
  for (let i = 0; i < NL; i++) {
    const ly = LAYERS[i];
    if (ly._d) {
      g.drawImage(ly._d, 0, 0, S, S);
      const px = g.getImageData(0, 0, S, S).data;
      let sum = 0;
      if (ly.gray) for (let k = 0; k < px.length; k += 4) { const l = Math.min(255, (px[k] * 0.3 + px[k + 1] * 0.59 + px[k + 2] * 0.11) * 1.9); px[k] = px[k + 1] = px[k + 2] = l; }
      for (let k = 0; k < px.length; k += 64) sum += px[k] + px[k + 1] + px[k + 2];
      avg[i] = sum / (px.length / 64) / 765;
      diff.set(px, i * S * S * 4);
    } else { console.warn('[terrain] missing layer', ly.f); fill(diff, i, [128, 120, 110, 255]); avg[i] = 0.47; }
    if (nor) {
      if (ly._n) { g.drawImage(ly._n, 0, 0, S, S); nor.set(g.getImageData(0, 0, S, S).data, i * S * S * 4); }
      else fill(nor, i, [128, 128, 255, 255]);
    }
    ly._d = ly._n = null;
  }
  const mk = (data, srgb) => {
    const t = new THREE.DataArrayTexture(data, S, S, NL);
    t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = 4;
    t.needsUpdate = true; return t;
  };
  return { diff: mk(diff, true), nor: nor ? mk(nor, false) : null, avg };
}

// ---------------------------------------------------------------- geometry builder (merged, flat or smooth)
class Builder {
  constructor() { this.p = []; this.n = []; this.c = []; this.l = []; }
  // g: BufferGeometry (indexed or not); m: Matrix4; col: THREE.Color | (x,y,z,ly)=>[r,g,b]; smooth: keep vertex normals
  add(g, m, col, layer, smooth = false) {
    const src = g.index ? g.toNonIndexed() : g;
    const pa = src.attributes.position, na = src.attributes.normal;
    const v = new THREE.Vector3(), nv = new THREE.Vector3(), nm = new THREE.Matrix3().getNormalMatrix(m);
    const base = this.p.length;
    for (let i = 0; i < pa.count; i++) {
      v.fromBufferAttribute(pa, i); const ly = v.y;
      v.applyMatrix4(m); this.p.push(v.x, v.y, v.z);
      if (smooth && na) { nv.fromBufferAttribute(na, i).applyMatrix3(nm).normalize(); this.n.push(nv.x, nv.y, nv.z); }
      const cc = typeof col === 'function' ? col(v.x, v.y, v.z, ly) : [col.r, col.g, col.b];
      this.c.push(cc[0], cc[1], cc[2]); this.l.push(layer);
    }
    if (!smooth || !na) { // flat normals per triangle
      const P = this.p, a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
      for (let i = base; i < P.length; i += 9) {
        a.set(P[i], P[i + 1], P[i + 2]); b.set(P[i + 3], P[i + 4], P[i + 5]); c.set(P[i + 6], P[i + 7], P[i + 8]);
        b.sub(a); c.sub(a); b.cross(c).normalize();
        for (let k = 0; k < 3; k++) this.n.push(b.x, b.y, b.z);
      }
    }
    if (src !== g) src.dispose();
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aLayer', new THREE.Float32BufferAttribute(this.l, 1));
    g.computeBoundingSphere();
    return g;
  }
  get empty() { return this.p.length === 0; }
}
const M4 = (x, y, z, ry = 0, sx = 1, sy = 1, sz = 1, rx = 0, rz = 0) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
const C3 = (r, g, b) => new THREE.Color(r, g, b);

function rockGeo(seed, detail = 1, rough = 0.5) {
  const g = new THREE.IcosahedronGeometry(1, detail), p = g.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = vnoise3(v.x * 1.6 + seed * 7.1, v.y * 1.6, v.z * 1.6, seed) * 0.7 + vnoise3(v.x * 3.4, v.y * 3.4 + seed, v.z * 3.4, seed + 3) * 0.3;
    v.multiplyScalar(1 - rough * 0.5 + rough * n);
    if (v.y < -0.2) v.y = -0.2 - (v.y + 0.2) * 0.2; // flatten the buried bottom
    p.setXYZ(i, v.x, v.y, v.z);
  }
  return g;
}
// stratified column (mesa / cliff / basalt). radial noise, flat top
function columnGeo(seed, seg = 12, hseg = 5, rough = 0.18, topJag = 0) {
  const g = new THREE.CylinderGeometry(1, 1.15, 1, seg, hseg), p = g.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const a = Math.atan2(v.z, v.x), rr = Math.hypot(v.x, v.z);
    if (rr > 1e-4) {
      const n = 1 + (vnoise(Math.cos(a) * 2 + seed, Math.sin(a) * 2 + v.y * 2.5, seed) - 0.5) * 2 * rough;
      v.x *= n; v.z *= n;
    }
    if (v.y > 0.49 && topJag) v.y += (vnoise(v.x * 3 + seed, v.z * 3, seed + 5) - 0.5) * topJag;
    p.setXYZ(i, v.x, v.y + 0.5, v.z);
  }
  return g;
}
function fanGeo(seed, seg, rIn, rOut, rough = 0.25) { // center + inner ring (aEdge 0.6) + outer ring (aEdge 1); y up
  const pos = [], edge = [], idx = [];
  pos.push(0, 0, 0); edge.push(0);
  const rad = (a, k) => 1 + (vnoise(Math.cos(a) * 1.7 + seed, Math.sin(a) * 1.7, seed + k) - 0.5) * 2 * rough;
  for (let i = 0; i < seg; i++) { const a = i / seg * Math.PI * 2, r = rad(a, 0); pos.push(Math.cos(a) * r * rIn, 0, Math.sin(a) * r * rIn); edge.push(0.6); }
  for (let i = 0; i < seg; i++) { const a = i / seg * Math.PI * 2, r = rad(a, 0); pos.push(Math.cos(a) * r * rOut, 0, Math.sin(a) * r * rOut); edge.push(1); }
  for (let i = 0; i < seg; i++) {
    const a = 1 + i, b = 1 + (i + 1) % seg, c = 1 + seg + i, d = 1 + seg + (i + 1) % seg;
    idx.push(0, b, a, a, b, d, a, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 1));
  g.setIndex(idx);
  return g;
}
function mergeSimple(list) { // [{g (indexed or not), m}] → one geometry with position + any float attrs (aEdge, color)
  const out = {}, names = new Set();
  for (const { g } of list) for (const n in g.attributes) names.add(n);
  for (const n of names) out[n] = [];
  const v = new THREE.Vector3();
  for (const { g, m } of list) {
    const s = g.index ? g.toNonIndexed() : g;
    const pa = s.attributes.position;
    for (let i = 0; i < pa.count; i++) {
      for (const n of names) {
        if (n === 'position') { v.fromBufferAttribute(pa, i).applyMatrix4(m); out.position.push(v.x, v.y, v.z); }
        else if (n === 'normal') { /* recomputed */ }
        else { const a = s.attributes[n]; for (let k = 0; k < (a ? a.itemSize : 1); k++) out[n].push(a ? a.array[i * a.itemSize + k] : 0); }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  for (const n of names) if (n !== 'normal' && n !== 'uv') g.setAttribute(n, new THREE.Float32BufferAttribute(out[n], n === 'position' || n === 'color' ? 3 : 1));
  g.computeVertexNormals(); g.computeBoundingSphere();
  return g;
}

// ---------------------------------------------------------------- shader chunks
const NOISE_GLSL = `
float tHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec2 tHash2(vec2 p){ p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
float tNoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(tHash(i), tHash(i + vec2(1, 0)), f.x), mix(tHash(i + vec2(0, 1)), tHash(i + vec2(1, 1)), f.x), f.y); }
float tCrack(vec2 p){ // voronoi border distance
  vec2 n = floor(p), f = fract(p), mg, mr; float md = 8.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) { vec2 g = vec2(i, j), r = g + tHash2(n + g) - f; float d = dot(r, r); if (d < md) { md = d; mr = r; mg = g; } }
  md = 8.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) { vec2 g = mg + vec2(i, j), r = g + tHash2(n + g) - f;
    if (dot(mr - r, mr - r) > 0.00001) md = min(md, dot(0.5 * (mr + r), normalize(r - mr))); }
  return md; }
`;

function groundMaterial(arr, splatTex, maskTex, U, quality) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  mat.userData.envBase = 0.35; mat.envMapIntensity = 0.35;
  const normals = !!arr.nor;
  mat.defines = normals ? { T_NORMALS: '' } : {};
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, {
      tLayers: { value: arr.diff }, tSplat: { value: splatTex }, tMask: { value: maskTex },
      uHalf: { value: new THREE.Vector2(HW, HH) }, uTime: U.uTime,
      uTile: { value: LAYERS.map(l => l.tile) }, uTint: { value: layerTints(arr) },
    });
    if (normals) sh.uniforms.tLayersN = { value: arr.nor };
    sh.vertexShader = 'varying vec3 vGW;\n' + sh.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\n  vGW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = `varying vec3 vGW;
uniform highp sampler2DArray tLayers;
#ifdef T_NORMALS
uniform highp sampler2DArray tLayersN;
#endif
uniform sampler2D tSplat; uniform sampler2D tMask; uniform vec2 uHalf; uniform float uTime;
uniform float uTile[${NL}]; uniform vec3 uTint[${NL}];
${NOISE_GLSL}
` + sh.fragmentShader
      .replace('#include <map_fragment>', `
  vec2 tWp = vGW.xz;
  vec2 tSuv = clamp((tWp + uHalf) / (2.0 * uHalf), 0.0, 1.0);
  vec4 tSp = texture2D(tSplat, tSuv); vec4 tMk = texture2D(tMask, tSuv);
  float tW[5]; tW[0] = tSp.r; tW[1] = tSp.g; tW[2] = tSp.b; tW[3] = tSp.a; tW[4] = max(0.0, 1.0 - tSp.r - tSp.g - tSp.b - tSp.a);
  int tI1 = 0; for (int i = 1; i < 5; i++) if (tW[i] > tW[tI1]) tI1 = i;
  int tI2 = tI1 == 0 ? 1 : 0; for (int i = 0; i < 5; i++) if (i != tI1 && tW[i] > tW[tI2]) tI2 = i;
  int tPL[5] = int[5](0, 2, 4, 6, 8); int tVL[5] = int[5](1, 3, 5, 6, 14);
  int tP1 = tPL[tI1], tV1 = tVL[tI1], tP2 = tPL[tI2];
  float tVw = smoothstep(0.4, 0.6, tMk.r);
  if (tI1 == 1) tVw = smoothstep(0.5, 0.75, tMk.r) * 0.8;
  if (tI1 == 2) { if (tMk.a > tVw) tV1 = 7; tVw = max(tVw, tMk.a); }
  if (tI1 == 3) tVw = 0.3 + 0.25 * tMk.r;
  vec2 tUv1 = tWp / uTile[tP1];
  vec2 tUv2 = tWp / uTile[tP2] + 0.5;
  vec3 tCP = texture(tLayers, vec3(tUv1, float(tP1))).rgb * uTint[tP1];
  vec3 tCV = texture(tLayers, vec3(mat2(0.8, -0.6, 0.6, 0.8) * tWp / (uTile[tV1] * (tV1 == tP1 ? 2.7 : 1.7)) + 0.37, float(tV1))).rgb * uTint[tV1];
  vec3 tCA = mix(tCP, tCV, tVw);
  vec3 tCB = texture(tLayers, vec3(tUv2, float(tP2))).rgb * uTint[tP2];
  float tA = tW[tI1], tB = tW[tI2]; float tS = max(tA + tB, 1e-4); tA /= tS; tB /= tS;
  float tHA = dot(tCA, vec3(0.333)) * 0.6, tHB = dot(tCB, vec3(0.333)) * 0.6;
  float tMa = max(tHA + tA, tHB + tB) - 0.16;
  float tBa = max(tHA + tA - tMa, 0.0), tBb = max(tHB + tB - tMa, 0.0);
  float tTB = tBb / max(tBa + tBb, 1e-4);
  vec3 tCol = mix(tCA, tCB, tTB);
  float tWI = tW[0], tWV = tW[1], tWF = tW[2], tWD = tW[3], tWB = tW[4];
  // macro brightness breakup (hides tiling at aerial zoom)
  tCol *= 0.86 + 0.28 * tNoise(tWp * 0.021 + 7.0) * (0.7 + 0.3 * tNoise(tWp * 0.09));
  // badlands: pull toward neutral grey-brown
  float tBl = dot(tCol, vec3(0.299, 0.587, 0.114));
  tCol = mix(tCol, tBl * vec3(1.06, 0.98, 0.88), tWB * 0.45);
  // industrial: slab joints on concrete, oil stains
  vec2 tG = abs(fract(tWp / 7.5) - 0.5);
  float tJoint = smoothstep(0.472, 0.492, max(tG.x, tG.y));
  tCol *= 1.0 - tJoint * 0.4 * tWI * (1.0 - tVw);
  float tOil = tMk.b;
  tCol = mix(tCol, tCol * vec3(0.2, 0.19, 0.19), tOil * 0.85);
  // dunes: wind ripples (brightness + normal tilt)
  vec2 tRipN = vec2(0.0);
  if (tWD > 0.02) {
    vec2 tDir = vec2(0.93, 0.36);
    float tPh = dot(tWp, tDir) * 1.7 + tNoise(tWp * 0.06) * 7.0 + tNoise(tWp * 0.3) * 0.8;
    float tR = sin(tPh);
    tCol *= 1.0 + 0.07 * tR * tWD;
    tRipN = tDir * cos(tPh) * 0.22 * tWD;
  }
  // volcanic: glowing lava cracks
  vec3 tEmis = vec3(0.0);
  float tLz = tWV * tMk.g;
  if (tLz > 0.02) {
    float tE = tCrack(tWp * 0.23 + vec2(tNoise(tWp * 0.05), tNoise(tWp * 0.05 + 3.0)) * 1.6);
    float tC = 1.0 - smoothstep(0.01, 0.045, tE);
    float tHalo = 1.0 - smoothstep(0.02, 0.12, tE);
    tCol = mix(tCol, tCol * 0.3, tHalo * tLz);
    float tPulse = 0.7 + 0.3 * sin(uTime * 1.6 + tWp.x * 0.07 + tWp.y * 0.05);
    tEmis = vec3(1.0, 0.28, 0.03) * (tC * 2.2 + tHalo * 0.18) * tLz * tPulse;
  }
  float tRough = tWI * 0.8 + tWV * 0.86 + tWF * 0.95 + tWD * 0.97 + tWB * 0.98;
  tRough = mix(tRough, 0.28, tOil);
  // out of bounds: darken + desaturate, thin dark border line
  vec2 tQ = max(abs(tWp) - uHalf, 0.0); float tD = length(tQ);
  float tK = smoothstep(0.0, 6.0, tD) * 0.6 + smoothstep(6.0, 80.0, tD) * 0.4;
  float tLum = dot(tCol, vec3(0.299, 0.587, 0.114));
  tCol = mix(tCol, vec3(tLum) * vec3(0.95, 0.9, 0.86), tK * 0.7) * (1.0 - tK * 0.5);
  float tEdge = max(abs(tWp.x) - uHalf.x, abs(tWp.y) - uHalf.y);
  tCol *= 1.0 - 0.4 * (1.0 - smoothstep(0.0, 0.7, abs(tEdge)));
  diffuseColor.rgb *= tCol;`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * tRough;')
      .replace('#include <normal_fragment_maps>', `
  vec3 tNw = vec3(0.0, 1.0, 0.0);
#ifdef T_NORMALS
  vec3 tNA = texture(tLayersN, vec3(tUv1, float(tP1))).xyz * 2.0 - 1.0;
  vec3 tNB = texture(tLayersN, vec3(tUv2, float(tP2))).xyz * 2.0 - 1.0;
  vec3 tNt = normalize(mix(tNA, tNB, tTB));
  tNw = normalize(vec3(tNt.x, tNt.z, -tNt.y));
#endif
  tNw.xz -= tRipN; tNw = normalize(tNw);
  normal = normalize((viewMatrix * vec4(tNw, 0.0)).xyz);`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += tEmis;');
  };
  mat.customProgramCacheKey = () => 'vanguard-ground' + (normals ? 'N' : '');
  return mat;
}

// per-layer linear multiplier: normalise each texture to its target sRGB brightness, then apply the hue tint
const layerTints = (arr) => LAYERS.map((l, i) => new THREE.Vector3(...l.tint).multiplyScalar(Math.pow(l.lum / Math.max(0.05, arr.avg[i]), 2.2)));
// props: triplanar from the same layer array, per-vertex layer + colour, flat shaded, fog-of-war darkened
function propsMaterial(arr, U, smooth = false) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.92, metalness: 0, flatShading: !smooth });
  mat.userData.envBase = 0.5; mat.envMapIntensity = 0.5;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, {
      tLayers: { value: arr.diff },
      uTile: { value: LAYERS.map(l => l.tile) }, uTint: { value: layerTints(arr) },
    });
    sh.vertexShader = 'attribute float aLayer;\nvarying float vLayer;\nvarying vec3 vWN;\n' + sh.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\n  vLayer = aLayer; vWN = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = `uniform highp sampler2DArray tLayers; uniform float uTile[${NL}]; uniform vec3 uTint[${NL}];
varying float vLayer; varying vec3 vWN;
` + sh.fragmentShader.replace('#include <map_fragment>', `
  int tL = int(vLayer + 0.5);
  vec3 tBw = pow(abs(normalize(vWN)), vec3(4.0)); tBw /= dot(tBw, vec3(1.0));
  float tTs = 1.0 / uTile[tL];
  vec3 tTex = texture(tLayers, vec3(vGW.zy * tTs, vLayer)).rgb * tBw.x
            + texture(tLayers, vec3(vGW.xz * tTs, vLayer)).rgb * tBw.y
            + texture(tLayers, vec3(vGW.xy * tTs, vLayer)).rgb * tBw.z;
  diffuseColor.rgb *= tTex * uTint[tL] * 1.25;`);
    fogPatch(sh, U);
  };
  mat.customProgramCacheKey = () => 'vanguard-props' + (smooth ? 'S' : 'F');
  return mat;
}
// any standard material: just fog-of-war darkening (trees, rails, puddles)
function fogged(mat, U, key) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => { prev?.call(mat, sh, r); fogPatch(sh, U); };
  mat.customProgramCacheKey = () => 'vanguard-fog-' + key;
  return mat;
}

// ---------------------------------------------------------------- main
export async function createTerrain(world) {
  world.map = { w: MAP.w, h: MAP.h };
  world.biomeAt = biomeAt;
  world.obstacles = world.obstacles || [];
  world.obstacles.length = 0;
  if (world.camTarget) { world.camTarget.x = BASES[0].x + 22; world.camTarget.z = BASES[0].z - 6; }
  const scene = world.scene, quality = world.quality || 'med';
  const U = { uTime: { value: 0 }, tFog: { value: null }, uFogXf: { value: new THREE.Vector4(1 / MAP.w, 1 / MAP.h, HW, HH) }, uFogOn: { value: 0 } };
  { const t = new THREE.DataTexture(new Uint8Array([255, 255, 0, 255]), 1, 1); t.needsUpdate = true; U.tFog.value = t; }

  const arrP = buildArrays(quality);
  const R = rng(20261108);
  const obstacles = world.obstacles, feats = []; // feats: minimap draw list {x,z,r,type}

  // ---------- placement rules ----------
  const lanes = [];
  for (const b of BASES) {
    const f = { x: b.x * 0.875, z: b.z * 0.82 };
    lanes.push([b.x, b.z, 0, 0], [b.x, b.z, Math.sign(b.x) * 110, 0], [b.x, b.z, f.x, f.z]);
  }
  lanes.push([-110, 0, 110, 0]);
  function blockedBy(x, z, r, gap = 7) {
    if (Math.abs(x) > HW - r - 2 || Math.abs(z) > HH - r - 2) return true;
    for (const b of BASES) {
      if (Math.hypot(x - b.x, z - b.z) < 56 + r) return true;
      const fx = b.x - Math.sign(b.x) * 22, fz = b.z - Math.sign(b.z) * 12; // base crystal field ~25u toward center
      if (Math.hypot(x - fx, z - fz) < 32 + r) return true;
    }
    for (const c of CENTER_FIELDS) if (Math.hypot(x - c.x, z - c.z) < 26 + r) return true;
    for (const l of lanes) if (segDist(x, z, ...l) < 12 + r) return true;
    for (const o of obstacles) if (Math.hypot(x - o.x, z - o.z) < o.r + r + gap) return true;
    return false;
  }
  const dominant = (x, z) => { const w = biomeRaw(x, z); let i = 0; for (let k = 1; k < 5; k++) if (w[k] > w[i]) i = k; return [i, w[i]]; };
  function place(biome, r, minW = 0.62, tries = 400, gap = 7) {
    for (let k = 0; k < tries; k++) {
      const x = (R() - 0.5) * (MAP.w - 2 * r - 6), z = (R() - 0.5) * (MAP.h - 2 * r - 6);
      const [i, w] = dominant(x, z);
      if (i !== biome || w < minW) continue;
      if (blockedBy(x, z, r, gap)) continue;
      return { x, z };
    }
    return null;
  }
  const obs = (x, z, r, kind) => { obstacles.push({ x, z, r, kind }); };

  const B = { 0: new Builder(), 1: new Builder(), 2: new Builder(), 3: new Builder(), 4: new Builder() };
  const dunesB = new Builder();
  const lavaList = [], puddleList = [], railB = new Builder();
  const trees = [], cones = [], bushes = []; // {x,z,s,h,c,ry}

  // ---------- NW: forest + red mountainside ----------
  const red = (k = 1) => (x, y, z, ly) => { const b = 0.5 + 0.5 * Math.sin(y * 1.3 + vnoise(x * 0.2, z * 0.2) * 3); return [(0.78 + 0.1 * b) * k, (0.5 + 0.07 * b) * k, (0.4 + 0.05 * b) * k]; };
  function cliff(bld, x, z, r, h, seed, col, layer = L.REDROCK) {
    bld.add(columnGeo(seed, 10, 5, 0.28, 0.25), M4(x, -0.3, z, R() * 6, r, h, r * (0.75 + R() * 0.4)), col, layer);
    for (let k = 0; k < 3; k++) { // talus
      const a = R() * 6.28, d = r * (0.95 + R() * 0.25), s = r * (0.18 + R() * 0.16);
      bld.add(rockGeo(seed + k + 1, 0), M4(x + Math.cos(a) * d, 0, z + Math.sin(a) * d, R() * 6, s, s * 0.7, s), col, layer);
    }
  }
  // in-map ridge along north + west edges (only where the base clearing allows)
  for (let x = -250; x < -30; x += 11 + R() * 5) {
    const z = -HH + 6 + R() * 6, r = 7 + R() * 5;
    if (blockedBy(x, z, r * 0.8, 0)) continue;
    cliff(B[2], x, z, r, 10 + R() * 12, (x | 0) + 500, red()); obs(x, z, r * 1.05, 'cliff'); feats.push({ x, z, r, t: 'cliff' });
  }
  for (let z = -150; z < -15; z += 11 + R() * 5) {
    const x = -HW + 6 + R() * 6, r = 7 + R() * 5;
    if (blockedBy(x, z, r * 0.8, 0)) continue;
    cliff(B[2], x, z, r, 9 + R() * 12, (z | 0) + 900, red()); obs(x, z, r * 1.05, 'cliff'); feats.push({ x, z, r, t: 'cliff' });
  }
  // out-of-bounds mountain wall (visual only)
  for (let x = -330; x < -10; x += 14 + R() * 8) {
    const z = -HH - 18 - R() * 22, r = 14 + R() * 12;
    cliff(B[2], x, z, r, 22 + R() * 28 * smoothstep(0, -200, x), (x | 0) + 1300, red(0.92));
  }
  for (let z = -200; z < -10; z += 14 + R() * 8) {
    const x = -HW - 18 - R() * 22, r = 14 + R() * 12;
    cliff(B[2], x, z, r, 20 + R() * 26 * smoothstep(0, -160, z), (z | 0) + 1700, red(0.92));
  }
  // red rock outcrops inside the forest
  for (let i = 0; i < 6; i++) {
    const r = 5 + R() * 5, p = place(2, r, 0.6); if (!p) continue;
    cliff(B[2], p.x, p.z, r, 6 + R() * 9, i + 77, red()); obs(p.x, p.z, r * 1.05, 'cliff'); feats.push({ x: p.x, z: p.z, r, t: 'cliff' });
  }
  // groves
  const greens = [[0.018, 0.06, 0.014], [0.03, 0.08, 0.014], [0.055, 0.1, 0.016], [0.1, 0.11, 0.018], [0.015, 0.05, 0.02]];
  for (let i = 0; i < 18; i++) {
    const r = 7 + R() * 7, p = place(2, r, 0.55, 400, 8); if (!p) continue;
    obs(p.x, p.z, r * 0.9, 'grove'); feats.push({ x: p.x, z: p.z, r, t: 'grove' });
    const n = Math.round(r * r / 5.5);
    for (let k = 0; k < n; k++) {
      const a = R() * 6.28, d = Math.sqrt(R()) * r * 0.95, x = p.x + Math.cos(a) * d, z = p.z + Math.sin(a) * d;
      const h = 6 + R() * 7, g = greens[(R() * greens.length) | 0], j = 0.85 + R() * 0.3;
      if (R() < 0.68) cones.push({ x, z, s: h * 0.3, h, c: g.map(v => v * j), ry: R() * 6 });
      else bushes.push({ x, z, s: 2.2 + R() * 1.6, h: 2.2 + R() * 1.4, y: h * 0.55, c: g.map((v, q) => v * j * (q === 0 ? 1.25 : 1.05)), ry: R() * 6 });
      trees.push({ x, z, s: 0.32 + R() * 0.15, h: h * 0.6 });
    }
  }
  // OOB treeline on the NW strip in front of the mountains
  for (let i = 0; i < 70; i++) {
    const x = -HW - 8 + R() * 230, z = -HH - 6 - R() * 10;
    if (x > -20) continue;
    const h = 7 + R() * 8, g = greens[(R() * greens.length) | 0];
    cones.push({ x, z, s: h * 0.3, h, c: g, ry: R() * 6 }); trees.push({ x, z, s: 0.4, h: h * 0.6 });
  }
  // ferns/undergrowth (no collision)
  for (let i = 0; i < 160; i++) {
    const x = (R() - 0.5) * MAP.w, z = (R() - 0.5) * MAP.h, [b, w] = dominant(x, z);
    if (b !== 2 || w < 0.5 || blockedBy(x, z, 0.5, -1)) continue;
    const g = greens[(R() * greens.length) | 0];
    bushes.push({ x, z, s: 0.8 + R() * 0.8, h: 0.6 + R() * 0.5, y: 0.2, c: g.map(v => v * 1.15), ry: R() * 6 });
  }

  // ---------- NE: volcanic ----------
  const basaltC = (x, y, z) => { const n = vnoise(x * 0.3, z * 0.3 + y * 0.2); return [0.5 + 0.12 * n, 0.46 + 0.08 * n, 0.44 + 0.06 * n]; };
  for (let i = 0; i < 10; i++) {
    const r = 6 + R() * 6, p = place(1, r + 3, 0.6, 400, 8); if (!p) continue;
    const seed = 300 + i;
    lavaList.push({ g: fanGeo(seed, 28, r, r + 1.6, 0.28), m: M4(p.x, 0.07, p.z, R() * 6) });
    obs(p.x, p.z, r + 1.8, 'lava'); feats.push({ x: p.x, z: p.z, r: r + 1, t: 'lava' });
    const nr = 5 + (R() * 4) | 0;
    for (let k = 0; k < nr; k++) { // rim rocks
      const a = R() * 6.28, d = r * 1.18 + 1.2, s = 0.9 + R() * 1.6;
      B[1].add(rockGeo(seed + k, 0, 0.6), M4(p.x + Math.cos(a) * d, 0, p.z + Math.sin(a) * d, R() * 6, s * 1.3, s * 0.8, s), basaltC, L.BASALT);
    }
  }
  for (let i = 0; i < 9; i++) { // basalt column clusters
    const r = 4 + R() * 3, p = place(1, r, 0.6); if (!p) continue;
    obs(p.x, p.z, r + 0.5, 'basalt'); feats.push({ x: p.x, z: p.z, r, t: 'rock' });
    const n = 8 + (R() * 8) | 0;
    for (let k = 0; k < n; k++) {
      const a = R() * 6.28, d = Math.sqrt(R()) * r * 0.85, cr = 0.8 + R() * 0.6, h = 2 + R() * 8 * (1 - d / r * 0.6);
      B[1].add(new THREE.CylinderGeometry(cr, cr * 1.05, h, 6, 1), M4(p.x + Math.cos(a) * d, h / 2 - 0.1, p.z + Math.sin(a) * d, R(), 1, 1, 1, (R() - 0.5) * 0.12, (R() - 0.5) * 0.12), basaltC, L.BASALT);
    }
  }
  for (let i = 0; i < 7; i++) { // jagged spires
    const r = 3 + R() * 2.5, p = place(1, r, 0.6); if (!p) continue;
    obs(p.x, p.z, r, 'rock'); feats.push({ x: p.x, z: p.z, r, t: 'rock' });
    B[1].add(rockGeo(600 + i, 1, 0.7), M4(p.x, 0, p.z, R() * 6, r, r * (2 + R() * 1.5), r), basaltC, L.BASALT);
  }
  // OOB volcanoes with glowing craters
  function volcano(x, z, r, h, seed) {
    const pts = [];
    for (let k = 0; k <= 10; k++) { const t = k / 10; pts.push(new THREE.Vector2(r * (1 - t) ** 1.6 * (1 - 0.18) + r * 0.18, h * t)); }
    pts.push(new THREE.Vector2(r * 0.12, h * 0.94), new THREE.Vector2(r * 0.05, h * 0.86));
    const g = new THREE.LatheGeometry(pts, 26), p = g.attributes.position, v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i); const a = Math.atan2(v.z, v.x);
      const n = 1 + (vnoise(Math.cos(a) * 3 + seed, v.y * 0.15, seed) - 0.5) * 0.3;
      p.setXYZ(i, v.x * n, v.y, v.z * n);
    }
    B[1].add(g, M4(x, -1, z), (X, Y, Z) => { const t = Y / h, s = vnoise(Math.atan2(Z - z, X - x) * 4, Y * 0.1, seed); return [0.42 + 0.35 * t * s, 0.36 + 0.06 * t, 0.34]; }, L.BASALT);
    lavaList.push({ g: fanGeo(seed, 20, r * 0.1, r * 0.13, 0.15), m: M4(x, h * 0.87 - 1, z) });
  }
  volcano(222, -238, 80, 58, 41); volcano(95, -212, 46, 32, 43); volcano(300, -110, 50, 36, 45);
  for (let x = 40; x < 330; x += 16 + R() * 10) { const z = -HH - 14 - R() * 16, r = 10 + R() * 9; B[1].add(rockGeo((x | 0) + 7, 1, 0.6), M4(x, 0, z, R() * 6, r * 1.4, r * (0.7 + R() * 0.7), r), basaltC, L.BASALT); }
  for (let z = -200; z < 20; z += 16 + R() * 10) { const x = HW + 14 + R() * 16, r = 10 + R() * 9; B[1].add(rockGeo((z | 0) + 99, 1, 0.6), M4(x, 0, z, R() * 6, r, r * (0.6 + R() * 0.7), r * 1.4), basaltC, L.BASALT); }

  // ---------- SE: dunes ----------
  const sandC = (x, y, z, ly) => { const t = Math.min(1, y / 6), n = vnoise(x * 0.08, z * 0.08); return [0.95 + 0.1 * t + 0.05 * n, 0.86 + 0.08 * t + 0.04 * n, 0.72 + 0.06 * t]; };
  function dune(x, z, Lh, Wd, H, ry, seed, collide) {
    const g = new THREE.PlaneGeometry(Lh * 2, Wd * 3.2, 30, 14); g.rotateX(-Math.PI / 2);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const a = p.getX(i), bz = p.getZ(i) + Wd * 0.4; // a along crest, bz across (wind +z local)
      const u = a / Lh, f = Math.max(0, 1 - u * u) ** 0.7;
      const s = bz - 0.45 * Wd * u * u;
      const prof = s < 0 ? Math.exp(-((s / (0.62 * Wd)) ** 2)) : Math.exp(-((s / (0.26 * Wd)) ** 2));
      let y = H * f * prof * (0.85 + 0.3 * vnoise(a * 0.1 + seed, bz * 0.1, seed));
      if (y < 0.08) y = -0.25;
      p.setY(i, y);
    }
    g.computeVertexNormals();
    dunesB.add(g, M4(x, 0, z, ry), sandC, L.SAND, true);
    if (collide) for (let u = -0.75; u <= 0.76; u += 0.25) {
      const f = Math.max(0, 1 - u * u) ** 0.7, a = u * Lh, b = 0.45 * Wd * u * u - Wd * 0.4 + 0.5;
      const cx = x + Math.cos(-ry) * a - Math.sin(-ry) * b, cz = z + Math.sin(-ry) * a + Math.cos(-ry) * b;
      const r = Math.max(2.5, Wd * 0.48 * f);
      if (f > 0.3) obs(cx, cz, r, 'dune');
    }
  }
  for (let i = 0; i < 12; i++) {
    const Lh = 14 + R() * 12, Wd = 9 + R() * 5, p = place(3, Lh * 0.9, 0.6, 500, 6); if (!p) continue;
    const ry = Math.PI / 2 + (R() - 0.5) * 0.6; // crests roughly north-south, wind from the west
    dune(p.x, p.z, Lh, Wd, 3.5 + R() * 3.5, ry, 800 + i, true); feats.push({ x: p.x, z: p.z, r: Lh * 0.8, t: 'dune', ry, w: Wd });
  }
  for (let i = 0; i < 30; i++) { // OOB dune sea (south + east edges)
    const side = R() < 0.55, x = side ? 20 + R() * 330 : HW + 15 + R() * 70, z = side ? HH + 15 + R() * 70 : -10 + R() * 220;
    dune(x, z, 22 + R() * 22, 12 + R() * 8, 6 + R() * 9, Math.PI / 2 + (R() - 0.5) * 0.5, 900 + i, false);
  }
  for (let i = 0; i < 5; i++) { // sandstone rocks
    const r = 3 + R() * 3, p = place(3, r, 0.6); if (!p) continue;
    obs(p.x, p.z, r, 'rock'); feats.push({ x: p.x, z: p.z, r, t: 'rock' });
    B[3].add(rockGeo(700 + i, 1, 0.55), M4(p.x, 0, p.z, R() * 6, r * 1.3, r * (0.9 + R()), r), () => [1.15, 0.92, 0.7], L.REDROCK);
  }
  for (let i = 0; i < 60; i++) { // dry grass tufts
    const x = (R() - 0.5) * MAP.w, z = (R() - 0.5) * MAP.h, [b, w] = dominant(x, z);
    if (b !== 3 || w < 0.4 || blockedBy(x, z, 0.5, 0)) continue;
    bushes.push({ x, z, s: 0.6 + R() * 0.6, h: 0.5 + R() * 0.4, y: 0.15, c: [0.2, 0.16, 0.07], ry: R() * 6 });
  }

  // ---------- SW: industrial ----------
  const concC = (k = 1) => (x, y, z) => { const n = vnoise(x * 0.2, y * 0.25 + z * 0.2); const s = y > 0.5 && y < 4 ? 0.85 : 1; return [(0.92 + 0.1 * n) * k * s, (0.9 + 0.08 * n) * k * s, (0.86 + 0.06 * n) * k * s]; };
  function coolingTower(x, z, r, h) {
    const pts = [];
    for (let k = 0; k <= 12; k++) { const t = k / 12; pts.push(new THREE.Vector2(r * (0.62 + 0.38 * ((t - 0.72) / 0.72) ** 2), t * h)); }
    B[0].add(new THREE.LatheGeometry(pts, 22), M4(x, 0, z), (X, Y, Z) => { const t = Y / h, st = 0.75 + 0.25 * vnoise(Math.atan2(Z - z, X - x) * 5, Y * 0.3); return [0.88 * st - 0.2 * t * t, 0.86 * st - 0.2 * t * t, 0.83 * st - 0.2 * t * t]; }, L.CONC);
    const inner = pts.map(p => new THREE.Vector2(p.x - 0.5, p.y)).reverse();
    B[0].add(new THREE.LatheGeometry(inner, 22), M4(x, 0, z), C3(0.25, 0.24, 0.23), L.CONC);
    B[0].add(new THREE.CircleGeometry(r * 0.7, 18).rotateX(-Math.PI / 2), M4(x, h * 0.55, z), C3(0.12, 0.11, 0.11), L.CONC);
  }
  function stack(x, z, h) {
    B[0].add(new THREE.CylinderGeometry(1.5, 2.3, h, 12, 8), M4(x, h / 2, z), (X, Y) => (Y > h - 12 && Math.floor((Y - (h - 12)) / 3) % 2 === 0 ? [0.85, 0.2, 0.15] : [0.9, 0.88, 0.85]), L.CONC);
  }
  const CONT = [[0.62, 0.2, 0.13], [0.16, 0.27, 0.48], [0.2, 0.42, 0.26], [0.85, 0.45, 0.12], [0.55, 0.55, 0.55], [0.12, 0.45, 0.5], [0.72, 0.62, 0.2]];
  function containerYard(x, z, ry, cols, rows) {
    const cw = 6.2, cd = 2.6, ch = 2.6, c = Math.cos(ry), s = Math.sin(ry);
    for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
      const n = (R() * 3.4) | 0; if (!n) continue;
      const lx = (i - (cols - 1) / 2) * (cw + 0.5), lz = (j - (rows - 1) / 2) * (cd + 0.35);
      for (let k = 0; k < n; k++) {
        const col = CONT[(R() * CONT.length) | 0];
        B[0].add(new THREE.BoxGeometry(cw, ch, cd), M4(x + c * lx - s * lz, ch / 2 + k * ch, z + s * lx + c * lz, -ry + (R() - 0.5) * 0.04), C3(...col), L.CORR);
      }
    }
    const len = cols * (cw + 0.5) / 2, wd = rows * (cd + 0.35) / 2, rr = Math.max(wd + 0.6, 3.2);
    for (let a = -len + rr * 0.8; a <= len - rr * 0.8 + 0.1; a += rr * 1.2) obs(x + c * a, z + s * a, rr, 'container');
    return { len, wd };
  }
  function crane(x, z, ry, span, h) {
    const c = Math.cos(ry), s = Math.sin(ry), yel = C3(0.95, 0.72, 0.18);
    for (const side of [-1, 1]) for (const e of [-1, 1]) {
      const lx = e * 5, lz = side * span;
      const px = x + c * lx - s * lz, pz = z + s * lx + c * lz;
      B[0].add(new THREE.BoxGeometry(0.9, h, 0.9), M4(px, h / 2, pz, -ry), yel, L.RUST);
      obs(px, pz, 1.2, 'crane');
    }
    B[0].add(new THREE.BoxGeometry(1.4, 1.6, span * 2 + 3), M4(x + c * 5, h, z + s * 5, -ry), yel, L.RUST);
    B[0].add(new THREE.BoxGeometry(1.4, 1.6, span * 2 + 3), M4(x - c * 5, h, z - s * 5, -ry), yel, L.RUST);
    B[0].add(new THREE.BoxGeometry(11, 1.2, 1.4), M4(x, h + 1.2, z, -ry), yel, L.RUST);
    B[0].add(new THREE.BoxGeometry(3, 2.2, 3), M4(x, h - 1.2, z, -ry), C3(0.4, 0.4, 0.42), L.RUST);
  }
  function ruin(x, z, ry) {
    const c = Math.cos(ry), s = Math.sin(ry), W = 14 + R() * 6, D = 9 + R() * 4;
    const walls = [[-W / 2, -D / 2, W / 2, -D / 2], [-W / 2, -D / 2, -W / 2, D / 2], [W / 2, -D / 2, W / 2, D / 2 * (R() < 0.5 ? 1 : 0.2)]];
    for (const [ax, az, bx, bz] of walls) {
      const len = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(len / 2.4)), wa = Math.atan2(bz - az, bx - ax);
      for (let k = 0; k < n; k++) {
        if (R() < 0.15) continue;
        const t = (k + 0.5) / n, lx = ax + (bx - ax) * t, lz = az + (bz - az) * t, h = 2 + R() * 7 * (0.4 + 0.6 * Math.sin(t * Math.PI));
        B[0].add(new THREE.BoxGeometry(len / n + 0.05, h, 0.8), M4(x + c * lx - s * lz, h / 2, z + s * lx + c * lz, -(ry + wa)), concC(0.95), L.PANEL);
      }
    }
    for (let k = 0; k < 8; k++) { const a = R() * 6.28, d = R() * W * 0.45, sc = 0.6 + R() * 1.1;
      B[0].add(new THREE.BoxGeometry(1, 1, 1), M4(x + Math.cos(a) * d, sc * 0.3, z + Math.sin(a) * d * 0.7, R() * 6, sc * 1.6, sc * 0.8, sc, R(), R()), concC(0.8), L.PANEL); }
    const rr = Math.max(D / 2 + 0.8, 5);
    obs(x - c * (W / 4), z - s * (W / 4), rr, 'ruin'); obs(x + c * (W / 4), z + s * (W / 4), rr, 'ruin');
    return W;
  }
  for (let i = 0; i < 3; i++) { const p = place(0, 10, 0.6, 600, 9); if (!p) continue; coolingTower(p.x, p.z, 9.5, 24 + R() * 6); obs(p.x, p.z, 9.8, 'tower'); feats.push({ x: p.x, z: p.z, r: 9.5, t: 'tower' }); }
  for (let i = 0; i < 6; i++) {
    const cols = 3 + (R() * 2) | 0, rows = 2 + (R() * 2) | 0, p = place(0, cols * 3.4, 0.6, 500, 8); if (!p) continue;
    const ry = R() < 0.5 ? 0 : Math.PI / 2 + (R() - 0.5) * 0.3;
    const { len, wd } = containerYard(p.x, p.z, ry, cols, rows); feats.push({ x: p.x, z: p.z, r: len, t: 'yard', ry, w: wd });
    if (i < 2) crane(p.x, p.z, ry, wd + 2.5, 13 + R() * 3);
  }
  for (let i = 0; i < 4; i++) { const p = place(0, 10, 0.6, 500, 8); if (!p) continue; const W = ruin(p.x, p.z, R() * 3); feats.push({ x: p.x, z: p.z, r: W / 2, t: 'ruin' }); }
  for (let i = 0; i < 5; i++) {
    const r = 5 + R() * 4, p = place(0, r, 0.6); if (!p) continue;
    B[0].add(rockGeo(1000 + i, 1, 0.35), M4(p.x, -0.5, p.z, R() * 6, r, r * (0.55 + R() * 0.25), r * (0.8 + R() * 0.3)), (x, y, z) => { const n = vnoise(x * 0.4, z * 0.4 + y); return [0.38 + 0.1 * n, 0.33 + 0.07 * n, 0.3]; }, L.BURN);
    obs(p.x, p.z, r * 0.95, 'slag'); feats.push({ x: p.x, z: p.z, r, t: 'slag' });
  }
  for (let i = 0; i < 2; i++) { const p = place(0, 3, 0.6); if (!p) continue; stack(p.x, p.z, 30 + R() * 8); obs(p.x, p.z, 2.8, 'stack'); feats.push({ x: p.x, z: p.z, r: 2.5, t: 'tower' }); }
  // OOB skyline south + west of the industrial quadrant
  for (let k = 0; k < 26; k++) {
    const side = R() < 0.55, x = side ? -330 + R() * 300 : -HW - 20 - R() * 60, z = side ? HH + 20 + R() * 60 : 10 + R() * 190;
    const w = 14 + R() * 20, d = 10 + R() * 16, h = 10 + R() * 24;
    B[0].add(new THREE.BoxGeometry(w, h, d), M4(x, h / 2, z, (R() - 0.5) * 0.3), concC(0.9), R() < 0.5 ? L.PANEL : L.CORR);
    if (R() < 0.3) stack(x + w * 0.3, z, h + 14 + R() * 12);
  }
  coolingTower(-300, 205, 16, 40); coolingTower(-285, 245, 14, 34);
  // rail lines (flat decals: ballast + ties + rails; no collision)
  function rail(pts) {
    const curve = new THREE.CatmullRomCurve3(pts.map(([x, z]) => new THREE.Vector3(x, 0, z)));
    const len = curve.getLength(), n = Math.floor(len / 1.3);
    const ballast = C3(0.07, 0.065, 0.06), tie = C3(0.06, 0.035, 0.022), steel = C3(0.3, 0.29, 0.28);
    for (let i = 0; i < n; i++) {
      const t = i / n, p = curve.getPointAt(t), d = curve.getTangentAt(t), a = Math.atan2(d.z, d.x);
      railB.add(new THREE.BoxGeometry(1.35, 0.04, 4.2), M4(p.x, 0.02, p.z, -a), ballast, 0);
      railB.add(new THREE.BoxGeometry(0.32, 0.12, 2.6), M4(p.x, 0.08, p.z, -a), tie, 0);
      for (const o of [-0.72, 0.72]) railB.add(new THREE.BoxGeometry(1.36, 0.12, 0.12), M4(p.x - Math.sin(a) * o, 0.18, p.z + Math.cos(a) * o, -a), steel, 0);
    }
  }
  rail([[-275, 150], [-200, 152], [-130, 147], [-70, 132], [-20, 120], [20, 128], [60, 170]]);
  rail([[-275, 30], [-215, 46], [-160, 54], [-125, 80], [-110, 120], [-100, 175]]);
  for (let i = 0; i < 34; i++) { // puddles
    const r = 1.2 + R() * 3.6, x = (R() - 0.5) * MAP.w, z = (R() - 0.5) * MAP.h, [b, w] = dominant(x, z);
    if (b !== 0 || w < 0.55) continue;
    if (obstacles.some(o => Math.hypot(x - o.x, z - o.z) < o.r + r)) continue;
    puddleList.push({ g: fanGeo(1200 + i, 16, r * 0.8, r, 0.35), m: M4(x, 0.045, z, R() * 6, 1, 1, 0.6 + R() * 0.6), x, z, r });
  }

  // ---------- center: badlands ----------
  const strata = (x, y, z) => { const b = Math.sin(y * 1.9 + vnoise(x * 0.1, z * 0.1) * 2), n = vnoise(x * 0.2, z * 0.2 + y * 0.3); return [0.9 + 0.12 * b + 0.05 * n, 0.8 + 0.09 * b, 0.7 + 0.06 * b]; };
  for (let i = 0; i < 8; i++) {
    const r = 9 + R() * 7, p = place(4, r, 0.55, 600, 9); if (!p) continue;
    const h = 7 + R() * 7;
    B[4].add(columnGeo(1500 + i, 14, 6, 0.22, 0.15), M4(p.x, -0.3, p.z, R() * 6, r, h, r * (0.75 + R() * 0.35)), strata, L.STRATA);
    for (let k = 0; k < 5; k++) { const a = R() * 6.28, d = r * (1 + R() * 0.15), s = 1 + R() * 2.2;
      B[4].add(rockGeo(1600 + i * 7 + k, 0), M4(p.x + Math.cos(a) * d, 0, p.z + Math.sin(a) * d * 0.9, R() * 6, s, s * 0.7, s), strata, L.STRATA); }
    obs(p.x, p.z, r * 1.08, 'mesa'); feats.push({ x: p.x, z: p.z, r, t: 'mesa' });
  }
  for (const [x, z, r, h] of [[-20, -205, 26, 22], [40, -200, 20, 18], [-15, 210, 24, 20], [55, 200, 18, 16]]) // OOB mesas N/S of the middle
    B[4].add(columnGeo((x + z) | 0, 14, 6, 0.22, 0.15), M4(x, -0.3, z, R() * 6, r, h, r * 0.8), strata, L.STRATA);
  // boulders everywhere (tinted per biome)
  const boulderTint = [[0.5, 0.45, 0.42, L.BURN], [0.55, 0.5, 0.48, L.BASALT], [0.8, 0.8, 0.78, L.STRATA], [1.0, 0.85, 0.7, L.REDROCK], [0.8, 0.74, 0.68, L.STRATA]];
  for (let i = 0; i < 70; i++) {
    const r = 1.4 + R() * 2.4, x = (R() - 0.5) * (MAP.w - 20), z = (R() - 0.5) * (MAP.h - 20);
    if (blockedBy(x, z, r, 5)) continue;
    const [b] = dominant(x, z), t = boulderTint[b];
    B[b].add(rockGeo(2000 + i, 1, 0.55), M4(x, 0, z, R() * 6, r * (1 + R() * 0.4), r * (0.6 + R() * 0.5), r), C3(t[0], t[1], t[2]), t[3]);
    obs(x, z, r * 0.95, 'boulder'); feats.push({ x, z, r, t: 'rock' });
  }
  for (let i = 0; i < 140; i++) { // scrub
    const x = (R() - 0.5) * MAP.w, z = (R() - 0.5) * MAP.h, [b, w] = dominant(x, z);
    if (b !== 4 || blockedBy(x, z, 0.5, 0)) continue;
    bushes.push({ x, z, s: 0.7 + R() * 0.9, h: 0.6 + R() * 0.6, y: 0.25, c: [0.1 + R() * 0.04, 0.11, 0.05], ry: R() * 6 });
  }

  // ---------- splat + mask textures ----------
  const SW = 256, SH = 160, splat = new Uint8Array(SW * SH * 4);
  for (let j = 0; j < SH; j++) for (let i = 0; i < SW; i++) {
    const x = (i + 0.5) / SW * MAP.w - HW, z = (j + 0.5) / SH * MAP.h - HH, w = biomeRaw(x, z), k = (j * SW + i) * 4;
    splat[k] = Math.round(w[0] * 255); splat[k + 1] = Math.round(w[1] * 255); splat[k + 2] = Math.round(w[2] * 255); splat[k + 3] = Math.round(w[3] * 255);
  }
  const MW_ = 512, MH_ = 320, mask = new Uint8Array(MW_ * MH_ * 4);
  const lavaPts = obstacles.filter(o => o.kind === 'lava'), redPts = obstacles.filter(o => o.kind === 'cliff');
  for (let j = 0; j < MH_; j++) for (let i = 0; i < MW_; i++) {
    const x = (i + 0.5) / MW_ * MAP.w - HW, z = (j + 0.5) / MH_ * MAP.h - HH, k = (j * MW_ + i) * 4;
    const w = biomeRaw(x, z);
    const vari = fbm(x * 0.03 + 50, z * 0.03 - 20, 5, 4);
    let lz = smoothstep(0.56, 0.72, fbm(x * 0.022 + 9, z * 0.022, 77, 3)) * 0.8;
    for (const o of lavaPts) lz = Math.max(lz, 1 - smoothstep(o.r, o.r + 10, Math.hypot(x - o.x, z - o.z)));
    let oil = 0;
    if (w[0] > 0.2) oil = w[0] * smoothstep(0.7, 0.8, fbm(x * 0.09 + 3, z * 0.09 + 3, 91, 3)) * 0.9;
    let rr = 0;
    if (w[2] > 0.2) {
      rr = smoothstep(32, 8, Math.min(z + HH, x + HW)) * 0.9;
      for (const o of redPts) rr = Math.max(rr, 1 - smoothstep(o.r, o.r + 9, Math.hypot(x - o.x, z - o.z)));
      rr *= w[2];
    }
    mask[k] = Math.round(vari * 255); mask[k + 1] = Math.round(lz * 255); mask[k + 2] = Math.round(oil * 255); mask[k + 3] = Math.round(rr * 255);
  }
  const dtex = (data, w, h) => { const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat); t.magFilter = t.minFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true; return t; };
  const splatTex = dtex(splat, SW, SH), maskTex = dtex(mask, MW_, MH_);

  // ---------- minimap canvas (biome colours + features) ----------
  const minimap = document.createElement('canvas'); minimap.width = 256; minimap.height = 160;
  {
    const g = minimap.getContext('2d'), im = g.createImageData(256, 160);
    const COL = [[112, 110, 106], [58, 44, 40], [74, 98, 50], [206, 176, 120], [140, 122, 98]];
    for (let j = 0; j < 160; j++) for (let i = 0; i < 256; i++) {
      const k = (j * 256 + i) * 4, w = [splat[(j * SW + i) * 4] / 255, splat[(j * SW + i) * 4 + 1] / 255, splat[(j * SW + i) * 4 + 2] / 255, splat[(j * SW + i) * 4 + 3] / 255];
      w[4] = Math.max(0, 1 - w[0] - w[1] - w[2] - w[3]);
      const mk = ((j * 2) * MW_ + i * 2) * 4, n = 0.9 + 0.2 * mask[mk] / 255;
      let r = 0, gg = 0, b = 0; for (let q = 0; q < 5; q++) { r += COL[q][0] * w[q]; gg += COL[q][1] * w[q]; b += COL[q][2] * w[q]; }
      const lv = mask[mk + 1] / 255 * w[1];
      im.data[k] = Math.min(255, r * n + lv * 60); im.data[k + 1] = gg * n; im.data[k + 2] = b * n; im.data[k + 3] = 255;
    }
    g.putImageData(im, 0, 0);
    const sx = 256 / MAP.w, sz = 160 / MAP.h, FC = { cliff: '#8a4a34', grove: '#2c4a22', lava: '#ff6a1a', rock: '#5c5650', dune: '#e2c88e', tower: '#b9b6b0', yard: '#6d5a52', ruin: '#9a958c', slag: '#3a3430', mesa: '#9a6e50' };
    for (const f of feats) {
      g.fillStyle = FC[f.t] || '#555';
      g.beginPath();
      if (f.ry != null) g.ellipse((f.x + HW) * sx, (f.z + HH) * sz, f.r * sx, (f.w || f.r * 0.5) * 0.6 * sz, f.ry, 0, 7);
      else g.arc((f.x + HW) * sx, (f.z + HH) * sz, Math.max(0.8, f.r * sx), 0, 7);
      g.fill();
    }
  }

  // ---------- meshes ----------
  const arr = await arrP;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(MAP.w + 520, MAP.h + 480).rotateX(-Math.PI / 2), groundMaterial(arr, splatTex, maskTex, U, quality));
  ground.name = 'ground'; ground.receiveShadow = true; ground.renderOrder = -1;
  for (const o of [...scene.children]) if (o.name === 'ground' || o.name === 'mapBorder' || o.userData?.kind === 'rock') scene.remove(o);
  scene.add(ground); world.ground = ground;

  const group = new THREE.Group(); group.name = 'terrainFeatures'; scene.add(group);
  const pmat = propsMaterial(arr, U, false), dmat = propsMaterial(arr, U, true);
  for (const k of [0, 1, 2, 3, 4]) if (!B[k].empty) {
    const m = new THREE.Mesh(B[k].build(), pmat); m.castShadow = m.receiveShadow = true; m.name = 'props' + k; group.add(m);
  }
  if (!dunesB.empty) { const m = new THREE.Mesh(dunesB.build(), dmat); m.castShadow = m.receiveShadow = true; m.name = 'dunes'; group.add(m); }
  if (!railB.empty) {
    const m = new THREE.Mesh(railB.build(), fogged(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.2 }), U, 'rail'));
    m.receiveShadow = true; m.name = 'rails'; group.add(m);
  }
  // lava: animated emissive crust → molten core
  const lavaMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  lavaMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = U.uTime;
    sh.vertexShader = 'attribute float aEdge;\nvarying float vEdge;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vEdge = aEdge;');
    sh.fragmentShader = 'uniform float uTime;\nvarying float vEdge;\n' + NOISE_GLSL + sh.fragmentShader.replace('#include <color_fragment>', `
  vec2 tP = vGW.xz * 0.35;
  float tN = tNoise(tP + vec2(uTime * 0.12, uTime * 0.07)) * 0.6 + tNoise(tP * 2.3 - vec2(uTime * 0.18, 0.0)) * 0.4;
  float tCr = smoothstep(0.55, 0.75, tN);
  vec3 tHot = mix(vec3(0.95, 0.22, 0.02), vec3(1.0, 0.62, 0.12), smoothstep(0.3, 0.05, tN));
  vec3 tC = mix(tHot, vec3(0.09, 0.03, 0.02), tCr * 0.9);
  tC = mix(tC, vec3(0.1, 0.06, 0.05), smoothstep(0.7, 1.0, vEdge));
  diffuseColor.rgb = tC;`);
    fogPatch(sh, U);
  };
  lavaMat.customProgramCacheKey = () => 'vanguard-lava';
  if (lavaList.length) { const m = new THREE.Mesh(mergeSimple(lavaList), lavaMat); m.name = 'lava'; group.add(m); }
  if (puddleList.length) {
    const pm = fogged(new THREE.MeshStandardMaterial({ color: 0x2c3238, roughness: 0.06, metalness: 0.1, transparent: true, opacity: 0.88, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }), U, 'puddle');
    pm.userData.envBase = 1.6; pm.envMapIntensity = 1.6;
    const m = new THREE.Mesh(mergeSimple(puddleList), pm); m.name = 'puddles'; m.receiveShadow = true; group.add(m);
  }
  // instanced vegetation
  const mI = new THREE.Matrix4(), col = new THREE.Color();
  function instanced(geo, mat, list, fn, name, shadow = true) {
    if (!list.length) return;
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((t, i) => { fn(t, mI); im.setMatrixAt(i, mI); if (t.c) im.setColorAt(i, col.setRGB(t.c[0], t.c[1], t.c[2])); });
    im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.castShadow = shadow; im.receiveShadow = true; im.name = name; im.computeBoundingSphere(); group.add(im);
  }
  const vegMat = (k) => { const m = fogged(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true }), U, k); m.envMapIntensity = 0.25; m.userData.envBase = 0.25; return m; };
  const coneGeo = (() => {
    const a = new THREE.ConeGeometry(1, 0.62, 7, 1).translate(0, 0.31 + 0.25, 0), b = new THREE.ConeGeometry(0.75, 0.5, 7, 1).translate(0, 0.25 + 0.55, 0);
    const c = new THREE.ConeGeometry(0.48, 0.42, 7, 1).translate(0, 0.21 + 0.82, 0);
    return mergeSimple([{ g: a, m: new THREE.Matrix4() }, { g: b, m: new THREE.Matrix4() }, { g: c, m: new THREE.Matrix4() }]);
  })();
  instanced(new THREE.CylinderGeometry(0.6, 1, 1, 5).translate(0, 0.5, 0), (() => { const m = vegMat('trunk'); m.color.setRGB(0.09, 0.055, 0.035); return m; })(), trees,
    (t, m) => m.compose(new THREE.Vector3(t.x, 0, t.z), new THREE.Quaternion(), new THREE.Vector3(t.s, t.h, t.s)), 'trunks');
  instanced(coneGeo, vegMat('cone'), cones, (t, m) => m.compose(new THREE.Vector3(t.x, 0, t.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, t.ry, 0)), new THREE.Vector3(t.s, t.h, t.s)), 'conifers');
  instanced(rockGeo(31, 1, 0.35), vegMat('bush'), bushes, (t, m) => m.compose(new THREE.Vector3(t.x, t.y, t.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, t.ry, 0)), new THREE.Vector3(t.s, t.h, t.s)), 'bushes');

  // ---------- fog of war ----------
  const fogView = createFogView(world, U);

  // ---------- regional haze (multiplies fx day/night) ----------
  const TINT = [[0.98, 0.88, 0.76], [1.2, 0.74, 0.58], [0.86, 1.02, 0.74], [1.1, 0.99, 0.8], [1, 1, 1]];
  const tint = new THREE.Color(1, 1, 1), hemiTint = new THREE.Color(1, 1, 1), target = new THREE.Color();
  world.regionTint = { color: tint, hemi: hemiTint, weights: null };
  const slots = []; // {get:()=>Color, base: Color, last: Color, mul: Color}
  const slot = (get, mul) => ({ get, mul, base: null, last: new THREE.Color() });
  slots.push(slot(() => scene.fog?.color, tint), slot(() => (scene.background?.isColor ? scene.background : null), tint), slot(() => world.lights?.hemi?.color, hemiTint));
  function applyTint() {
    for (const s of slots) {
      const c = s.get(); if (!c) continue;
      if (!s.base || !c.equals(s.last)) s.base = c.clone();   // someone (fx) rewrote it: that's the new base
      c.copy(s.base).multiply(s.mul); s.last.copy(c);
    }
  }
  let camFix = false;
  function update(dt) {
    U.uTime.value += dt || 0;
    const t = world.camTarget || { x: 0, z: 0 }, w = biomeRaw(t.x, t.z);
    target.setRGB(0, 0, 0);
    for (let i = 0; i < 5; i++) target.r += TINT[i][0] * w[i], target.g += TINT[i][1] * w[i], target.b += TINT[i][2] * w[i];
    const k = Math.min(1, (dt || 0.016) * 1.5);
    tint.lerp(target, k);
    hemiTint.setRGB(1 + (tint.r - 1) * 0.45, 1 + (tint.g - 1) * 0.45, 1 + (tint.b - 1) * 0.45);
    world.regionTint.weights = w;
    applyTint();
    fogView.update(dt);
    if (!camFix && world.views?.aerial) { // aerial zoom-out shows ~1/3 of the map on a phone
      camFix = true; world.views.aerial.max = 80; world.views.aerial.zoom = Math.min(world.views.aerial.zoom, 80);
    }
  }
  tint.setRGB(...TINT[0]);

  const terrain = { update, biomeAt, minimap, features: feats, fogView, mesh: ground, group, layers: LAYERS.map(l => l.f) };
  return terrain;
}
