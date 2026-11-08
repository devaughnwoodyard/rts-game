// Vanguard models (GRAPHICS-B). Procedural, merged-per-material primitive models with two faction themes:
//   team 0 VANGUARD  = cyberpunk neon citadel (dark gloss, cyan/magenta neon, holo signage)
//   team 1 CRIMSON   = Mad Max scrap fortress (rust, war paint, bone, tires, fire, smoke)
// Exports:
//   makeModel(THREE, kind, team)            -> Object3D | null  (models face +X; userData.turret on turreted kinds)
//   updateModels(dt, t)                     -> drives shader time (neon blink/flicker, holo spin, flames, smoke)
//   decorateBase(THREE, scene, team, x, z)  -> Group of non-entity props around a cc (also added to scene)
//   preloadModels(THREE)                    -> async: loads Poly Haven PBR textures + cannon_01 glTF (await before spawning)
// Every model = a few merged meshes (one per material slot), templates cached per kind/theme and cloned.
// Animation is all in shaders off one shared uTime uniform, so updateModels is O(1).
// TODO.md (models): 'warden' returns null (GRAPHICS-A owns animated soldiers). 'rock' is unit-radius: scale by obstacle r.
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

let T = null;
const PI = Math.PI, TAU = PI * 2;
const U = { time: { value: 0 } };

// ---------------------------------------------------------------- palettes
const V = { body: 0x1a2131, body2: 0x223a6e, trim: 0x3a4558, blue: 0x2f6fe0, blue2: 0x1d4fb0, steel: 0x7d8aa0, glass: 0x0a0e16,
  cyan: 0x39d8ff, mag: 0xff3dbd, white: 0xdff6ff, amber: 0xffb347, red: 0xff3355 };
const C = { rust: 0x8a3b1f, rust2: 0x6a3420, rust3: 0xa5552a, red: 0xc8322e, red2: 0x9a2420, bone: 0xd8c7a0, soot: 0x26211e,
  steel: 0x6e6862, steel2: 0x4c4744, tire: 0x1b1918, sand: 0xb09a6c, dirt: 0x5a4030, fire: 0xff7a1a, amber: 0xffa030, cyan: 0x39d8ff };

function rng(seed) { let s = (seed >>> 0) || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// ---------------------------------------------------------------- textures (procedural canvases)
const TEX = {};
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; }
function texFrom(c, srgb = true) {
  const t = new T.CanvasTexture(c); t.wrapS = t.wrapT = T.RepeatWrapping; t.anisotropy = 4;
  if (srgb) t.colorSpace = T.SRGBColorSpace; return t;
}
function blotches(g, r, n, rgb, aMax, sMax) {
  for (let i = 0; i < n; i++) {
    const x = r() * 256, y = r() * 256, s = 3 + r() * sMax, a = 0.015 + r() * aMax;
    g.fillStyle = `rgba(${rgb},${a})`;
    for (const ox of [-256, 0, 256]) for (const oy of [-256, 0, 256]) { g.beginPath(); g.arc(x + ox, y + oy, s, 0, TAU); g.fill(); }
  }
}
function panelTex() { // Vanguard: subtle panel seams on near-white (multiplies vertex colour)
  if (TEX.panel) return TEX.panel;
  const [c, g] = canvas(256, 256), r = rng(11);
  g.fillStyle = '#f0f0f0'; g.fillRect(0, 0, 256, 256);
  blotches(g, r, 120, '20,24,30', 0.04, 18);
  for (let y = 0; y < 256; y += 64) {
    g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(0, y, 256, 2);
    g.fillStyle = 'rgba(255,255,255,0.5)'; g.fillRect(0, y + 2, 256, 1);
    for (let k = 0; k < 2; k++) { const x = (r() * 256) | 0; g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(x, y, 2, 64); }
    if (r() < 0.6) { const x = r() * 200, w = 20 + r() * 30; g.strokeStyle = 'rgba(0,0,0,0.3)'; g.strokeRect(x, y + 14, w, 22); }
  }
  return (TEX.panel = texFrom(c));
}
function rustTex() { // Crimson: corrugated sheet, rust streaks, scratches
  if (TEX.rust) return TEX.rust;
  const [c, g] = canvas(256, 256), r = rng(23);
  for (let x = 0; x < 256; x++) { const v = 200 + 40 * Math.sin(x / 16 * TAU); g.fillStyle = `rgb(${v | 0},${(v * 0.93) | 0},${(v * 0.86) | 0})`; g.fillRect(x, 0, 1, 256); }
  blotches(g, r, 260, '60,25,10', 0.12, 20);
  blotches(g, r, 80, '255,220,180', 0.08, 10);
  for (let i = 0; i < 70; i++) { // drips
    const x = r() * 256, y = r() * 256, l = 20 + r() * 90; const gr = g.createLinearGradient(0, y, 0, y + l);
    gr.addColorStop(0, 'rgba(50,18,6,0.5)'); gr.addColorStop(1, 'rgba(50,18,6,0)'); g.fillStyle = gr; g.fillRect(x, y, 1.5 + r() * 3, l);
  }
  for (let i = 0; i < 40; i++) { g.strokeStyle = `rgba(255,240,220,${0.15 + r() * 0.2})`; g.beginPath(); const x = r() * 256, y = r() * 256; g.moveTo(x, y); g.lineTo(x + (r() - 0.5) * 40, y + (r() - 0.5) * 12); g.stroke(); }
  for (let y = 0; y < 256; y += 128) for (let x = 6; x < 256; x += 24) { g.fillStyle = 'rgba(30,15,8,0.6)'; g.fillRect(x, y + 4, 3, 3); }
  return (TEX.rust = texFrom(c));
}
function grimeTex() { // Crimson solids: grime + welds
  if (TEX.grime) return TEX.grime;
  const [c, g] = canvas(256, 256), r = rng(37);
  g.fillStyle = '#e8e2da'; g.fillRect(0, 0, 256, 256);
  blotches(g, r, 300, '40,25,15', 0.09, 22);
  for (let i = 0; i < 16; i++) { // weld seams
    const y = r() * 256, x = r() * 200; g.strokeStyle = 'rgba(30,20,15,0.55)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(x, y); for (let k = 0; k < 8; k++) g.lineTo(x + k * 8, y + (k % 2) * 2); g.stroke();
  }
  for (let i = 0; i < 60; i++) { g.strokeStyle = `rgba(255,250,240,${0.1 + r() * 0.25})`; g.lineWidth = 1; g.beginPath(); const x = r() * 256, y = r() * 256; g.moveTo(x, y); g.lineTo(x + (r() - 0.5) * 30, y + (r() - 0.5) * 30); g.stroke(); }
  return (TEX.grime = texFrom(c));
}
// Holo atlas: 4 cols x 2 rows of 256px cells (1024x512).
// 0 cyan glyph column, 1 magenta glyph column, 2 banner bars, 3 cyan glow blob, 4 magenta glow blob, 5 glyph strip, 6 landing pad, 7 amber hazard
function cellUV(i) { const cx = i % 4, cy = (i / 4) | 0; return [cx / 4, 1 - (cy + 1) / 2, (cx + 1) / 4, 1 - cy / 2]; }
function holoTex() {
  if (TEX.holo) return TEX.holo;
  const [c, g] = canvas(1024, 512), r = rng(51);
  g.fillStyle = '#000'; g.fillRect(0, 0, 1024, 512);
  const glyph = (x, y, s, col) => {
    g.fillStyle = col; const n = 3 + ((r() * 4) | 0), t = Math.max(2, s * 0.12);
    for (let k = 0; k < n; k++) {
      const a = (r() * 3) | 0, b = (r() * 3) | 0;
      if (r() < 0.5) g.fillRect(x + a * s / 3, y + b * s / 3, s / 3 + (r() < 0.5 ? s / 3 : 0), t);
      else g.fillRect(x + a * s / 3, y + b * s / 3, t, s / 3 + (r() < 0.5 ? s / 3 : 0));
    }
    if (r() < 0.4) { g.strokeStyle = col; g.lineWidth = t; g.strokeRect(x + s * 0.15, y + s * 0.15, s * 0.6, s * 0.6); }
  };
  const frame = (ox, oy, col) => { g.strokeStyle = col; g.lineWidth = 6; g.strokeRect(ox + 8, oy + 8, 240, 240); g.globalAlpha = 0.12; g.fillStyle = col; g.fillRect(ox + 8, oy + 8, 240, 240); g.globalAlpha = 1; };
  // 0/1 glyph columns
  [[0, '#39d8ff', '#ff3dbd'], [1, '#ff3dbd', '#39d8ff']].forEach(([i, a, b]) => {
    const ox = i * 256; frame(ox, 0, a);
    for (let k = 0; k < 4; k++) glyph(ox + 78, 24 + k * 54, 46, k === 1 ? '#ffffff' : a);
    g.fillStyle = b; for (let k = 0; k < 6; k++) g.fillRect(ox + 30, 30 + k * 34, 18, 20 * r() + 4);
    g.fillStyle = a; for (let k = 0; k < 6; k++) g.fillRect(ox + 186, 30 + k * 34, 40 * r() + 6, 8);
  });
  // 2 banner
  { const ox = 512; frame(ox, 0, '#ff3dbd'); for (let k = 0; k < 4; k++) glyph(ox + 22 + k * 56, 36, 48, k % 2 ? '#39d8ff' : '#ffffff');
    for (let k = 0; k < 10; k++) { g.fillStyle = k % 3 ? '#ff3dbd' : '#39d8ff'; g.fillRect(ox + 24 + k * 21, 200 - 90 * r(), 14, 0); g.fillRect(ox + 24 + k * 21, 130 + 70 * (1 - r()), 14, 230 - (130 + 70 * (1 - r()))); } }
  // 3/4 blobs
  [[3, '57,216,255'], [4, '255,61,189']].forEach(([i, rgb]) => {
    const ox = (i % 4) * 256, oy = 0, gr = g.createRadialGradient(ox + 128, oy + 128, 4, ox + 128, oy + 128, 126);
    gr.addColorStop(0, `rgba(${rgb},1)`); gr.addColorStop(0.45, `rgba(${rgb},0.45)`); gr.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = gr; g.fillRect(ox, oy, 256, 256);
  });
  // 5 glyph strip (row 2 col 1)
  { const ox = 256, oy = 256; g.fillStyle = 'rgba(57,216,255,0.15)'; g.fillRect(ox, oy + 70, 256, 116);
    g.fillStyle = '#39d8ff'; g.fillRect(ox, oy + 70, 256, 5); g.fillRect(ox, oy + 181, 256, 5);
    for (let k = 0; k < 5; k++) glyph(ox + 6 + k * 50, oy + 100, 42, k === 2 ? '#ff3dbd' : '#bff4ff'); }
  // 4th slot row 1 col 0 = blob duplicate unused -> make cell 4 at (0,1)? keep map consistent: cell index i -> (i%4, i/4)
  // cell 4 is (0,1): redraw magenta blob there
  { const ox = 0, oy = 256; g.fillStyle = '#000'; g.fillRect(ox, oy, 256, 256);
    const gr = g.createRadialGradient(ox + 128, oy + 128, 4, ox + 128, oy + 128, 126);
    gr.addColorStop(0, 'rgba(255,61,189,1)'); gr.addColorStop(0.45, 'rgba(255,61,189,0.45)'); gr.addColorStop(1, 'rgba(255,61,189,0)');
    g.fillStyle = gr; g.fillRect(ox, oy, 256, 256); }
  // 6 landing pad (2,1)
  { const ox = 512, oy = 256; g.strokeStyle = '#39d8ff'; g.lineWidth = 10; g.beginPath(); g.arc(ox + 128, oy + 128, 104, 0, TAU); g.stroke();
    g.lineWidth = 3; g.beginPath(); g.arc(ox + 128, oy + 128, 86, 0, TAU); g.stroke();
    g.fillStyle = '#ffffff'; g.fillRect(ox + 88, oy + 78, 16, 100); g.fillRect(ox + 152, oy + 78, 16, 100); g.fillRect(ox + 88, oy + 120, 80, 16);
    g.fillStyle = '#ff3dbd'; for (let k = 0; k < 8; k++) { const a = k / 8 * TAU; g.fillRect(ox + 128 + Math.cos(a) * 116 - 5, oy + 128 + Math.sin(a) * 116 - 5, 10, 10); } }
  // 7 amber hazard (3,1)
  { const ox = 768, oy = 256; for (let k = -4; k < 8; k++) { g.fillStyle = '#ffb347'; g.beginPath(); g.moveTo(ox + k * 48, oy + 256); g.lineTo(ox + k * 48 + 24, oy + 256); g.lineTo(ox + k * 48 + 280, oy); g.lineTo(ox + k * 48 + 256, oy); g.fill(); } }
  const t = texFrom(c); t.wrapS = t.wrapT = T.ClampToEdgeWrapping; return (TEX.holo = t);
}
function scanTex() {
  if (TEX.scan) return TEX.scan;
  const [c, g] = canvas(64, 128);
  g.fillStyle = '#5a5a5a'; g.fillRect(0, 0, 64, 128);
  for (let y = 0; y < 128; y += 8) { g.fillStyle = '#ffffff'; g.fillRect(0, y, 64, 2); }
  g.fillStyle = '#d0d0d0'; g.fillRect(0, 0, 3, 128); g.fillRect(61, 0, 3, 128);
  return (TEX.scan = texFrom(c));
}
function envTex() { // fake reflection environment (dusk desert + a few light cards) for glossy metals
  if (TEX.env) return TEX.env;
  const [c, g] = canvas(256, 128);
  const gr = g.createLinearGradient(0, 0, 0, 128);
  gr.addColorStop(0, '#2a3550'); gr.addColorStop(0.42, '#9aa6b8'); gr.addColorStop(0.5, '#f0c890'); gr.addColorStop(0.56, '#8a5a38'); gr.addColorStop(1, '#2a1c14');
  g.fillStyle = gr; g.fillRect(0, 0, 256, 128);
  g.fillStyle = 'rgba(255,250,235,0.95)'; g.fillRect(30, 18, 40, 10); g.fillRect(150, 28, 24, 24); g.fillRect(200, 12, 50, 6);
  g.fillStyle = 'rgba(57,216,255,0.6)'; g.fillRect(100, 52, 30, 4);
  g.fillStyle = 'rgba(255,61,189,0.5)'; g.fillRect(230, 54, 20, 4);
  const t = texFrom(c); t.mapping = T.EquirectangularReflectionMapping; return (TEX.env = t);
}

// ---------------------------------------------------------------- materials
function patchFx(m, key) {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = U.time;
    sh.vertexShader = 'attribute float aFx;\nvarying float vFx;\nuniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      float md = floor(aFx + 0.001); float ph = fract(aFx) * 6.2831;
      vFx = 1.0;
      if (md > 0.5 && md < 1.5) vFx = 0.1 + 1.2 * step(0.7, fract(uTime * 0.8 + ph * 0.159));
      else if (md > 1.5 && md < 2.5) { float gl = fract(sin(floor(uTime * 12.0) * 1.7 + ph * 13.0) * 43758.5); vFx = gl > 0.9 ? 0.2 : 0.85 + 0.15 * sin(uTime * 37.0 + ph); }
      else if (md > 2.5 && md < 3.5) vFx = 0.6 + 0.4 * sin(uTime * 2.4 + ph);
      else if (md > 5.5) { float fr = floor(uTime * 14.0 + ph * 3.0);
        vec3 hp = floor(transformed * 4.0 + 0.5);
        float h1 = fract(sin(dot(hp, vec3(12.9, 78.2, 37.7)) + fr * 7.13) * 43758.5), h2 = fract(sin(dot(hp, vec3(39.3, 11.1, 83.9)) + fr * 3.71) * 24634.6);
        transformed.xz += (vec2(h1, h2) - 0.5) * 0.7;
        vFx = fract(sin(fr * 1.37 + ph) * 9187.3) > 0.35 ? 1.6 : 0.0; }
      else if (md > 3.5) { float a = uTime * (md > 4.5 ? -0.9 : 0.6) + ph; float c = cos(a), s = sin(a); transformed.xz = mat2(c, -s, s, c) * transformed.xz; vFx = 0.85 + 0.15 * sin(uTime * 3.0 + ph); }`);
    sh.fragmentShader = 'varying float vFx;\n' + sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb *= vFx;');
  };
  m.customProgramCacheKey = () => 'vgfx-' + key;
  return m;
}
function fireMat() {
  const m = new T.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide, toneMapped: false });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = U.time;
    sh.vertexShader = 'attribute vec3 aBase;\nuniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      vec3 d = transformed - aBase; float ph = dot(aBase, vec3(1.7, 3.1, 2.3));
      float s = 0.8 + 0.28 * sin(uTime * 11.0 + ph) + 0.16 * sin(uTime * 23.0 + ph * 1.7);
      float w = 1.15 - 0.25 * s;
      transformed = aBase + vec3(d.x * w, d.y * s, d.z * w) + vec3(sin(uTime * 6.0 + ph), 0.0, cos(uTime * 5.0 + ph)) * 0.14 * max(d.y, 0.0);`);
  };
  m.customProgramCacheKey = () => 'vgfire';
  return m;
}
function emberMat() {
  return new T.ShaderMaterial({
    uniforms: { uTime: U.time }, transparent: true, depthWrite: false, blending: T.AdditiveBlending,
    vertexShader: `uniform float uTime; attribute vec3 aBase; attribute vec2 aPS; varying float vA; varying float vK; varying vec2 vUv;
      void main(){ float k = fract(uTime * 0.45 + aPS.x);
        #ifdef USE_INSTANCING
        vec4 wb = modelMatrix * instanceMatrix * vec4(aBase, 1.0);
        #else
        vec4 wb = modelMatrix * vec4(aBase, 1.0);
        #endif
        wb.xyz += vec3(sin(aPS.x * 50.0 + uTime * 3.0) * 0.4 * k, k * 4.0 * aPS.y, cos(aPS.x * 31.0 + uTime * 2.3) * 0.4 * k);
        vec4 mv = viewMatrix * wb; float sz = 0.2 * aPS.y * (1.0 - 0.5 * k);
        mv.xy += position.xy * sz; gl_Position = projectionMatrix * mv;
        vA = (1.0 - k) * smoothstep(0.0, 0.05, k) * (0.7 + 0.3 * sin(uTime * 20.0 + aPS.x * 90.0)); vK = k; vUv = position.xy; }`,
    fragmentShader: `varying float vA; varying float vK; varying vec2 vUv;
      void main(){ float d = length(vUv) * 2.0; float a = (1.0 - smoothstep(0.2, 1.0, d)) * vA; if (a < 0.02) discard;
        gl_FragColor = vec4(mix(vec3(1.0, 0.8, 0.35), vec3(1.0, 0.25, 0.05), vK) * 1.6, a); }`,
  });
}
function sparkMat() { const m = emberMat(); m.fragmentShader = m.fragmentShader.replace('mix(vec3(1.0, 0.8, 0.35), vec3(1.0, 0.25, 0.05), vK) * 1.6', 'mix(vec3(0.9, 0.97, 1.0), vec3(0.3, 0.6, 1.0), vK) * 1.8'); return m; }
function smokeMat(col = [0.16, 0.14, 0.13], alpha = 0.75, additive = false) {
  return new T.ShaderMaterial({
    uniforms: { uTime: U.time, uColor: { value: new T.Vector3(...col) }, uAlpha: { value: alpha } },
    transparent: true, depthWrite: false, blending: additive ? T.AdditiveBlending : T.NormalBlending,
    vertexShader: `uniform float uTime; attribute vec3 aBase; attribute vec2 aPS; varying float vA; varying vec2 vUv;
      void main(){ float k = fract(uTime * 0.2 + aPS.x);
        #ifdef USE_INSTANCING
        vec4 wb = modelMatrix * instanceMatrix * vec4(aBase, 1.0);
        #else
        vec4 wb = modelMatrix * vec4(aBase, 1.0);
        #endif
        wb.xyz += vec3(sin(aPS.x * 40.0) * 0.5 * k + k * 1.6, k * 6.5 * aPS.y, cos(aPS.x * 23.0) * 0.5 * k);
        vec4 mv = viewMatrix * wb; float sz = aPS.y * (0.8 + k * 3.2);
        mv.xy += position.xy * sz; gl_Position = projectionMatrix * mv;
        vA = smoothstep(0.0, 0.1, k) * (1.0 - k); vUv = position.xy; }`,
    fragmentShader: `uniform vec3 uColor; uniform float uAlpha; varying float vA; varying vec2 vUv;
      void main(){ float d = length(vUv) * 2.0; float a = (1.0 - smoothstep(0.3, 1.0, d)) * vA * uAlpha; if (a < 0.01) discard; gl_FragColor = vec4(uColor * (1.2 - d * 0.4), a); }`,
  });
}
const MATS = {};
let MAT_OVERRIDE = null;
const PH = (f, dir = 'ph') => new URL(`../assets/${dir}/${f}`, import.meta.url).href;
const PBR = {}, pending = [];
function pbr(name, opts = {}) {
  if (PBR[name]) return PBR[name];
  const L = new T.TextureLoader(), ld = (f, srgb) => { const t = L.load(PH(`${name}/${f}`, opts.dir), undefined, undefined, () => console.warn('[models] missing', name, f));
    t.wrapS = t.wrapT = T.RepeatWrapping; t.anisotropy = 4; if (srgb) t.colorSpace = T.SRGBColorSpace; return t; };
  const map = ld('diff.jpg', true), arm = ld('arm.jpg', false);
  return (PBR[name] = new T.MeshStandardMaterial({ vertexColors: true, map, normalMap: ld('nor_gl.jpg', false), normalScale: new T.Vector2(1, 1),
    roughnessMap: arm, metalnessMap: arm, roughness: 1, metalness: opts.metal ?? 0, envMap: envTex(), envMapIntensity: 0.3, side: opts.side ?? T.FrontSide }));
}
function stoneMat() { const m = pbr('rocky_terrain_02'); m.color.setRGB(1.9, 1.55, 1.3); return m; }
function pbrMats() { return { brick: pbr('medieval_red_brick'), denim: pbr('denim_fabric_04', { side: T.DoubleSide }), jacq: pbr('quatrefoil_jacquard_fabric', { side: T.DoubleSide }) }; }
const UVK = { brick: 0.42, denim: 0.35, jacq: 0.5, stone: 0.22, conc: 0.22, corr: 0.35, steel: 0.4, shutter: 0.45, haz: 0.9 };
let CANNON = null;
function mats(theme) {
  if (MATS[theme]) return MATS[theme];
  const env = envTex();
  const glow = patchFx(new T.MeshBasicMaterial({ vertexColors: true, toneMapped: false }), 'glow');
  let m;
  if (theme === 'V') m = {
    lit: new T.MeshStandardMaterial({ vertexColors: true, map: panelTex(), metalness: 0.6, roughness: 0.34, envMap: env, envMapIntensity: 1.5 }),
    glow,
    holo: patchFx(new T.MeshBasicMaterial({ vertexColors: true, map: holoTex(), transparent: true, opacity: 0.92, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide, toneMapped: false }), 'holo'),
    energy: patchFx(new T.MeshBasicMaterial({ vertexColors: true, map: scanTex(), transparent: true, opacity: 0.5, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide, toneMapped: false }), 'energy'),
    jacq: pbrMats().jacq,
  };
  else if (theme === 'C') m = {
    scrap: new T.MeshStandardMaterial({ vertexColors: true, map: rustTex(), metalness: 0.45, roughness: 0.7, envMap: env, envMapIntensity: 0.4 }),
    solid: new T.MeshStandardMaterial({ vertexColors: true, map: grimeTex(), metalness: 0.6, roughness: 0.45, envMap: env, envMapIntensity: 0.8 }),
    stone: stoneMat(),
    glow, fire: fireMat(), smoke: smokeMat(), ember: emberMat(), haze: smokeMat([0.55, 0.3, 0.12], 0.35, true), ...pbrMats(),
  };
  else if (theme === 'X') { // volcanic: glossy obsidian/iron + dark basalt
    const b = mats('C'), bas = pbr('rocky_terrain_02').clone(); bas.color.setRGB(1.35, 1.2, 1.15); bas.envMapIntensity = 0.6;
    m = { ...b, stone: bas, solid: new T.MeshStandardMaterial({ vertexColors: true, map: grimeTex(), metalness: 0.3, roughness: 0.18, envMap: env, envMapIntensity: 1.8 }),
      haze: smokeMat([0.6, 0.55, 0.35], 0.3, false) };
  }
  else if (theme === 'I') {
    m = { conc: pbr('concrete_panels', { dir: 'tex' }), corr: pbr('box_profile_metal_sheet', { dir: 'tex', metal: 0.3, side: T.DoubleSide }),
      steel: pbr('metal_plate', { metal: 0.35 }), shutter: pbr('painted_metal_shutter', { metal: 0.3 }),
      haz: new T.MeshStandardMaterial({ vertexColors: true, map: hazTex(), metalness: 0.3, roughness: 0.6, envMap: env, envMapIntensity: 0.4 }),
      glow, smoke: smokeMat([0.5, 0.5, 0.52], 0.55, false) };
    for (const k of ['conc', 'corr', 'steel', 'shutter']) m[k].envMapIntensity = 0.7;
    m.conc.color.setRGB(0.92, 1.0, 1.12); m.corr.color.setRGB(1.7, 1.7, 1.7); m.steel.color.setRGB(1.6, 1.6, 1.6);
  }
  else if (theme === 'E') {
    const st = pbr('rocky_terrain_02').clone(); st.color.setRGB(1.7, 1.45, 1.3);
    m = { stone: st, brick: pbrMats().brick, jacq: pbrMats().jacq, glow,
      leaf: new T.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85, metalness: 0, envMap: env, envMapIntensity: 0.3 }),
      gold: new T.MeshStandardMaterial({ vertexColors: true, metalness: 0.9, roughness: 0.3, envMap: env, envMapIntensity: 1.4 }),
      beam: patchFx(new T.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.45, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide, toneMapped: false }), 'beam'),
      ember: emberMat(), haze: smokeMat([0.6, 0.55, 0.4], 0.25, true) };
  }
  else if (theme === 'S') {
    const sand = pbr('rocky_terrain_02').clone(); sand.color.setRGB(2.2, 1.9, 1.5);
    m = { stone: sand, jacq: pbrMats().jacq, denim: pbrMats().denim, glow,
      solid: new T.MeshStandardMaterial({ vertexColors: true, map: grimeTex(), metalness: 0.45, roughness: 0.38, envMap: env, envMapIntensity: 1.0 }),
      energy: patchFx(new T.MeshBasicMaterial({ vertexColors: true, map: scanTex(), transparent: true, opacity: 0.45, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide, toneMapped: false }), 'senergy'),
      ember: sparkMat(), haze: smokeMat([0.72, 0.62, 0.45], 0.35, false) };
  }
  else m = {
    crystal: new T.MeshStandardMaterial({ color: 0x2fd8ff, emissive: 0x0f9fd8, emissiveIntensity: 1.0, metalness: 0.15, roughness: 0.25, transparent: true, opacity: 0.9, flatShading: true, envMap: env, envMapIntensity: 1.2 }),
    rock: new T.MeshStandardMaterial({ vertexColors: true, metalness: 0.05, roughness: 0.9, flatShading: true, emissive: 0x010101 }),
    glow,
  };
  return (MATS[theme] = m);
}

// ---------------------------------------------------------------- geometry helpers
const GC = new Map();
const gc = (k, f) => GC.get(k) || (GC.set(k, f()), GC.get(k));
const box = (w, h, d) => gc(`b${w},${h},${d}`, () => new T.BoxGeometry(w, h, d));
const UBOX = () => gc('ub', () => new T.BoxGeometry(1, 1, 1));
const cyl = (rt, rb, h, seg = 12, open = false) => gc(`c${rt},${rb},${h},${seg},${open}`, () => new T.CylinderGeometry(rt, rb, h, seg, 1, open));
const cone = (r, h, seg = 4) => gc(`k${r},${h},${seg}`, () => new T.ConeGeometry(r, h, seg));
const sph = (r, ws = 8, hs = 6) => gc(`s${r},${ws},${hs}`, () => new T.SphereGeometry(r, ws, hs));
const ico = (r, d = 0) => gc(`i${r},${d}`, () => new T.IcosahedronGeometry(r, d));
const torus = (R, r, rs = 6, ts = 12) => gc(`t${R},${r},${rs},${ts}`, () => new T.TorusGeometry(R, r, rs, ts));
const plane = (w, h) => gc(`p${w},${h}`, () => new T.PlaneGeometry(w, h));
function bbox(w, h, d, b) {
  b = Math.min(b ?? Math.min(w, h, d) * 0.12, w / 2 - 0.01, h / 2 - 0.01, d / 2 - 0.01);
  return gc(`bb${w},${h},${d},${b}`, () => {
    const s = new T.Shape(), hw = w / 2 - b, hh = h / 2 - b;
    s.moveTo(-hw, -hh); s.lineTo(hw, -hh); s.lineTo(hw, hh); s.lineTo(-hw, hh); s.closePath();
    const g = new T.ExtrudeGeometry(s, { depth: d - 2 * b, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelSegments: 1, curveSegments: 1 });
    g.translate(0, 0, -(d - 2 * b) / 2); return g;
  });
}
function prism(pts, depth, b = 0.05) { // side profile in XY (x forward, y up), extruded along Z, centred
  return gc(`pr${pts.join(';')},${depth},${b}`, () => {
    const s = new T.Shape(); s.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]); s.closePath();
    const dd = Math.max(0.01, depth - 2 * b);
    const g = new T.ExtrudeGeometry(s, { depth: dd, bevelEnabled: b > 0, bevelThickness: b, bevelSize: b, bevelSegments: 1, curveSegments: 1 });
    g.translate(0, 0, -dd / 2); return g;
  });
}
function cloth(w, h, sag = 0.3, wave = 0) { // plane in XY, sagging/waving along Z
  return gc(`cl${w},${h},${sag},${wave}`, () => {
    const g = new T.PlaneGeometry(w, h, 10, 8), p = g.attributes.position;
    for (let i = 0; i < p.count; i++) { const u = p.getX(i) / w + 0.5, v = p.getY(i) / h + 0.5;
      p.setZ(i, -sag * Math.sin(PI * u) * Math.sin(PI * v) + wave * Math.sin(u * 9 + v * 4) * (1 - v * 0.5)); }
    g.computeVertexNormals(); return g;
  });
}
function M4(p = [0, 0, 0], r = [0, 0, 0], s = [1, 1, 1]) {
  if (typeof s === 'number') s = [s, s, s];
  return new T.Matrix4().compose(new T.Vector3(p[0], p[1], p[2]), new T.Quaternion().setFromEuler(new T.Euler(r[0], r[1], r[2])), new T.Vector3(s[0], s[1], s[2]));
}
const _up = () => new T.Vector3(0, 1, 0);
function Mline(a, b, sx, sz) { // unit-height geometry stretched from a to b
  const A = new T.Vector3(...a), B = new T.Vector3(...b), d = B.clone().sub(A), L = d.length() || 1e-4;
  return new T.Matrix4().compose(A.clone().add(B).multiplyScalar(0.5), new T.Quaternion().setFromUnitVectors(_up(), d.normalize()), new T.Vector3(sx, L, sz));
}
const polar = (r, a, y = 0) => [Math.sin(a) * r, y, Math.cos(a) * r]; // matches CylinderGeometry vertex angles

function ccBeacon(k, p, col, h = 3.5, slot = null) { // tall faction-colour beacon visible from the aerial camera
  k.add(slot || 'glow', cyl(0.07, 0.07, h, 4), 0x222222, [p[0], p[1] + h / 2, p[2]]);
  k.add('glow', sph(0.55, 10, 6), col, [p[0], p[1] + h + 0.3, p[2]], 0, 1, { fx: 3.5, smooth: true });
  k.add('glow', torus(1.1, 0.09, 3, 20), col, [p[0], p[1] + h + 0.3, p[2]], [PI / 2, 0, 0], 1, { fx: 4.2 });
  k.add('glow', torus(1.6, 0.06, 3, 24), col, [p[0], p[1] + h * 0.6, p[2]], [PI / 2, 0, 0], 1, { fx: 5.5 });
}
// ---------------------------------------------------------------- Kit: collects geometry per material slot, merges on build
class Kit {
  constructor(theme) { this.theme = theme === 'C' && MAT_OVERRIDE ? MAT_OVERRIDE : theme; this.s = {}; this.st = [null]; this.parts = { smoke: [], ember: [], haze: [] }; }
  top() { return this.st[this.st.length - 1] || new T.Matrix4(); }
  push(p, r, s) { this.st.push(this.top().clone().multiply(M4(p, r, s))); return this; }
  pop() { this.st.pop(); return this; }
  add(slot, geo, color = 0xffffff, p, r, s, o = {}) { return this.addM(slot, geo, color, o.m || M4(p, r, s), o); }
  addM(slot, geo, color, m, o = {}) {
    const mm = this.top().clone().multiply(m);
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    const uvSrc = o.uv ? g.attributes.uv : null;
    for (const n of Object.keys(g.attributes)) if (n !== 'position' && n !== 'normal') g.deleteAttribute(n);
    g.morphAttributes = {}; g.clearGroups();
    g.applyMatrix4(mm);
    if (!o.smooth) g.computeVertexNormals();
    const pos = g.attributes.position, nor = g.attributes.normal, n = pos.count;
    const uv = new Float32Array(n * 2);
    if (uvSrc) { const [u0, v0, u1, v1] = o.uv; for (let i = 0; i < n; i++) { uv[i * 2] = u0 + uvSrc.getX(i) * (u1 - u0); uv[i * 2 + 1] = v0 + uvSrc.getY(i) * (v1 - v0); } }
    else for (let i = 0; i < n; i++) {
      const ax = Math.abs(nor.getX(i)), ay = Math.abs(nor.getY(i)), az = Math.abs(nor.getZ(i)), k = UVK[slot] || 0.32;
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (ax >= ay && ax >= az) { uv[i * 2] = z * k; uv[i * 2 + 1] = y * k; } else if (ay >= az) { uv[i * 2] = x * k; uv[i * 2 + 1] = z * k; } else { uv[i * 2] = x * k; uv[i * 2 + 1] = y * k; }
    }
    g.setAttribute('uv', new T.BufferAttribute(uv, 2));
    const col = new Float32Array(n * 3), cc = new T.Color();
    if (typeof color === 'function') for (let i = 0; i < n; i++) { cc.set(color(pos.getX(i), pos.getY(i), pos.getZ(i))); col.set([cc.r, cc.g, cc.b], i * 3); }
    else { cc.set(color); for (let i = 0; i < n; i++) col.set([cc.r, cc.g, cc.b], i * 3); }
    g.setAttribute('color', new T.BufferAttribute(col, 3));
    g.setAttribute('aFx', new T.BufferAttribute(new Float32Array(n).fill(o.fx || 0), 1));
    if (slot === 'fire') {
      const b = new T.Vector3(...(o.base || [0, 0, 0])).applyMatrix4(this.top()), ab = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) ab.set([b.x, b.y, b.z], i * 3);
      g.setAttribute('aBase', new T.BufferAttribute(ab, 3));
    }
    (this.s[slot] ||= []).push(g);
    return this;
  }
  line(slot, a, b, r, color, seg = 6, o = {}) { return this.addM(slot, gc(`ul${seg}`, () => new T.CylinderGeometry(1, 1, 1, seg)), color, Mline(a, b, r, r), o); }
  bar(slot, a, b, t, color, o = {}) { return this.addM(slot, UBOX(), color, Mline(a, b, t, t), o); }
  spike(slot, base, dir, len, r, color) {
    const d = new T.Vector3(...dir).normalize(), p = new T.Vector3(...base).addScaledVector(d, len / 2);
    return this.addM(slot, cone(1, 1, 4), color, new T.Matrix4().compose(p, new T.Quaternion().setFromUnitVectors(_up(), d), new T.Vector3(r, len, r)));
  }
  flame(p, h = 1, r = 0.3) {
    const base = [p[0], p[1], p[2]];
    const grad = (c0, c1, y0, hh) => (x, y) => { const k = Math.min(1, Math.max(0, (y - y0) / hh)); return new T.Color(c0).lerp(new T.Color(c1), k).getHex(); };
    const y0w = new T.Vector3(...p).applyMatrix4(this.top()).y;
    this.add('fire', cone(1, 1, 7), grad(0xff9a2a, 0x801000, y0w, h), [p[0], p[1] + h / 2, p[2]], [0, 0, 0], [r, h, r], { base });
    this.add('fire', cone(1, 1, 6), grad(0xfff0a0, 0xff6010, y0w, h * 0.6), [p[0], p[1] + h * 0.3, p[2]], [0, 1, 0], [r * 0.55, h * 0.6, r * 0.55], { base });
    return this;
  }
  particles(kind, p, n, size, spread = 0) { const v = new T.Vector3(...p).applyMatrix4(this.top());
    for (let i = 0; i < n; i++) this.parts[kind].push([v.x + (Math.random() - 0.5) * spread, v.y, v.z + (Math.random() - 0.5) * spread, i / n + Math.random() * 0.13, size]); return this; }
  smoke(p, n = 4, size = 1) { return this.particles('smoke', p, n, size); }
  sparks(p, n = 5, spread = 0.5) { return this.particles('ember', p, n, 0.6, spread); }
  sub(name, p, r, fn) { const q = new Kit(this.theme); fn(q); (this.subs ||= []).push([name, p, r, q]); return this; }
  embers(p, n = 8, spread = 0.6, size = 1) { return this.particles('ember', p, n, size, spread); }
  haze(p, n = 3, size = 1) { return this.particles('haze', p, n, size); }
  sign(p, ry, w, h, cell, fx = 2, color = 0xffffff, rx = 0) {
    if (this.theme === 'V') this.add('lit', box(w + 0.12, h + 0.12, 0.06), V.glass, [p[0] - Math.sin(ry) * 0.06, p[1], p[2] - Math.cos(ry) * 0.06], [rx, ry, 0]);
    return this.add('holo', plane(w, h), color, p, [rx, ry, 0], [1, 1, 1], { uv: cellUV(cell), fx: fx + Math.random() * 0.9, smooth: true }); }
  build(name) {
    const grp = new T.Group(); if (name) grp.name = name;
    const M = mats(this.theme);
    for (const [slot, list] of Object.entries(this.s)) {
      const g = mergeGeometries(list, false);
      if (!g) { console.warn('[models] merge failed', slot); continue; }
      g.computeBoundingSphere();
      const mesh = new T.Mesh(g, M[slot]);
      const lit = !(slot === 'glow' || slot === 'holo' || slot === 'energy' || slot === 'fire');
      mesh.castShadow = lit; mesh.receiveShadow = lit;
      if (!lit) mesh.renderOrder = slot === 'glow' ? 0 : 2;
      if (slot === 'glow' || slot === 'holo' || slot === 'energy' || slot === 'fire') mesh.frustumCulled = slot !== 'holo' && slot !== 'glow' ? false : true;
      grp.add(mesh);
    }
    for (const [kind, list] of Object.entries(this.parts)) {
      if (!list.length) continue;
      const n = list.length, pos = new Float32Array(n * 12), ab = new Float32Array(n * 12), ps = new Float32Array(n * 8), idx = [];
      const corners = [-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5];
      list.forEach(([x, y, z, ph, sz], i) => {
        for (let c = 0; c < 4; c++) { pos.set([corners[c * 2], corners[c * 2 + 1], 0], (i * 4 + c) * 3); ab.set([x, y, z], (i * 4 + c) * 3); ps.set([ph, sz], (i * 4 + c) * 2); }
        idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
      });
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setAttribute('aBase', new T.BufferAttribute(ab, 3)); g.setAttribute('aPS', new T.BufferAttribute(ps, 2));
      g.setIndex(idx);
      const mesh = new T.Mesh(g, M[kind] || mats('C')[kind]); mesh.frustumCulled = false; mesh.renderOrder = 3; mesh.raycast = () => {};
      grp.add(mesh);
    }
    for (const [name, p, r, q] of this.subs || []) {
      const v = new T.Vector3(...p).applyMatrix4(this.top());
      const g = q.build(name); g.position.copy(v); g.rotation.set(...r); grp.add(g);
    }
    return grp;
  }
}

// ======================================================================= VANGUARD (cyberpunk)
function vNeonRect(k, x0, x1, y, z0, z1, col, th = 0.07, fx = 0) {
  k.bar('glow', [x0, y, z0], [x1, y, z0], th, col, { fx }); k.bar('glow', [x0, y, z1], [x1, y, z1], th, col, { fx });
  k.bar('glow', [x0, y, z0], [x0, y, z1], th, col, { fx }); k.bar('glow', [x1, y, z0], [x1, y, z1], th, col, { fx });
}
function vRing(k, r, y, seg, col, th = 0.08, fx = 0, rot = 0) { // polygon outline matching CylinderGeometry(seg)
  for (let i = 0; i < seg; i++) { const a = rot + i / seg * TAU, b = rot + (i + 1) / seg * TAU; k.bar('glow', polar(r, a, y), polar(r, b, y), th, col, { fx }); }
}
function vAntenna(k, p, h, col = V.red) {
  k.line('lit', p, [p[0], p[1] + h, p[2]], 0.04, V.steel, 4);
  k.add('glow', box(0.16, 0.16, 0.16), col, [p[0], p[1] + h, p[2]], 0, 1, { fx: 1 + Math.random() * 0.9 });
}
function vUnderglow(k, w, d, cell = 3) { k.add('holo', plane(w, d), 0xffffff, [0, 0.07, 0], [-PI / 2, 0, 0], 1, { uv: cellUV(cell), fx: 3.3, smooth: true }); }

function V_tank() {
  const k = new Kit('V');
  vUnderglow(k, 5.6, 3.8, 3);
  for (const sz of [1, -1]) { // hover pods
    k.add('lit', prism([[-2.1, 0.35], [1.9, 0.35], [2.25, 0.62], [1.9, 0.98], [-2.0, 0.98], [-2.3, 0.62]], 0.75, 0.06), V.body2, [0, 0, sz * 1.25]);
    k.add('lit', bbox(2.8, 0.08, 0.5, 0.03), V.blue, [-0.1, 1.0, sz * 1.25]);
    k.bar('glow', [-2.0, 0.38, sz * 1.64], [1.9, 0.38, sz * 1.64], 0.09, V.cyan, { fx: 3.1 });
    k.bar('glow', [-2.0, 0.38, sz * 0.86], [1.9, 0.38, sz * 0.86], 0.06, V.cyan, { fx: 3.6 });
    for (const x of [-1.5, 0, 1.4]) k.add('lit', bbox(0.7, 0.18, 0.62, 0.05), V.trim, [x, 0.3, sz * 1.25]);
    k.add('glow', box(0.08, 0.14, 0.4), V.mag, [-2.3, 0.7, sz * 1.25]);
  }
  k.add('lit', prism([[-2.2, 0.55], [1.6, 0.55], [2.35, 0.85], [1.7, 1.32], [-1.9, 1.4], [-2.25, 1.0]], 1.9, 0.08), V.body, [0, 0, 0]);
  k.add('lit', bbox(1.3, 0.08, 1.5, 0.03), V.trim, [-1.35, 1.43, 0]);
  for (const x of [-1.75, -1.5, -1.25, -1.0]) k.add('glow', box(0.07, 0.03, 1.2), V.cyan, [x, 1.48, 0], 0, 1, { fx: 3.2 });
  for (const sz of [1, -1]) {
    k.bar('glow', [-1.9, 1.42, sz * 0.98], [1.7, 1.34, sz * 0.98], 0.06, V.cyan);
    k.bar('glow', [1.7, 1.34, sz * 0.98], [2.35, 0.86, sz * 0.98], 0.06, V.mag);
    k.add('glow', box(0.06, 0.1, 0.35), V.white, [2.18, 0.98, sz * 0.62], [0, 0, 0.6]);
  }
  const g = k.build();
  const t = new Kit('V');
  t.add('lit', prism([[-1.2, 0], [0.8, 0], [1.25, 0.3], [0.9, 0.66], [-1.0, 0.72], [-1.3, 0.35]], 1.6, 0.07), V.body, [0, 0, 0]);
  for (const sz of [1, -1]) {
    t.add('lit', bbox(1.3, 0.28, 0.06, 0.02), V.blue, [-0.2, 0.38, sz * 0.84]);
    t.bar('glow', [-1.0, 0.74, sz * 0.8], [0.9, 0.68, sz * 0.8], 0.05, V.cyan);
    t.add('lit', box(2.6, 0.12, 0.1), V.trim, [2.45, 0.38, sz * 0.14]);
  }
  t.add('lit', bbox(0.45, 0.45, 0.6, 0.06), V.trim, [1.2, 0.38, 0]);
  t.add('glow', box(2.5, 0.06, 0.06), V.cyan, [2.5, 0.38, 0], 0, 1, { fx: 3.5 });
  t.add('lit', bbox(0.32, 0.32, 0.44, 0.05), V.body2, [3.85, 0.38, 0]);
  t.add('glow', box(0.05, 0.2, 0.3), V.cyan, [4.02, 0.38, 0]);
  t.add('glow', box(0.06, 0.08, 0.3), V.mag, [1.03, 0.62, 0], [0, 0, 0.5]);
  vAntenna(t, [-0.9, 0.7, -0.55], 1.4);
  const tur = t.build('turret'); tur.position.set(-0.2, 1.4, 0); g.add(tur);
  return fin(g, 'tank', 2.3);
}
function V_raider() {
  const k = new Kit('V');
  vUnderglow(k, 4.2, 2.8, 4);
  // bike-buggy: single wide front wheel, two rear wheels, long nose
  const wheel = (x, z, r, w) => {
    k.add('lit', cyl(r, r, w, 12), V.glass, [x, r, z], [PI / 2, 0, 0]);
    k.add('lit', cyl(r * 0.55, r * 0.55, w + 0.04, 8), V.trim, [x, r, z], [PI / 2, 0, 0]);
    for (const s of [1, -1]) k.add('glow', torus(r * 0.78, 0.035, 4, 16), V.cyan, [x, r, z + s * (w / 2 + 0.02)], 0, 1, { smooth: true });
  };
  wheel(1.25, 0, 0.5, 0.6); wheel(-1.05, 0.95, 0.55, 0.45); wheel(-1.05, -0.95, 0.55, 0.45);
  k.add('lit', prism([[-1.6, 0.45], [0.9, 0.45], [1.85, 0.75], [1.6, 0.95], [-0.2, 1.05], [-1.5, 1.0]], 0.95, 0.06), V.body, [0, 0, 0]);
  k.add('lit', prism([[0.6, 0.95], [1.75, 0.82], [1.55, 1.1], [0.7, 1.15]], 0.7, 0.04), V.blue, [0, 0.02, 0]); // nose fairing
  k.add('lit', bbox(0.7, 0.18, 1.6, 0.05), V.body2, [-1.05, 1.05, 0]); // rear axle housing
  for (const s of [1, -1]) {
    k.bar('glow', [-1.5, 1.02, s * 0.5], [-0.2, 1.08, s * 0.5], 0.05, V.mag);
    k.bar('glow', [-0.2, 1.08, s * 0.5], [1.6, 0.97, s * 0.36], 0.05, V.mag);
    k.add('lit', bbox(0.9, 0.08, 0.5, 0.03), V.trim, [-1.05, 1.18, s * 0.95]);
    k.add('glow', box(0.08, 0.1, 0.18), V.white, [1.86, 0.78, s * 0.22]);
    k.add('glow', box(0.06, 0.12, 0.3), V.red, [-1.62, 0.8, s * 0.3]);
  }
  k.add('lit', prism([[-0.6, 0], [0.5, 0], [0.1, 0.5], [-0.5, 0.55]], 0.62, 0.04), V.glass, [0, 1.05, 0]); // canopy
  k.bar('glow', [-0.55, 1.6, 0.31], [0.1, 1.55, 0.31], 0.04, V.cyan); k.bar('glow', [-0.55, 1.6, -0.31], [0.1, 1.55, -0.31], 0.04, V.cyan);
  // twin MG pod over the nose
  k.add('lit', bbox(0.6, 0.22, 0.5, 0.05), V.trim, [0.45, 1.2, 0]);
  for (const s of [1, -1]) { k.add('lit', box(0.9, 0.07, 0.07), V.trim, [1.15, 1.22, s * 0.13]); k.add('glow', box(0.5, 0.03, 0.03), V.cyan, [1.3, 1.27, s * 0.13], 0, 1, { fx: 3.4 }); }
  vAntenna(k, [-1.3, 1.1, -0.4], 1.1, V.cyan);
  return fin(k.build(), 'raider', 1.9);
}
function V_harvester() {
  const k = new Kit('V');
  vUnderglow(k, 5.2, 3.6, 3);
  k.add('lit', bbox(4.0, 0.4, 1.6, 0.08), V.trim, [0, 0.75, 0]);
  for (const x of [1.35, 0.1, -1.15]) for (const s of [1, -1]) {
    k.add('lit', cyl(0.46, 0.46, 0.36, 10), V.glass, [x, 0.48, s * 1.05], [PI / 2, 0, 0]);
    k.add('glow', cyl(0.18, 0.18, 0.4, 6), V.cyan, [x, 0.48, s * 1.05], [PI / 2, 0, 0], 1, { fx: 3.2 });
  }
  for (const s of [1, -1]) k.add('lit', prism([[-1.7, 0.9], [1.8, 0.9], [1.6, 1.05], [-1.6, 1.05]], 0.4, 0.03), V.body2, [0, 0, s * 1.05]);
  k.add('lit', prism([[0.6, 0.95], [2.05, 0.95], [2.15, 1.45], [1.75, 2.2], [0.7, 2.3]], 1.8, 0.07), V.body, [0, 0, 0]);
  k.add('glow', box(0.06, 0.45, 1.5), V.cyan, [1.97, 1.83, 0], [0, 0, 0.36], 1, { fx: 3.7 });
  for (const s of [1, -1]) { k.add('glow', box(0.7, 0.22, 0.05), V.cyan, [1.25, 1.95, s * 0.95]); k.add('lit', bbox(1.3, 0.3, 0.06, 0.02), V.blue, [1.3, 1.3, s * 0.94]); }
  k.bar('glow', [0.7, 2.33, 0.92], [1.75, 2.23, 0.92], 0.05, V.mag); k.bar('glow', [0.7, 2.33, -0.92], [1.75, 2.23, -0.92], 0.05, V.mag);
  // crystal container: dark frame + translucent energy box + glowing shards
  const cx = -0.75, cy = 1.75;
  for (const sx of [1, -1]) for (const sz of [1, -1]) k.add('lit', box(0.14, 1.6, 0.14), V.body2, [cx + sx * 0.95, cy, sz * 0.9]);
  k.add('lit', bbox(2.1, 0.12, 2.0, 0.04), V.body2, [cx, cy - 0.8, 0]); k.add('lit', bbox(2.1, 0.12, 2.0, 0.04), V.body2, [cx, cy + 0.82, 0]);
  k.add('energy', box(1.8, 1.45, 1.7), V.cyan, [cx, cy, 0], 0, 1, { fx: 3.5 });
  const r = rng(5);
  for (let i = 0; i < 7; i++) k.add('glow', ico(0.35, 0), i % 3 ? V.cyan : V.white, [cx + (r() - 0.5) * 1.3, cy - 0.45 + r() * 0.6, (r() - 0.5) * 1.2], [r(), r(), r()], [0.7, 1.6, 0.7]);
  vNeonRect(k, cx - 1.02, cx + 1.02, cy + 0.9, -0.98, 0.98, V.cyan, 0.06);
  // front collector arms
  k.add('lit', prism([[2.0, 0.25], [2.7, 0.15], [2.75, 0.32], [2.25, 0.85], [2.0, 0.85]], 2.0, 0.05), V.trim, [0, 0, 0]);
  for (const s of [1, -1, 0.33, -0.33]) k.add('glow', box(0.06, 0.06, 0.2), V.mag, [2.72, 0.28, s * 0.85]);
  vAntenna(k, [0.9, 2.3, 0.6], 0.8);
  return fin(k.build(), 'harvester', 2.6);
}
function V_cc() {
  const k = new Kit('V');
  k.add('lit', cyl(8.5, 8.9, 0.4, 8), V.trim, [0, 0.2, 0], [0, PI / 8, 0]);
  vRing(k, 8.55, 0.42, 8, V.cyan, 0.1, 0, PI / 8);
  // tier 1
  k.add('lit', cyl(6.5, 7.4, 2.8, 8), V.body, [0, 1.8, 0], [0, PI / 8, 0]);
  vRing(k, 6.55, 3.22, 8, V.cyan, 0.1, 0, PI / 8);
  for (let i = 0; i < 8; i++) { const a = PI / 8 + i / 8 * TAU; k.bar('glow', polar(7.42, a, 0.42), polar(6.52, a, 3.2), 0.08, i % 2 ? V.mag : V.cyan); }
  for (let i = 0; i < 8; i++) { // blue armour panels + signs on faces
    const a = i / 8 * TAU + PI / 4, p = polar(7.0, a, 1.8);
    k.add('lit', bbox(0.12, 1.4, 2.6, 0.04), i % 2 ? V.blue : V.body2, p, [0, a - PI / 2, -0.3 * 0], 1);
  }
  // tier 2
  k.add('lit', cyl(4.8, 5.4, 3.0, 8), V.body2, [0, 4.7, 0]);
  vRing(k, 4.82, 6.22, 8, V.mag, 0.1);
  k.add('lit', cyl(5.0, 5.0, 0.25, 8), V.trim, [0, 3.32, 0]);
  // glowing core between tier 2 and 3 (pillars around a lit cylinder)
  k.add('glow', cyl(2.3, 2.3, 2.4, 8), V.cyan, [0, 7.45, 0], 0, 1, { fx: 3 });
  for (let i = 0; i < 6; i++) k.add('lit', bbox(0.7, 2.5, 0.7, 0.08), V.body, polar(2.75, i / 6 * TAU, 7.45), [0, i / 6 * TAU, 0]);
  k.add('lit', cyl(3.4, 3.6, 0.4, 8), V.trim, [0, 6.3, 0]); k.add('lit', cyl(3.3, 3.5, 0.4, 8), V.trim, [0, 8.75, 0]);
  // tier 3 faceted spire
  k.add('lit', cyl(1.4, 2.8, 3.4, 6), V.body, [0, 10.6, 0]);
  for (let i = 0; i < 6; i++) { const a = i / 6 * TAU; k.bar('glow', polar(2.8, a, 8.95), polar(1.4, a, 12.3), 0.07, V.cyan); }
  k.add('lit', cyl(0.5, 1.2, 2.2, 6), V.body2, [0, 13.4, 0]);
  k.add('glow', cone(0.3, 1.2, 6), V.mag, [0, 15.0, 0], 0, 1, { fx: 3.5 });
  // rotating holo rings + glyph band
  k.add('glow', torus(5.6, 0.07, 4, 48), V.cyan, [0, 9.4, 0], [PI / 2, 0, 0], 1, { fx: 4.0, smooth: true });
  k.add('glow', torus(4.6, 0.06, 4, 40), V.mag, [0, 10.6, 0], [PI / 2 + 0.18, 0, 0.1], 1, { fx: 5.0, smooth: true });
  k.add('holo', cyl(5.2, 5.2, 1.0, 32, true), 0xffffff, [0, 9.95, 0], 0, 1, { uv: cellUV(5), fx: 4.3, smooth: true });
  // antenna array
  for (const [x, z, h] of [[0.6, 0.5, 2.6], [-0.7, 0.4, 1.8], [0.2, -0.8, 2.2]]) vAntenna(k, [x, 12.6, z], h, x > 0 ? V.red : V.cyan);
  for (let i = 0; i < 4; i++) vAntenna(k, polar(4.3, i / 4 * TAU + 0.4, 6.2), 1.6 + (i % 2) * 0.8, i % 2 ? V.cyan : V.red);
  // landing pads on tier-1 roof (front-left & back-right)
  for (const a of [PI * 0.25 + PI / 8 * 0, PI * 1.25]) {
    const p = polar(5.7, a, 3.45);
    k.add('lit', cyl(1.9, 2.0, 0.25, 8), V.trim, p, [0, PI / 8, 0]);
    k.add('holo', plane(3.4, 3.4), 0xffffff, [p[0], 3.62, p[2]], [-PI / 2, 0, 0], 1, { uv: cellUV(6), fx: 3.2, smooth: true });
  }
  // holo signs on tier-1 faces
  for (const [a, cell] of [[PI / 2 + 0.6, 0], [PI / 2 - 0.65, 1], [PI + 0.2, 2], [-0.2, 0]]) {
    const p = polar(7.25, a, 2.0); k.sign(p, a, 2.0, 2.4, cell, 2, 0xffffff, -0.25);
  }
  // dark jacquard hanging banners with neon trim on tier 2
  for (const a of [PI / 2 + 0.55, PI / 2 - 0.55, -PI / 2]) {
    const p = polar(5.25, a, 4.5);
    k.add('jacq', cloth(1.3, 2.8, 0.03, 0.05), 0x30364c, p, [0, a, 0], 1, { smooth: true });
    const tx = Math.cos(a) * 0.68, tz = -Math.sin(a) * 0.68, n = polar(0.05, a);
    for (const sd of [1, -1]) k.bar('glow', [p[0] + tx * sd + n[0], 3.1, p[2] + tz * sd + n[2]], [p[0] + tx * sd + n[0], 5.9, p[2] + tz * sd + n[2]], 0.05, sd > 0 ? V.cyan : V.mag);
    k.bar('glow', [p[0] - tx + n[0], 5.92, p[2] - tz + n[2]], [p[0] + tx + n[0], 5.92, p[2] + tz + n[2]], 0.08, V.cyan);
    k.sign([p[0] + n[0] * 2, 4.6, p[2] + n[2] * 2], a, 0.8, 0.8, 5, 3);
  }
  // main door on +X face
  k.add('lit', bbox(1.2, 2.2, 3.2, 0.08), V.trim, [7.2, 1.3, 0]);
  k.add('glow', box(0.1, 1.7, 2.4), V.glass, [7.82, 1.15, 0]);
  vNeonRect(k, 7.84, 7.84, 2.3, -1.4, 1.4, V.cyan, 0.08);
  k.bar('glow', [7.84, 0.4, 1.4], [7.84, 2.3, 1.4], 0.08, V.cyan); k.bar('glow', [7.84, 0.4, -1.4], [7.84, 2.3, -1.4], 0.08, V.cyan);
  return fin(k.build(), 'cc', 13);
}
function V_barracks() {
  const k = new Kit('V');
  k.add('lit', bbox(9.2, 0.3, 7.4, 0.08), V.trim, [0, 0.15, 0]);
  vNeonRect(k, -4.6, 4.6, 0.32, -3.7, 3.7, V.cyan, 0.07);
  k.add('lit', prism([[-3.8, 0], [3.8, 0], [3.5, 3.4], [-3.6, 3.6]], 5.6, 0.1), V.body, [0, 0.3, 0]);
  // faceted roof
  k.add('lit', prism([[-3.1, 0], [3.1, 0], [1.4, 1.5], [-1.0, 1.7]], 7.8, 0.08), V.body2, [0, 3.85, 0], [0, PI / 2, 0]);
  k.add('lit', bbox(7.8, 0.12, 2.6, 0.04), V.blue, [0, 4.38, 1.85], [0.73, 0, 0]);
  for (const s of [1, -1]) {
    k.bar('glow', [-3.9, 3.95, s * 3.1], [3.9, 3.95, s * 3.1], 0.08, V.cyan);
    k.add('glow', box(5.0, 0.28, 0.05), V.cyan, [-0.6, 2.2, s * 2.82], 0, 1, { fx: 3.3 });
    k.line('lit', [-3.7, 0.7, s * 2.95], [3.4, 0.7, s * 2.95], 0.12, V.trim, 6);
    k.line('lit', [-3.7, 0.95, s * 2.95], [3.4, 0.95, s * 2.95], 0.08, V.steel, 6);
  }
  k.bar('glow', [-3.9, 5.55, 0.3], [3.9, 5.55, 0.3], 0.08, V.mag);
  // door
  k.add('lit', bbox(0.5, 2.8, 3.2, 0.06), V.trim, [3.8, 1.7, 0]);
  k.add('glow', box(0.06, 2.2, 2.4), 0x0c1830, [4.07, 1.45, 0]);
  vNeonRect(k, 4.1, 4.1, 2.62, -1.3, 1.3, V.cyan, 0.08);
  k.bar('glow', [4.1, 0.35, 1.3], [4.1, 2.62, 1.3], 0.08, V.cyan); k.bar('glow', [4.1, 0.35, -1.3], [4.1, 2.62, -1.3], 0.08, V.cyan);
  for (let i = 0; i < 5; i++) k.add('glow', box(0.04, 0.04, 2.2), V.cyan, [4.12, 0.6 + i * 0.4, 0], 0, 1, { fx: 3 + i * 0.15 });
  // holo signs
  k.sign([0.8, 2.4, 3.05], 0, 2.2, 1.4, 2, 2);
  k.sign([-3.0, 4.2, -3.2], PI, 1.2, 2.0, 1, 2);
  k.sign([3.9, 4.3, 0], PI / 2, 1.0, 1.6, 0, 2);
  k.sign([-0.6, 6.0, 0.4], 0, 3.4, 1.2, 5, 2, 0xffffff, -0.8);
  vAntenna(k, [-2.6, 5.2, 0.6], 2.4); vAntenna(k, [-3.2, 4.8, -0.9], 1.6, V.cyan);
  k.add('lit', bbox(1.2, 0.6, 1.0, 0.06), V.trim, [1.6, 5.35, 0.2]); k.add('glow', cyl(0.35, 0.35, 0.05, 8), V.cyan, [1.6, 5.68, 0.2], 0, 1, { fx: 3.1 });
  return fin(k.build(), 'barracks', 5.8);
}
function V_factory() {
  const k = new Kit('V');
  k.add('lit', bbox(11, 0.3, 8.4, 0.08), V.trim, [0.3, 0.15, 0]);
  vNeonRect(k, -5.2, 5.8, 0.32, -4.2, 4.2, V.cyan, 0.07);
  k.add('lit', bbox(5.6, 4.6, 7.2, 0.12), V.body, [-2.3, 2.6, 0]);
  for (const s of [1, -1]) k.add('lit', bbox(4.2, 4.6, 0.8, 0.1), V.body2, [2.6, 2.6, s * 3.2]);
  k.add('lit', bbox(4.6, 0.5, 7.4, 0.08), V.body, [2.6, 5.15, 0]);
  k.add('lit', bbox(4.0, 0.08, 5.6, 0.03), V.trim, [2.6, 0.34, 0]);
  k.add('holo', plane(3.6, 1.0), 0xffffff, [4.2, 0.4, 0], [-PI / 2, 0, PI / 2], 1, { uv: cellUV(7), fx: 0.0, smooth: true });
  k.add('glow', box(0.1, 0.25, 5.2), V.mag, [0.56, 4.3, 0], 0, 1, { fx: 3 });
  for (const z of [-1.8, 0, 1.8]) k.add('glow', box(0.1, 1.6, 0.08), V.cyan, [0.56, 2.2, z]);
  for (const s of [1, -1]) { k.bar('glow', [4.75, 0.35, s * 2.78], [4.75, 5.4, s * 2.78], 0.09, V.cyan); }
  k.bar('glow', [4.85, 5.42, -3.6], [4.85, 5.42, 3.6], 0.09, V.mag);
  // faceted sawtooth roof with glowing skylights
  for (let i = 0; i < 3; i++) {
    const x0 = -5.0 + i * 1.85;
    k.add('lit', prism([[0, 0], [1.85, 0], [1.85, 1.25]], 7.0, 0.04), V.body2, [x0, 4.9, 0]);
    k.add('glow', box(0.05, 0.9, 6.4), i === 1 ? V.mag : V.cyan, [x0 + 1.9, 5.5, 0], 0, 1, { fx: 3 + i * 0.3 });
  }
  k.add('lit', bbox(5.7, 0.5, 7.3, 0.06), V.blue, [-2.3, 3.9, 0]);
  // cooling towers
  for (const z of [2.3, -2.3]) {
    k.add('lit', cyl(0.6, 0.85, 3.0, 8), V.trim, [-4.3, 6.4, z]);
    k.add('glow', cyl(0.62, 0.62, 0.12, 8), V.cyan, [-4.3, 7.95, z], 0, 1, { fx: 3.2 });
    k.add('glow', cyl(0.64, 0.64, 0.08, 8), V.cyan, [-4.3, 6.8, z], 0, 1, { fx: 3.6 });
  }
  // crane gantry in front of the bay
  for (const s of [1, -1]) { k.add('lit', bbox(0.45, 6.6, 0.45, 0.06), V.body2, [5.3, 3.6, s * 3.7]); k.bar('glow', [5.55, 0.4, s * 3.7], [5.55, 6.8, s * 3.7], 0.06, V.cyan); }
  k.add('lit', bbox(0.6, 0.55, 8.0, 0.06), V.trim, [5.3, 7.0, 0]);
  k.bar('glow', [5.0, 6.7, -3.9], [5.0, 6.7, 3.9], 0.06, V.mag);
  k.add('lit', bbox(0.8, 0.4, 0.8, 0.05), V.body, [5.3, 6.55, 1.0]);
  k.line('lit', [5.3, 6.4, 1.0], [5.3, 3.4, 1.0], 0.03, V.steel, 4);
  k.add('lit', bbox(1.4, 1.0, 1.4, 0.08), V.blue, [5.3, 2.9, 1.0], [0, 0.3, 0]);
  k.sign([-2.4, 3.0, 3.66], 0, 2.6, 1.4, 2, 2);
  for (const x of [-4.8, -0.6]) k.bar('lit', [x, 6.15, 0], [x, 7.2, 0], 0.12, V.trim);
  k.sign([-2.7, 7.6, 0], 0, 4.6, 1.5, 2, 2, 0xffffff, -0.75);
  vNeonRect(k, -5.2, 0.6, 4.92, -3.65, 3.65, V.cyan, 0.08);
  k.sign([-5.15, 2.6, 0], -PI / 2, 1.4, 2.4, 0, 2);
  vAntenna(k, [-1.0, 6.3, -2.6], 2.0);
  return fin(k.build(), 'factory', 7.4);
}
function vTurretBase(k, h, r0, r1) {
  k.add('lit', cyl(1.55, 1.7, 0.3, 8), V.trim, [0, 0.15, 0], [0, PI / 8, 0]);
  vRing(k, 1.58, 0.32, 8, V.cyan, 0.06, 0, PI / 8);
  k.add('lit', cyl(r1, r0, h, 8), V.body, [0, 0.3 + h / 2, 0], [0, PI / 8, 0]);
  for (let i = 0; i < 4; i++) { const a = PI / 8 + i / 4 * TAU; k.bar('glow', polar(r0 + 0.02, a, 0.32), polar(r1 + 0.02, a, 0.3 + h), 0.06, i % 2 ? V.mag : V.cyan, { fx: 3 + i * 0.2 }); }
}
function V_turret_mg() {
  const k = new Kit('V'); vTurretBase(k, 0.75, 1.3, 1.05);
  const g = k.build();
  const t = new Kit('V');
  t.add('lit', cyl(0.8, 0.9, 0.2, 8), V.trim, [0, 0.1, 0]);
  t.add('lit', sph(0.85, 8, 5), V.body, [0, 0.55, 0], 0, [1.15, 0.7, 0.95]);
  t.add('lit', bbox(1.0, 0.3, 0.06, 0.02), V.blue, [-0.1, 0.6, 0.82]); t.add('lit', bbox(1.0, 0.3, 0.06, 0.02), V.blue, [-0.1, 0.6, -0.82]);
  for (const s of [1, -1]) {
    t.add('lit', cyl(0.11, 0.11, 0.5, 8), V.trim, [0.95, 0.5, s * 0.22], [0, 0, -PI / 2]);
    t.add('lit', box(1.2, 0.08, 0.08), V.body2, [1.6, 0.5, s * 0.22]);
    t.add('glow', box(1.1, 0.04, 0.04), V.cyan, [1.62, 0.56, s * 0.22], 0, 1, { fx: 3.4 });
  }
  t.add('glow', box(0.05, 0.12, 0.5), V.mag, [0.95, 0.78, 0], [0, 0, 0.5]);
  const tur = t.build('turret'); tur.position.y = 1.05; g.add(tur);
  return fin(g, 'turret_mg', 2.0);
}
function V_turret_cannon() {
  const k = new Kit('V'); vTurretBase(k, 2.0, 1.3, 0.85);
  k.add('lit', cyl(0.95, 0.95, 0.15, 8), V.trim, [0, 2.35, 0]);
  k.sign([0.0, 1.4, 1.2], 0.35, 0.8, 1.2, 0, 2);
  const g = k.build();
  const t = new Kit('V');
  t.add('lit', prism([[-1.0, 0], [0.75, 0], [1.2, 0.35], [0.8, 0.85], [-0.85, 0.9], [-1.15, 0.45]], 1.5, 0.07), V.body, [0, 0, 0]);
  for (const s of [1, -1]) { t.add('lit', bbox(1.2, 0.3, 0.06, 0.02), V.blue, [-0.1, 0.45, s * 0.78]); t.bar('glow', [-0.85, 0.92, s * 0.72], [0.8, 0.87, s * 0.72], 0.05, V.cyan); }
  t.add('lit', bbox(0.4, 0.5, 0.6, 0.06), V.trim, [1.1, 0.45, 0]);
  t.add('lit', cyl(0.13, 0.15, 2.6, 8), V.body2, [2.45, 0.45, 0], [0, 0, -PI / 2]);
  for (let i = 0; i < 4; i++) t.add('glow', cyl(0.17, 0.17, 0.08, 8), V.cyan, [1.7 + i * 0.5, 0.45, 0], [0, 0, -PI / 2], 1, { fx: 3 + i * 0.25 });
  t.add('lit', bbox(0.4, 0.28, 0.34, 0.05), V.trim, [3.85, 0.45, 0]);
  t.add('glow', box(0.05, 0.2, 0.24), V.cyan, [4.06, 0.45, 0]);
  t.add('glow', box(0.06, 0.1, 0.4), V.mag, [1.0, 0.7, 0], [0, 0, 0.5]);
  vAntenna(t, [-0.8, 0.9, 0.45], 1.0);
  const tur = t.build('turret'); tur.position.y = 2.45; g.add(tur);
  return fin(g, 'turret_cannon', 3.6);
}
function V_artillery() {
  const k = new Kit('V');
  k.add('lit', bbox(4.2, 0.35, 4.2, 0.1), V.trim, [0, 0.175, 0]);
  vNeonRect(k, -2.05, 2.05, 0.37, -2.05, 2.05, V.cyan, 0.07);
  k.add('lit', cyl(1.75, 2.35, 0.6, 4), V.body, [0, 0.65, 0], [0, PI / 4, 0]);
  for (const [x, z] of [[1.6, 1.6], [-1.6, 1.6], [1.6, -1.6], [-1.6, -1.6]]) k.add('glow', box(0.2, 0.12, 0.2), V.mag, [x, 0.45, z], 0, 1, { fx: 1 + Math.random() });
  const g = k.build();
  const t = new Kit('V');
  t.add('lit', cyl(1.3, 1.4, 0.3, 8), V.trim, [0, 0.15, 0]);
  vRing(t, 1.32, 0.31, 8, V.cyan, 0.05);
  for (const s of [1, -1]) { t.add('lit', bbox(1.8, 1.2, 0.22, 0.05), V.body, [0.1, 0.9, s * 0.62]); t.add('lit', bbox(1.2, 0.3, 0.05, 0.02), V.blue, [0.0, 0.95, s * 0.74]); }
  t.add('lit', prism([[-1.3, 0.3], [0.2, 0.3], [0.4, 0.9], [-1.0, 1.2], [-1.35, 0.8]], 1.0, 0.05), V.body2, [0, 0, 0]);
  t.push([0.3, 1.05, 0], [0, 0, 0.6]);
  t.add('lit', bbox(0.9, 0.6, 0.6, 0.06), V.trim, [-0.1, 0, 0]);
  t.add('lit', cyl(0.2, 0.24, 3.8, 8), V.body, [1.9, 0, 0], [0, 0, -PI / 2]);
  for (let i = 0; i < 5; i++) t.add('glow', cyl(0.27, 0.27, 0.09, 8), i % 2 ? V.mag : V.cyan, [0.9 + i * 0.6, 0, 0], [0, 0, -PI / 2], 1, { fx: 3 + i * 0.18 });
  t.add('lit', bbox(0.45, 0.38, 0.42, 0.05), V.trim, [3.9, 0, 0]);
  t.add('glow', box(0.05, 0.24, 0.28), V.cyan, [4.13, 0, 0]);
  t.pop();
  vAntenna(t, [-1.1, 1.2, -0.3], 1.2);
  const tur = t.build('turret'); tur.position.y = 0.95; g.add(tur);
  return fin(g, 'artillery', 3.0);
}
function V_wall() {
  const k = new Kit('V');
  k.add('lit', prism([[-0.75, 0], [0.75, 0], [0.55, 1.75], [-0.55, 1.75]], 3.96, 0.05), V.body, [0, 0, 0], [0, PI / 2, 0]);
  k.add('lit', bbox(4.0, 0.22, 1.4, 0.06), V.trim, [0, 1.88, 0]);
  k.add('glow', box(3.9, 0.08, 0.16), V.cyan, [0, 2.02, 0], 0, 1, { fx: 3.4 });
  for (const s of [1, -1]) {
    k.add('lit', bbox(3.0, 0.32, 0.08, 0.02), V.blue, [0, 1.0, s * 0.66], [s * 0.11, 0, 0]);
    k.bar('glow', [-1.9, 1.86, s * 0.71], [1.9, 1.86, s * 0.71], 0.05, V.cyan);
    for (const x of [-1.2, 0, 1.2]) k.add('glow', box(0.3, 0.05, 0.05), V.mag, [x, 0.5, s * 0.72]);
  }
  return fin(k.build(), 'wall', 2.1);
}
function V_gate() {
  const k = new Kit('V');
  k.add('lit', bbox(1.8, 0.25, 6.0, 0.06), V.trim, [0, 0.125, 0]);
  for (const s of [1, -1]) {
    k.add('lit', cyl(0.55, 0.9, 4.8, 4), V.body, [0, 2.65, s * 2.2], [0, PI / 4, 0]);
    k.add('lit', cone(0.6, 0.9, 4), V.body2, [0, 5.5, s * 2.2], [0, PI / 4, 0]);
    k.add('lit', bbox(0.2, 1.2, 0.9, 0.03), V.blue, [0.55, 3.5, s * 2.2]);
    for (const [dx, dz] of [[0.9, 0], [-0.9, 0], [0, 0.9], [0, -0.9]]) k.bar('glow', [dx, 0.3, s * 2.2 + dz], [dx * 0.6, 5.0, s * 2.2 + dz * 0.6], 0.05, V.cyan);
    k.add('glow', box(0.25, 3.6, 0.15), V.cyan, [0, 2.2, s * 1.5], 0, 1, { fx: 3.2 });
    k.add('glow', box(0.2, 0.2, 0.2), V.red, [0, 6.0, s * 2.2], 0, 1, { fx: 1.2 });
  }
  k.add('energy', box(0.25, 3.8, 2.9), V.cyan, [0, 2.2, 0], 0, 1, { fx: 3.1 });
  k.add('energy', box(0.08, 3.8, 2.9), V.mag, [0.3, 2.2, 0], 0, 1, { fx: 3.6 });
  return fin(k.build(), 'gate', 5.5);
}

// ======================================================================= CRIMSON (Mad Max scrap)
const pick = (r, a) => a[(r() * a.length) | 0];
function cTire(k, p, r = 0.5, upright = false, ry = 0) {
  k.add('solid', torus(r * 0.7, r * 0.32, 5, 10), C.tire, p, upright ? [0, ry, 0] : [PI / 2, 0, ry]);
}
function cDrum(k, p, col = C.red, burning = false, tilt = 0) {
  k.add('solid', cyl(0.34, 0.34, 0.9, 10), col, [p[0], p[1] + 0.45, p[2]], [tilt, 0, 0]);
  for (const y of [0.2, 0.7]) k.add('solid', cyl(0.36, 0.36, 0.06, 10), C.soot, [p[0], p[1] + y, p[2]], [tilt, 0, 0]);
  if (burning) { k.flame([p[0], p[1] + 0.9, p[2]], 1.1, 0.3); k.smoke([p[0], p[1] + 1.3, p[2]], 3, 0.7); }
}
function cSpike(k, base, dir, len = 0.8, r = 0.09, col = C.bone) { k.spike('solid', base, dir, len, r, col); }
function cSkull(k, p, s = 1, ry = 0) { // abstract horned skull totem head
  k.push(p, [0, ry, 0], s);
  k.add('solid', ico(0.42, 1), C.bone, [0, 0, 0], 0, [0.9, 1, 1]);
  k.add('solid', bbox(0.42, 0.25, 0.5, 0.05), C.bone, [0.12, -0.32, 0]);
  for (const z of [0.15, -0.15]) k.add('solid', box(0.1, 0.13, 0.13), C.soot, [0.36, 0.04, z]);
  for (const z of [1, -1]) { k.spike('solid', [0, 0.2, z * 0.3], [0.2, 0.6, z * 0.9], 0.8, 0.12, C.bone); k.spike('solid', [0.05, 0.55, z * 0.85], [0.4, 1, z * 0.1], 0.5, 0.07, C.bone); }
  k.pop();
}
function cBanner(k, p, h = 5, w = 1.1, col = C.red, ry = 0) { // pole + red jacquard war banner
  k.line('solid', p, [p[0], p[1] + h, p[2]], 0.08, C.soot, 5);
  k.push(p, [0, ry, 0]);
  k.bar('solid', [0, h - 0.1, 0], [0, h - 0.1, w + 0.1], 0.08, C.soot);
  k.add('jacq', cloth(w, h * 0.45, 0.05, 0.08), col, [0, h - 0.15 - h * 0.225, w / 2 + 0.05], [0, PI / 2, 0], 1, { smooth: true });
  k.spike('solid', [0, h, 0], [0, 1, 0], 0.5, 0.08, C.bone);
  k.pop();
}
function cTarp(k, p, ry, w, d, h, col = 0x9c9a8c) { // denim tarp on 4 poles
  k.push(p, [0, ry, 0]);
  for (const sx of [1, -1]) for (const sz of [1, -1]) k.line('solid', [sx * w / 2, 0, sz * d / 2], [sx * w / 2, h + (sx > 0 ? 0.3 : 0), sz * d / 2], 0.06, C.steel2, 5);
  k.push([0, h + 0.15, 0], [0, 0, -0.08]); k.add('denim', cloth(w + 0.2, d + 0.2, 0.35, 0.04), col, [0, 0, 0], [-PI / 2, 0, 0], 1, { smooth: true }); k.pop();
  k.pop();
}
function cAwning(k, p, ry, tilt, w, d, col = 0x9c9a8c) { k.push(p, [0, ry, tilt]); k.add('denim', cloth(w, d, 0.25, 0.03), col, [0, 0, 0], [-PI / 2, 0, 0], 1, { smooth: true }); k.pop(); }
function cTotem(k, p, h = 3) { k.line('solid', p, [p[0], p[1] + h, p[2]], 0.09, C.soot, 5); k.bar('solid', [p[0], p[1] + h * 0.7, p[2] - 0.5], [p[0], p[1] + h * 0.7, p[2] + 0.5], 0.08, C.rust2); cSkull(k, [p[0], p[1] + h + 0.2, p[2]], 1);
  k.add('jacq', cloth(0.6, 1.0, 0.02, 0.06), C.red, [p[0], p[1] + h * 0.7 - 0.55, p[2] + 0.3], [0, 0.2, 0], 1, { smooth: true }); }
function cContainer(k, p, ry, L, col, s = 1) {
  k.push(p, [0, ry, 0], s);
  k.add('scrap', box(L, 2.3, 2.3), col, [0, 1.2, 0]);
  for (const x of [-L / 2, L / 2]) for (const z of [-1.15, 1.15]) k.add('solid', box(0.14, 2.42, 0.14), C.soot, [x, 1.2, z]);
  for (const z of [-1.15, 1.15]) { k.add('solid', box(L, 0.12, 0.12), C.soot, [0, 2.36, z]); k.add('solid', box(L, 0.12, 0.12), C.soot, [0, 0.05, z]); }
  for (const z of [-0.5, 0.5]) k.add('solid', box(0.06, 2.1, 0.06), C.steel, [L / 2 + 0.04, 1.2, z]);
  k.pop();
}
function cHulk(k, p, ry, col = C.rust, flip = false) { // wrecked car
  k.push(p, flip ? [0, ry, PI * 0.08] : [0, ry, 0]);
  k.add('scrap', bbox(3.0, 0.65, 1.5, 0.12), col, [0, 0.6, 0]);
  k.add('scrap', prism([[-0.9, 0], [0.5, 0], [0.15, 0.55], [-0.75, 0.55]], 1.3, 0.04), col, [-0.1, 0.9, 0]);
  for (const z of [0.66, -0.66]) k.add('solid', box(0.9, 0.35, 0.02), C.soot, [-0.25, 1.15, z]);
  k.add('solid', box(0.08, 0.3, 1.3), C.steel, [1.52, 0.55, 0]);
  for (const [x, z] of [[1.0, 0.75], [-1.0, -0.75], [-1.0, 0.75]]) cTire(k, [x, 0.36, z], 0.42, true);
  k.pop();
}
function cBarbed(k, a, b, r = 0.18) {
  const A = new T.Vector3(...a), B = new T.Vector3(...b), L = A.distanceTo(B), n = Math.max(2, (L / 0.16) | 0), d = B.clone().sub(A).normalize();
  const q = new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 0, 1), d);
  for (let i = 0; i < n; i++) { const p = A.clone().addScaledVector(d, (i + 0.5) * L / n); k.addM('solid', torus(r, 0.018, 3, 8), C.steel2, new T.Matrix4().compose(p, q.clone().multiply(new T.Quaternion().setFromEuler(new T.Euler(0.25, 0, i))), new T.Vector3(1, 1, 1))); }
}
function cSandbags(k, p, R, n, rows, gapA = null) {
  for (let row = 0; row < rows; row++) for (let i = 0; i < n; i++) {
    const a = (i + (row % 2) * 0.5) / n * TAU; if (gapA !== null && Math.abs(Math.atan2(Math.sin(a - gapA), Math.cos(a - gapA))) < 0.5) continue;
    k.add('solid', sph(0.5, 7, 4), (i + row) % 3 ? C.sand : 0x9c8458, polar(R, a, p[1] + 0.18 + row * 0.3).map((v, j) => v + (j === 1 ? 0 : p[j])), [0, a + PI / 2, 0], [0.9, 0.38, 0.5], { smooth: true });
  }
}
function cPlates(k, r, n, x0, x1, y0, y1, z, rz = 0, only = null) { // mismatched welded plates on a face at z (sign = facing)
  for (let i = 0; i < n; i++) {
    const w = 0.4 + r() * 0.9, h = 0.3 + r() * 0.6;
    k.add(only || (r() < 0.5 ? 'scrap' : 'solid'), box(w, h, 0.06), pick(r, [C.rust, C.rust3, C.red, C.steel, C.rust2, C.bone]), [x0 + r() * (x1 - x0), y0 + r() * (y1 - y0), z], [rz, 0, (r() - 0.5) * 0.4]);
  }
}
function cScaffold(k, p, w, h, roof = true) {
  k.push(p);
  for (const sx of [1, -1]) for (const sz of [1, -1]) k.bar('solid', [sx * w / 2, 0, sz * w / 2], [sx * w / 2 * 0.85, h, sz * w / 2 * 0.85], 0.12, C.steel2);
  for (const s of [1, -1]) { k.bar('solid', [-w / 2, 0.2, s * w / 2], [w / 2 * 0.85, h * 0.9, s * w / 2 * 0.85], 0.07, C.steel2); k.bar('solid', [s * w / 2, 0.2, -w / 2], [s * w / 2 * 0.85, h * 0.9, w / 2 * 0.85], 0.07, C.steel2); }
  k.add('scrap', box(w * 0.95, 0.12, w * 0.95), C.rust2, [0, h, 0]);
  for (const s of [1, -1]) k.add('scrap', box(w * 0.9, 0.5, 0.06), s > 0 ? C.red : C.rust, [0, h + 0.3, s * w * 0.43], [0.1 * s, 0, 0]);
  if (roof) k.add('scrap', box(w * 1.1, 0.06, w * 1.1), C.rust3, [0, h + 1.5, 0], [0.15, 0, 0.1]);
  if (roof) for (const sx of [1, -1]) k.bar('solid', [sx * w * 0.4, h, w * 0.4], [sx * w * 0.4, h + 1.5, w * 0.4], 0.06, C.steel2);
  k.pop();
}
function cTreads(k, len, z, h = 0.85, wdt = 0.75) {
  for (const s of [1, -1]) {
    k.add('solid', prism([[-len / 2 + 0.1, 0.05], [len / 2 - 0.1, 0.05], [len / 2 + 0.2, h / 2], [len / 2 - 0.05, h], [-len / 2 + 0.05, h], [-len / 2 - 0.2, h / 2]], wdt, 0.05), C.tire, [0, 0, s * z]);
    for (let x = -len / 2 + 0.05; x <= len / 2 - 0.05; x += 0.28) k.add('solid', box(0.1, 0.06, wdt + 0.06), C.steel2, [x, h + 0.02, s * z]);
    for (let i = 0; i < 5; i++) { const x = -len / 2 + 0.4 + i * (len - 0.8) / 4; k.add('solid', cyl(0.3, 0.3, 0.1, 8), C.steel, [x, 0.4, s * (z + wdt / 2 + 0.03)], [PI / 2, 0, 0]); k.add('solid', cyl(0.1, 0.1, 0.14, 6), C.rust, [x, 0.4, s * (z + wdt / 2 + 0.05)], [PI / 2, 0, 0]); }
  }
}

function C_tank() {
  const k = new Kit('C'), r = rng(101);
  cTreads(k, 4.1, 1.15);
  k.add('scrap', prism([[-2.1, 0.5], [1.6, 0.5], [2.0, 0.9], [1.7, 1.35], [-1.9, 1.4], [-2.15, 1.05]], 2.0, 0.06), C.rust, [0, 0, 0]);
  k.add('scrap', bbox(1.6, 0.1, 2.05, 0.03), C.red, [0.6, 1.4, 0], [0, 0, -0.05]);
  for (const s of [1, -1]) cPlates(k, r, 4, -1.8, 1.4, 0.75, 1.2, s * 1.02);
  // ram plow
  k.add('solid', prism([[0, 0], [0.5, 0], [1.0, 0.45], [0.6, 1.1], [0.1, 1.0]], 2.8, 0.05), C.steel, [1.85, 0.1, 0]);
  for (const z of [-1.1, -0.55, 0, 0.55, 1.1]) cSpike(k, [2.6, 0.55, z], [1, 0.2, 0], 0.7, 0.09);
  for (const z of [-0.9, 0, 0.9]) k.add('solid', box(0.06, 0.9, 0.12), C.red, [2.42, 0.6, z], [0, 0, -0.45]);
  // exhaust stacks
  for (const s of [1, -1]) {
    k.line('solid', [-1.8, 1.0, s * 0.75], [-2.0, 2.5, s * 0.75], 0.11, C.soot, 6);
    k.flame([-2.0, 2.5, s * 0.75], 0.55, 0.13);
    k.smoke([-2.0, 2.7, s * 0.75], 3, 0.6);
  }
  k.add('glow', box(0.08, 0.12, 0.2), C.amber, [1.75, 1.2, 0.7]); k.add('glow', box(0.08, 0.12, 0.2), C.amber, [1.75, 1.2, -0.7]);
  const g = k.build();
  const t = new Kit('C'), r2 = rng(103);
  t.add('solid', prism([[-1.1, 0], [0.8, 0], [1.1, 0.35], [0.8, 0.7], [-1.0, 0.72], [-1.2, 0.35]], 1.6, 0.05), C.red, [0, 0, 0]);
  for (const s of [1, -1]) cPlates(t, r2, 3, -0.8, 0.6, 0.2, 0.55, s * 0.82, 0, 'solid');
  t.add('solid', bbox(1.0, 0.5, 1.2, 0.04), C.rust, [-1.3, 0.35, 0], [0, 0.08, 0]);
  t.add('solid', cyl(0.13, 0.15, 2.6, 8), C.steel2, [2.3, 0.38, 0], [0, 0, -PI / 2]);
  t.add('solid', cyl(0.2, 0.2, 0.5, 8), C.rust, [1.4, 0.38, 0], [0, 0, -PI / 2]);
  t.add('solid', cyl(0.22, 0.18, 0.35, 8), C.soot, [3.6, 0.38, 0], [0, 0, -PI / 2]);
  for (const z of [0.5, -0.5]) cSpike(t, [0.9, 0.6, z], [0.4, 1, z], 0.7, 0.08);
  cSkull(t, [-0.2, 0.95, 0], 0.55, 0);
  t.line('solid', [-0.9, 0.7, -0.6], [-1.0, 2.0, -0.6], 0.025, C.steel2, 4);
  t.add('solid', box(0.04, 0.35, 0.5), C.red, [-1.0, 1.8, -0.35]);
  const tur = t.build('turret'); tur.position.set(-0.1, 1.4, 0); g.add(tur);
  return fin(g, 'tank', 2.3);
}
function C_raider() {
  const k = new Kit('C'), r = rng(111);
  for (const [x, z] of [[1.05, 1.0], [1.05, -1.0], [-1.05, 1.05], [-1.05, -1.05]]) {
    const rr = x < 0 ? 0.6 : 0.52;
    k.add('solid', cyl(rr, rr, 0.5, 10), C.tire, [x, rr, z], [PI / 2, 0, 0]);
    k.add('solid', cyl(rr * 0.45, rr * 0.45, 0.54, 6), C.steel, [x, rr, z], [PI / 2, 0, 0]);
    cSpike(k, [x, rr, z + Math.sign(z) * 0.27], [0, 0, Math.sign(z)], 0.4, 0.07, C.steel);
  }
  k.add('scrap', prism([[-1.5, 0.5], [1.2, 0.5], [1.6, 0.75], [1.3, 0.95], [-1.3, 1.0], [-1.6, 0.8]], 1.3, 0.05), C.rust, [0, 0, 0]);
  k.add('scrap', bbox(1.1, 0.1, 1.3, 0.03), C.red, [0.95, 0.98, 0], [0, 0, -0.25]);
  for (const s of [1, -1]) cPlates(k, r, 3, -1.3, 1.0, 0.6, 0.9, s * 0.66);
  // roll cage w/ spikes
  for (const s of [1, -1]) {
    k.line('solid', [0.5, 0.95, s * 0.6], [0.15, 1.75, s * 0.5], 0.05, C.soot); k.line('solid', [0.15, 1.75, s * 0.5], [-0.85, 1.75, s * 0.5], 0.05, C.soot);
    k.line('solid', [-0.85, 1.75, s * 0.5], [-1.0, 1.0, s * 0.6], 0.05, C.soot);
    cSpike(k, [-0.85, 1.75, s * 0.5], [-0.6, 0.8, s * 0.3], 0.6, 0.06);
  }
  k.line('solid', [0.15, 1.75, 0.5], [0.15, 1.75, -0.5], 0.05, C.soot);
  k.add('solid', bbox(0.5, 0.5, 0.55, 0.06), C.soot, [-0.1, 1.2, 0]);
  // front ram + spikes
  k.add('solid', box(0.2, 0.3, 1.8), C.steel, [1.65, 0.6, 0]);
  for (const z of [-0.7, 0, 0.7]) cSpike(k, [1.75, 0.6, z], [1, 0.1, 0], 0.7, 0.09);
  k.add('glow', box(0.08, 0.14, 0.2), C.amber, [1.62, 0.85, 0.45]); k.add('glow', box(0.08, 0.14, 0.2), C.amber, [1.62, 0.85, -0.45]);
  // pintle MG
  k.line('solid', [-0.95, 1.0, 0], [-0.95, 2.0, 0], 0.06, C.steel2);
  k.add('solid', box(0.5, 0.18, 0.16), C.soot, [-0.8, 2.0, 0]);
  k.add('solid', cyl(0.045, 0.045, 1.1, 6), C.steel2, [-0.05, 2.02, 0], [0, 0, -PI / 2]);
  k.add('scrap', box(0.06, 0.45, 0.65), C.red, [-0.45, 2.0, 0], [0, 0, 0.2]);
  // exhaust
  k.line('solid', [-1.4, 0.8, 0.45], [-1.85, 1.4, 0.45], 0.07, C.soot); k.flame([-1.85, 1.4, 0.45], 0.4, 0.09);
  k.line('solid', [-1.4, 1.95, -0.3], [-1.4, 2.6, -0.3], 0.02, C.steel2); k.add('solid', box(0.03, 0.3, 0.45), C.red, [-1.4, 2.4, -0.08]);
  return fin(k.build(), 'raider', 2.0);
}
function C_harvester() {
  const k = new Kit('C'), r = rng(121);
  k.add('solid', bbox(4.0, 0.4, 1.6, 0.06), C.steel2, [0, 0.75, 0]);
  for (const x of [1.35, 0.1, -1.15]) for (const s of [1, -1]) { cTire(k, [x, 0.5, s * 1.05], 0.62, true); k.add('solid', cyl(0.18, 0.18, 0.4, 6), C.rust, [x, 0.5, s * 1.05], [PI / 2, 0, 0]); }
  k.add('scrap', prism([[0.6, 0.95], [2.05, 0.95], [2.1, 1.5], [1.75, 2.2], [0.7, 2.25]], 1.8, 0.06), C.rust3, [0, 0, 0]);
  k.add('solid', box(0.06, 0.4, 1.4), 0x2a1a10, [1.97, 1.85, 0], [0, 0, 0.36]);
  for (const z of [-0.5, -0.25, 0, 0.25, 0.5]) k.add('solid', box(0.05, 0.45, 0.04), C.steel2, [2.0, 1.85, z], [0, 0, 0.36]);
  k.add('glow', box(0.06, 0.25, 1.2), C.amber, [1.94, 1.83, 0], [0, 0, 0.36], 1, { fx: 3.3 });
  for (const s of [1, -1]) { k.add('scrap', box(1.3, 0.3, 0.06), C.red, [1.3, 1.3, s * 0.93]); cPlates(k, r, 2, 0.8, 1.8, 1.4, 2.0, s * 0.94); }
  k.add('glow', box(0.08, 0.14, 0.2), C.amber, [2.12, 1.2, 0.65]); k.add('glow', box(0.08, 0.14, 0.2), C.amber, [2.12, 1.2, -0.65]);
  // hopper
  k.add('scrap', cyl(1.4, 0.85, 1.5, 4), C.rust, [-0.7, 1.85, 0], [0, PI / 4, 0]);
  k.add('solid', box(1.7, 0.05, 1.7), 0x2a1d14, [-0.7, 2.45, 0]);
  for (let i = 0; i < 7; i++) k.add('glow', ico(0.3, 0), i % 3 ? C.cyan : 0xbff6ff, [-0.7 + (r() - 0.5) * 1.2, 2.55 + r() * 0.2, (r() - 0.5) * 1.2], [r(), r(), r()], [0.7, 1.4, 0.7]);
  for (const s of [1, -1]) { k.add('solid', box(2.05, 0.14, 0.14), C.steel2, [-0.7, 2.62, s * 0.98]); k.add('solid', box(0.14, 0.14, 2.05), C.steel2, [-0.7 + s * 0.98, 2.62, 0]); }
  // scoop w/ teeth
  k.add('solid', prism([[2.0, 0.25], [2.7, 0.12], [2.75, 0.3], [2.25, 0.9], [2.0, 0.9]], 2.0, 0.05), C.steel, [0, 0, 0]);
  for (const z of [-0.8, -0.4, 0, 0.4, 0.8]) cSpike(k, [2.7, 0.2, z], [1, -0.2, 0], 0.4, 0.08, C.steel2);
  k.line('solid', [0.7, 2.0, 0.75], [0.6, 3.0, 0.75], 0.1, C.soot); k.smoke([0.6, 3.1, 0.75], 4, 0.7); k.flame([0.6, 3.0, 0.75], 0.35, 0.1);
  cSkull(k, [2.15, 1.2, 0], 0.45, 0);
  return fin(k.build(), 'harvester', 2.6);
}
function C_cc() {
  const k = new Kit('C'), r = rng(131);
  // brick plinth + scrap mound
  k.add('brick', cyl(7.9, 8.6, 0.8, 9), 0xc9a48c, [0, 0.4, 0]);
  k.add('solid', cyl(7.5, 7.7, 0.12, 9), C.dirt, [0, 0.82, 0]);
  for (let i = 0; i < 14; i++) { const a = r() * TAU, d = 5 + r() * 3; k.add(r() < 0.5 ? 'scrap' : 'solid', box(0.8 + r() * 1.6, 0.3 + r() * 0.5, 0.6 + r() * 1.2), pick(r, [C.rust, C.rust2, C.steel2, C.rust3]), polar(d, a, 0.85), [(r() - 0.5) * 0.6, r() * 3, (r() - 0.5) * 0.6]); }
  // crashed war-rig, nose-down, across the front
  k.push([2.2, 0, 1.6], [0, 0.35, 0]);
  k.add('scrap', bbox(4.6, 3.4, 3.6, 0.15), C.red, [2.3, 1.7, 0], [0, 0, -0.18]);
  k.add('scrap', bbox(1.6, 1.2, 3.7, 0.1), C.rust, [1.1, 3.3, 0], [0, 0, -0.18]);
  k.add('solid', box(0.2, 1.6, 3.0), C.soot, [4.6, 1.0, 0], [0, 0, -0.18]);
  for (let z = -1.3; z <= 1.31; z += 0.26) k.add('solid', box(0.12, 1.7, 0.08), C.steel, [4.72, 1.0, z], [0, 0, -0.18]);
  k.add('solid', box(0.4, 0.5, 3.9), C.steel, [4.8, 0.3, 0]);
  for (const z of [-1.5, -0.75, 0, 0.75, 1.5]) cSpike(k, [4.95, 0.35, z], [1, 0.15, 0], 1.0, 0.12);
  for (const z of [1.3, -1.3]) k.add('glow', box(0.14, 0.3, 0.4), C.amber, [4.65, 2.0, z], [0, 0, -0.18], 1, { fx: 3.5 });
  k.add('solid', box(0.1, 1.0, 2.6), 0x241510, [3.45, 2.75, 0], [0, 0, -0.55]);
  for (const zz of [1, -1]) { cTire(k, [3.4, 0.95, zz * 1.95], 1.15, true); cTire(k, [0.9, 1.3, zz * 1.95], 1.15, true); k.add('solid', cyl(0.3, 0.3, 0.5, 8), C.steel, [3.4, 0.95, zz * 1.95], [PI / 2, 0, 0]); }
  k.add('solid', bbox(1.0, 2.6, 3.4, 0.08), C.soot, [0.0, 2.0, 0], [0, 0, -0.1]);
  for (const zz of [1.2, -1.2]) k.line('solid', [0.2, 3.2, zz], [0.0, 4.6, zz], 0.12, C.steel, 6);
  for (const s of [1, -1]) { k.line('solid', [0.6, 3.0, s * 1.5], [0.4, 6.0, s * 1.5], 0.2, C.soot, 8); k.flame([0.4, 6.0, s * 1.5], 1.6, 0.35); k.smoke([0.4, 6.4, s * 1.5], 5, 1.4); }
  k.pop();
  // trailer half-buried behind, denim tarp lashed over it
  cContainer(k, [-1.2, 0.0, 2.6], 0.35 + PI, 6.5, C.rust, 1);
  k.add('denim', cloth(4.2, 2.8, 0.4, 0.05), 0xa09a88, [-1.6, 2.55, 2.75], [PI / 2, 0, -0.35], [1, 1, 1], { smooth: true });
  // scrap tower: stacked containers + scaffold watchtower + totem
  k.add('brick', bbox(5.4, 1.6, 4.0, 0.06), 0xc49a84, [-3.0, 1.6, -2.2], [0, 0.2, 0]);
  k.add('brick', bbox(1.4, 0.7, 1.2, 0.05), 0xb88a74, [-0.9, 1.15, -3.6], [0, 0.6, 0.1]);
  cContainer(k, [-3.0, 2.4, -2.2], 0.2, 5.0, C.rust2);
  cContainer(k, [-3.2, 4.8, -2.4], -0.35, 4.2, C.red);
  cContainer(k, [-3.0, 7.2, -2.1], 0.6, 3.4, C.bone, 0.95);
  cScaffold(k, [-3.0, 9.4, -2.1], 2.4, 2.4);
  k.flame([-2.0, 11.9, -1.2], 1.4, 0.3); k.smoke([-2.0, 12.4, -1.2], 4, 1.2);
  cTotem(k, [-4.0, 11.8, -3.0], 2.4);
  cPlates(k, r, 6, -5, -1, 3, 8, -3.6);
  // flame jets on the trailer roof (pipes)
  for (const p of [[-0.2, 2.6, 4.0], [-2.6, 2.6, 2.3]]) { k.line('solid', [p[0], 1.6, p[2]], p, 0.16, C.steel2, 6); k.flame(p, 1.2, 0.26); }
  // tire walls + drums + spikes ring
  for (let i = 0; i < 18; i++) { const a = i / 18 * TAU + 0.1; if (Math.cos(a) > 0.6 && Math.abs(Math.sin(a)) < 0.6) continue; for (let h = 0; h < 2 + (i % 2); h++) cTire(k, polar(7.6, a, 1.0 + h * 0.32), 0.62); }
  for (let i = 0; i < 12; i++) { const a = i / 12 * TAU + 0.25, b = polar(8.1, a, 0.5); cSpike(k, b, [Math.sin(a), 0.6, Math.cos(a)], 1.3, 0.12); }
  cDrum(k, [5.5, 0.85, -3.6], C.red, true); cDrum(k, [6.1, 0.85, -2.9], C.rust); cDrum(k, [-6.0, 0.85, 2.2], C.rust3, true);
  // red jacquard war banners
  for (const [p, ry] of [[[3.5, 0.85, -5.5], 0.4], [[-5.5, 0.85, 3.8], -0.3], [[0.5, 0.85, -6.6], 0], [[6.4, 0.85, 3.0], 1.2]]) cBanner(k, p, 6, 1.3, C.red, ry);
  cBarbed(k, [-6.8, 1.6, 3.6], [-3.5, 1.6, 6.8]);
  return fin(k.build(), 'cc', 13);
}
function C_barracks() {
  const k = new Kit('C'), r = rng(141);
  k.add('solid', bbox(9.0, 0.25, 7.2, 0.06), C.dirt, [0, 0.12, 0]);
  cContainer(k, [-0.6, 0.25, -1.55], 0, 7.0, C.rust);
  cContainer(k, [-0.6, 0.25, 1.15], 0, 7.0, C.red);
  cContainer(k, [-1.2, 2.65, -0.2], 0.12, 5.2, C.rust2);
  // denim awning over the door side
  cAwning(k, [3.65, 2.95, -0.2], 0, -0.35, 2.3, 6.8);
  k.add('brick', bbox(0.5, 1.8, 5.6, 0.05), 0xc49a84, [-4.25, 1.15, -0.2]);
  for (const z of [-3.2, 2.8]) k.bar('solid', [4.4, 0.25, z], [4.4, 2.75, z], 0.14, C.steel2);
  k.add('solid', box(0.15, 2.0, 1.6), 0x1e1612, [2.95, 1.25, 0.1]);
  for (let i = 0; i < 4; i++) k.add('solid', box(0.06, 0.08, 1.6), C.steel, [3.02, 0.6 + i * 0.45, 0.1]);
  k.add('glow', box(0.1, 0.12, 1.2), C.amber, [3.02, 2.38, 0.1], 0, 1, { fx: 3.4 });
  // war paint stripes + plates
  for (const s of [1, -1]) cPlates(k, r, 5, -3.8, 2.5, 0.6, 2.2, s * (s > 0 ? 2.32 : 2.72));
  k.add('solid', box(0.06, 0.5, 6.4), C.bone, [-4.52, 1.75, -0.2]);
  cBanner(k, [4.6, 0.25, -3.4], 4.6, 1.0, C.red, -0.3); cBanner(k, [4.6, 0.25, 3.2], 4.6, 1.0, 0x8c1c1a, 0.3);
  cSkull(k, [3.05, 3.4, 0.1], 0.8, 0);
  // stack w/ fire, burning barrel, tires
  k.line('solid', [-3.4, 4.9, 1.0], [-3.5, 7.0, 1.0], 0.22, C.soot, 8); k.flame([-3.5, 7.0, 1.0], 1.0, 0.25); k.smoke([-3.5, 7.4, 1.0], 4, 1.0);
  cDrum(k, [4.0, 0.25, 2.6], C.rust, true);
  for (let h = 0; h < 3; h++) cTire(k, [-3.9, 0.45 + h * 0.32, -3.0], 0.6);
  cScaffold(k, [1.5, 4.95, -0.2], 1.8, 1.0, false);
  for (const z of [-3.0, 2.8]) cSpike(k, [-4.2, 5.0, z], [-0.5, 1, Math.sign(z) * 0.5], 1.0, 0.1);
  cBarbed(k, [-3.8, 5.15, 2.3], [2.4, 5.15, 2.3], 0.15);
  return fin(k.build(), 'barracks', 5.6);
}
function C_factory() {
  const k = new Kit('C'), r = rng(151);
  k.add('solid', bbox(11, 0.25, 8.4, 0.06), C.dirt, [0.3, 0.12, 0]);
  // corrugated shed (back block) + open bay walls
  k.add('scrap', box(5.6, 4.4, 7.2), C.rust, [-2.3, 2.45, 0]);
  k.add('brick', bbox(5.8, 1.6, 7.4, 0.05), 0xc49a84, [-2.3, 1.05, 0]);
  k.add('brick', bbox(2.0, 1.0, 0.3, 0.04), 0xb88a74, [-3.6, 2.3, 3.62]);
  for (const s of [1, -1]) k.add('scrap', box(4.2, 4.0, 0.3), s > 0 ? C.red : C.rust2, [2.6, 2.25, s * 3.4], [0, 0, s * 0.02]);
  k.add('scrap', box(4.8, 0.1, 7.6), C.rust3, [2.7, 4.5, 0], [0, 0, -0.12]);
  cAwning(k, [5.55, 4.0, 0], 0, -0.5, 1.9, 7.4);
  cBanner(k, [-5.3, 0.25, 3.6], 6.5, 1.3, C.red, PI);
  k.add('scrap', box(6.0, 0.1, 4.0), C.rust2, [-2.3, 5.0, 1.8], [0.25, 0, 0]);
  k.add('scrap', box(6.0, 0.1, 4.0), C.rust, [-2.3, 5.0, -1.8], [-0.25, 0, 0]);
  k.add('solid', box(0.2, 3.8, 6.4), 0x1e1612, [0.52, 2.2, 0]);
  k.add('glow', box(0.12, 0.2, 5.0), C.amber, [0.66, 3.9, 0], 0, 1, { fx: 3.2 });
  cPlates(k, r, 6, -4.8, 0.2, 1.9, 4.0, 3.62); cPlates(k, r, 5, -4.8, 0.2, 1.9, 4.0, -3.62);
  k.add('scrap', box(0.06, 0.8, 7.0), C.red, [-5.12, 3.2, 0]);
  // scrap crane w/ hanging hulk
  for (const s of [1, -1]) k.bar('solid', [5.2, 0.25, s * 3.6], [5.0, 7.2, s * 3.2], 0.32, C.steel2);
  k.bar('solid', [5.0, 7.2, -3.6], [5.0, 7.2, 3.6], 0.4, C.rust3);
  for (let z = -3.2; z < 3.2; z += 0.8) k.bar('solid', [5.0, 6.8, z], [5.0, 7.2, z + 0.4], 0.06, C.steel2);
  k.line('solid', [5.0, 7.0, 0.8], [5.0, 4.2, 0.8], 0.03, C.steel2, 4);
  cHulk(k, [5.0, 2.6, 0.8], 0.6, C.red, true);
  // smokestacks
  for (const [x, z, h] of [[-4.2, -2.2, 4.4], [-3.0, -2.6, 3.4]]) {
    k.line('solid', [x, 4.6, z], [x, 4.6 + h, z], 0.38, C.soot, 8);
    k.add('solid', cyl(0.48, 0.48, 0.2, 8), C.rust, [x, 4.6 + h * 0.6, z]);
    k.flame([x, 4.6 + h, z], 1.2, 0.32); k.smoke([x, 4.8 + h, z], 6, 1.4);
  }
  cDrum(k, [5.8, 0.25, -3.4], C.red, true); cDrum(k, [5.6, 0.25, 3.0], C.rust); cDrum(k, [-5.4, 0.25, 3.4], C.bone);
  for (let h = 0; h < 2; h++) cTire(k, [-5.4, 0.45 + h * 0.32, -3.4], 0.6);
  cSkull(k, [0.6, 4.7, 3.5], 0.8, 0);
  return fin(k.build(), 'factory', 7.2);
}
function C_turret_mg() {
  const k = new Kit('C'), r = rng(161);
  k.add('solid', cyl(1.6, 1.75, 0.25, 9), C.dirt, [0, 0.12, 0]);
  cSandbags(k, [0, 0.12, 0], 1.3, 9, 2, PI / 2);
  k.add('solid', cyl(0.5, 0.7, 0.9, 6), C.rust2, [0, 0.6, 0]);
  cPlates(k, r, 3, -0.9, 0.9, 0.5, 0.9, 1.45);
  cDrum(k, [-1.2, 0.2, -1.0], C.red);
  const g = k.build();
  const t = new Kit('C');
  t.add('solid', cyl(0.35, 0.35, 0.3, 6), C.steel2, [0, 0.15, 0]);
  t.add('scrap', box(0.12, 0.8, 1.3), C.red, [0.55, 0.55, 0], [0, 0, -0.2]);
  for (const z of [1, -1]) t.add('scrap', box(0.7, 0.5, 0.08), C.rust3, [0.25, 0.5, z * 0.62], [0, z * 0.3, 0]);
  t.add('solid', box(0.6, 0.28, 0.5), C.soot, [0.0, 0.5, 0]);
  for (const z of [0.12, -0.12]) t.add('solid', cyl(0.05, 0.05, 1.5, 6), C.steel2, [1.1, 0.55, z], [0, 0, -PI / 2]);
  t.add('solid', box(0.22, 0.18, 0.2), C.rust, [1.75, 0.55, 0]);
  cSpike(t, [0.6, 0.95, 0.4], [0.3, 1, 0.3], 0.5, 0.06); cSpike(t, [0.6, 0.95, -0.4], [0.3, 1, -0.3], 0.5, 0.06);
  const tur = t.build('turret'); tur.position.y = 1.05; g.add(tur);
  return fin(g, 'turret_mg', 2.0);
}
function C_turret_cannon() {
  const k = new Kit('C'), r = rng(171);
  k.add('solid', cyl(1.6, 1.75, 0.25, 9), C.dirt, [0, 0.12, 0]);
  for (let h = 0; h < 4; h++) cTire(k, [0, 0.4 + h * 0.4, 0], 1.55);
  k.add('scrap', cyl(0.9, 1.0, 2.2, 7), C.rust, [0, 1.3, 0]);
  cPlates(k, r, 4, -0.8, 0.8, 1.2, 2.0, 0.98);
  for (let i = 0; i < 5; i++) { const a = i / 5 * TAU; cSpike(k, polar(1.2, a, 1.0), [Math.sin(a), 0.4, Math.cos(a)], 0.8, 0.09); }
  k.add('solid', cyl(1.05, 1.0, 0.15, 7), C.steel2, [0, 2.45, 0]);
  const g = k.build();
  const t = new Kit('C'), r2 = rng(173);
  t.add('scrap', prism([[-0.95, 0], [0.7, 0], [1.1, 0.35], [0.75, 0.85], [-0.85, 0.9], [-1.1, 0.45]], 1.5, 0.05), C.red, [0, 0, 0]);
  for (const s of [1, -1]) cPlates(t, r2, 3, -0.7, 0.5, 0.2, 0.7, s * 0.78);
  t.add('solid', cyl(0.15, 0.17, 2.6, 8), C.steel2, [2.3, 0.45, 0], [0, 0, -PI / 2]);
  t.add('solid', cyl(0.24, 0.24, 0.5, 8), C.rust, [1.3, 0.45, 0], [0, 0, -PI / 2]);
  t.add('solid', cyl(0.25, 0.2, 0.35, 8), C.soot, [3.65, 0.45, 0], [0, 0, -PI / 2]);
  cSkull(t, [0.1, 1.15, 0], 0.5, 0);
  t.add('glow', box(0.05, 0.1, 0.3), C.amber, [0.95, 0.7, 0], [0, 0, 0.5]);
  const tur = t.build('turret'); tur.position.y = 2.5; g.add(tur);
  return fin(g, 'turret_cannon', 3.6);
}
function addCannon(t, p, scale, elev = 0) { // glTF cannon_01 (barrel +Z in source) -> +X
  if (F.dark && !CANNON.dark) { CANNON.dark = CANNON.mat.clone(); CANNON.dark.color.setHex(0x4a4442); CANNON.dark.emissive = new T.Color(0x140300); }
  const m = new T.Mesh(CANNON.geo, F.dark ? CANNON.dark : CANNON.mat); m.castShadow = m.receiveShadow = true;
  m.position.set(...p); m.rotation.set(0, PI / 2, 0); m.scale.setScalar(scale);
  if (elev) { const piv = new T.Group(); piv.position.set(...p); piv.rotation.z = elev; m.position.set(0, 0, 0); piv.add(m); t.add(piv); } else t.add(m);
}
function C_artillery() {
  const k = new Kit('C'), r = rng(181);
  k.add('solid', bbox(4.2, 0.3, 4.2, 0.08), C.dirt, [0, 0.15, 0]);
  k.add('scrap', bbox(3.4, 0.5, 2.6, 0.06), C.rust, [0, 0.55, 0]);
  for (const [x, z] of [[1.3, 1.5], [-1.3, 1.5], [1.3, -1.5], [-1.3, -1.5]]) cTire(k, [x, 0.55, z], 0.75, true);
  for (const s of [1, -1]) cSandbags(k, [s * 1.7, 0.15, 0], 0.01, 1, 1);
  cPlates(k, r, 4, -1.5, 1.5, 0.45, 0.75, 1.32);
  cDrum(k, [-1.7, 0.3, 1.7], C.red); cDrum(k, [1.75, 0.3, -1.75], C.rust3);
  const g = k.build();
  const t = new Kit('C'), r2 = rng(183);
  t.add('solid', cyl(1.2, 1.3, 0.3, 8), C.steel2, [0, 0.15, 0]);
  for (const s of [1, -1]) t.add('scrap', box(1.7, 1.1, 0.12), s > 0 ? C.red : C.rust3, [0.1, 0.85, s * 0.6], [0, 0, 0.08 * s]);
  t.push([0.3, 1.0, 0], [0, 0, 0.6]);
  t.add('scrap', bbox(1.0, 0.6, 0.65, 0.05), C.rust, [-0.1, 0, 0]);
  t.add('solid', cyl(0.22, 0.28, 3.8, 8), C.steel2, [1.9, 0, 0], [0, 0, -PI / 2]);
  for (const x of [1.0, 2.2]) t.add('solid', cyl(0.32, 0.32, 0.18, 8), C.rust, [x, 0, 0], [0, 0, -PI / 2]);
  t.add('solid', cyl(0.36, 0.3, 0.4, 8), C.soot, [3.9, 0, 0], [0, 0, -PI / 2]);
  t.pop();
  cPlates(t, r2, 3, -1.0, 0.6, 0.5, 1.2, 0.68);
  cSkull(t, [-0.8, 1.2, 0], 0.5, PI);
  const tur = t.build('turret'); tur.position.y = 0.8; g.add(tur);
  return fin(g, 'artillery', 3.0);
}
function C_wall(variant) {
  const k = new Kit('C'), r = rng(191 + variant * 7);
  if (variant === 0) { // stacked car hulks
    cHulk(k, [0, 0, 0], 0, pick(r, [C.rust, C.red, C.rust3]));
    cHulk(k, [0.2, 1.05, 0.05], PI + 0.15, pick(r, [C.rust2, C.bone, C.rust]), true);
  } else if (variant === 1) { // container chunk
    cContainer(k, [0, 0, 0], 0, 4.0, pick(r, [C.rust, C.red, C.rust2]), 0.66);
    k.add('scrap', box(3.8, 0.05, 1.6), C.rust3, [0, 1.6, 0], [0.05, 0, 0.04]);
  } else if (variant === 3) { // patched brick section
    k.add('brick', bbox(3.9, 1.5, 1.2, 0.05), 0xc49a84, [0, 0.75, 0]);
    for (const x of [-1.4, -0.3, 0.9]) k.add('brick', bbox(0.9 + r() * 0.4, 0.3 + r() * 0.4, 1.1, 0.04), 0xb88a74, [x, 1.6, 0], [0, 0, (r() - 0.5) * 0.2]);
    cPlates(k, r, 3, -1.6, 1.6, 0.4, 1.2, 0.62); cPlates(k, r, 3, -1.6, 1.6, 0.4, 1.2, -0.62);
  } else { // spiked tire barricade
    for (let x = -1.5; x <= 1.51; x += 1.0) for (let h = 0; h < 3; h++) cTire(k, [x + (h % 2) * 0.25, 0.25 + h * 0.36, 0], 0.65);
    k.add('solid', box(3.8, 0.12, 0.12), C.steel2, [0, 1.25, 0]);
  }
  for (const s of [1, -1]) for (const x of [-1.4, -0.4, 0.6, 1.5]) cSpike(k, [x, 0.7 + r() * 0.6, s * 0.6], [0.1 * (r() - 0.5), 0.35, s], 0.9 + r() * 0.4, 0.08, r() < 0.5 ? C.bone : C.steel);
  cBarbed(k, [-1.9, 1.9, 0], [1.9, 1.9, 0], 0.17);
  k.add('solid', box(0.6, 0.06, 0.04), C.red, [r() - 0.5, 1.3, 0.78]);
  return fin(k.build(), 'wall', 2.1);
}
function C_gate() {
  const k = new Kit('C'), r = rng(201);
  k.add('solid', bbox(2.0, 0.25, 6.4, 0.06), C.dirt, [0, 0.12, 0]);
  for (const s of [1, -1]) { // scaffold pylons wrapped in plates
    k.push([0, 0, s * 2.5]);
    for (const dx of [0.6, -0.6]) for (const dz of [0.6, -0.6]) k.bar('solid', [dx, 0.2, dz], [dx * 0.8, 5.2, dz * 0.8], 0.16, C.steel2);
    k.add('scrap', box(1.3, 2.2, 1.3), s > 0 ? C.rust : C.red, [0, 1.3, 0], [0, 0.2, 0]);
    k.add('scrap', box(1.1, 1.0, 1.1), C.rust3, [0, 3.3, 0], [0, -0.3, 0]);
    k.add('scrap', box(1.4, 0.15, 1.4), C.rust2, [0, 5.2, 0]);
    cDrum(k, [0, 5.25, 0], C.soot, true);
    for (const a of [0, PI / 2, PI, -PI / 2]) cSpike(k, [Math.sin(a) * 0.7, 4.4, Math.cos(a) * 0.7], [Math.sin(a), 0.5, Math.cos(a)], 0.9, 0.09);
    k.pop();
  }
  k.bar('solid', [0, 5.0, -2.5], [0, 5.0, 2.5], 0.3, C.rust3);
  cSkull(k, [0.2, 5.6, 0], 1.0, 0);
  for (const z of [1, -1]) k.add('jacq', cloth(1.2, 2.4, 0.04, 0.1), C.red, [0.75, 3.6, z * 2.5], [0, PI / 2, 0], 1, { smooth: true });
  // war-rig grille hanging on chains
  k.add('scrap', bbox(0.3, 3.2, 3.4, 0.06), C.red, [0, 2.05, 0]);
  for (let z = -1.45; z <= 1.46; z += 0.29) k.add('solid', box(0.14, 2.9, 0.09), C.steel, [0.12, 2.05, z]);
  k.add('solid', box(0.18, 0.35, 3.5), C.steel2, [0.15, 3.55, 0]); k.add('solid', box(0.18, 0.35, 3.5), C.steel2, [0.15, 0.6, 0]);
  for (const z of [-1.3, 1.3]) { k.add('glow', box(0.08, 0.3, 0.4), C.amber, [0.25, 3.0, z * 0.85], 0, 1, { fx: 3.4 }); for (let y = 3.8; y < 4.95; y += 0.16) k.add('solid', torus(0.07, 0.022, 3, 6), C.steel2, [0, y, z], [0, (y * 10 | 0) % 2 ? PI / 2 : 0, 0]); }
  for (const z of [-1.2, -0.4, 0.4, 1.2]) cSpike(k, [0.15, 0.45, z], [0.3, -1, 0], 0.5, 0.08, C.steel);
  return fin(k.build(), 'gate', 6.0);
}

// ======================================================================= CRIMSON PACT: Desert Forgemasters
// Carved sandstone + forged iron + molten seams. Vehicles: low, fast dune racers with iron ram prows.
const F = { sand: 0xd08a58, sand2: 0xe0a070, rock: 0x9a4a2c, rock2: 0x7a2e1c, iron: 0x2b2724, iron2: 0x433b36, steel: 0x6a625c,
  red: 0xc8322e, red2: 0x8e1f1a, molten: 0xff7a1a, gold: 0xffb340, brick: 0xd8b0a0, tire: 0x1b1918, cyan: 0x39d8ff };
const stoneC = (base = F.sand) => (x, y, z) => { const b = Math.sin(y * 2.6 + Math.sin(x * 0.7 + z * 0.5) * 0.8); return b > 0.6 ? F.rock : b < -0.7 ? F.sand2 : base; };
function fSeam(k, a, b, th = 0.08, col = F.molten) { k.bar('glow', a, b, th, col, { fx: 3 + Math.random() * 0.9 }); }
function fRivets(k, a, b, n, r = 0.07, col = F.iron2) {
  for (let i = 0; i < n; i++) { const t = (i + 0.5) / n; k.add('solid', sph(r, 5, 3), col, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]); }
}
function fBrazier(k, p, s = 1, embers = true) {
  k.push(p, [0, 0, 0], s);
  for (let i = 0; i < 3; i++) { const a = i / 3 * TAU; k.bar('solid', polar(0.45, a, 0), polar(0.2, a, 0.9), 0.07, F.iron); }
  k.add('solid', cyl(0.5, 0.25, 0.4, 8), F.iron2, [0, 1.05, 0]);
  k.add('glow', cyl(0.42, 0.42, 0.05, 8), F.gold, [0, 1.24, 0], 0, 1, { fx: 3.2 });
  k.flame([0, 1.22, 0], 1.1, 0.34);
  if (embers) k.embers([0, 1.6, 0], 6, 0.5, 1);
  k.pop();
}
function fRockFlare(k, p, R, h, r, n = 7) { // jittered boulders around a footprint so it rises out of the ground
  for (let i = 0; i < n; i++) {
    const a = i / n * TAU + r() * 0.5, d = R * (0.95 + r() * 0.12), s = 0.35 + r() * 0.5;
    k.add('stone', jitter(new T.DodecahedronGeometry(1, 0), r, 0.2), stoneC(F.sand), [p[0] + Math.sin(a) * d, p[1] + s * 0.25, p[2] + Math.cos(a) * d], [r(), r() * 6, r()], [s * 1.2, s * h, s]);
  }
}
function fCrest(k, x0, x1, y, z, n, len = 0.7) { // spiked iron crest along X
  k.add('solid', box(x1 - x0, 0.16, 0.3), F.iron, [(x0 + x1) / 2, y, z]);
  for (let i = 0; i < n; i++) { const x = x0 + (i + 0.5) * (x1 - x0) / n; k.spike('solid', [x, y + 0.05, z], [0, 1, 0], len, 0.1, F.iron2); }
}
function fChimney(k, p, h, r = 0.45) {
  k.add('stone', cyl(r * 0.85, r * 1.3, h, 8), stoneC(F.rock), [p[0], p[1] + h / 2, p[2]]);
  for (const t of [0.3, 0.75]) k.add('solid', cyl(r * 1.25 - t * r * 0.4, r * 1.25 - t * r * 0.4, 0.18, 8), F.iron, [p[0], p[1] + h * t, p[2]]);
  k.add('solid', cyl(r * 1.0, r * 0.9, 0.3, 8), F.iron, [p[0], p[1] + h, p[2]]);
  k.add('glow', cyl(r * 0.75, r * 0.75, 0.05, 8), F.molten, [p[0], p[1] + h + 0.16, p[2]], 0, 1, { fx: 3.5 });
  k.flame([p[0], p[1] + h + 0.1, p[2]], 0.9, r * 0.6);
  k.embers([p[0], p[1] + h + 0.4, p[2]], 8, r, 1.1); k.haze([p[0], p[1] + h + 0.6, p[2]], 3, 0.9); k.smoke([p[0], p[1] + h + 1.2, p[2]], 3, 0.8);
}
function fBanner(k, p, h, w, ry = 0, col = F.red) { // iron pole + red jacquard banner
  k.line('solid', p, [p[0], p[1] + h, p[2]], 0.08, F.iron, 6);
  k.push(p, [0, ry, 0]);
  k.bar('solid', [0, h - 0.1, -0.1], [0, h - 0.1, w + 0.1], 0.1, F.iron);
  k.add('jacq', cloth(w, h * 0.5, 0.05, 0.08), col, [0, h - 0.15 - h * 0.25, w / 2], [0, PI / 2, 0], 1, { smooth: true });
  k.add('glow', box(0.04, 0.06, w), F.gold, [0, h - 0.2 - h * 0.5, w / 2], 0, 1, { fx: 3.3 });
  k.spike('solid', [0, h, 0], [0, 1, 0], 0.6, 0.09, F.iron2);
  k.pop();
}
function fWallBanner(k, p, ry, w, h) { k.push(p, [0, ry, 0]); k.add('jacq', cloth(w, h, 0.03, 0.04), F.red, [0, 0, 0], 0, 1, { smooth: true }); k.add('solid', box(w + 0.3, 0.14, 0.14), F.iron, [0, h / 2, 0.05]); k.add('glow', box(w * 0.7, 0.05, 0.03), F.gold, [0, -h / 2 + 0.2, 0.04], 0, 1, { fx: 3.6 }); k.pop(); }
function fWheel(k, x, z, r, w) {
  k.add('solid', cyl(r, r, w, 12), F.tire, [x, r, z], [PI / 2, 0, 0]);
  for (let i = 0; i < 8; i++) k.add('solid', box(0.1, w + 0.04, 0.2), 0x2a2622, [x + Math.cos(i / 8 * TAU) * r, r + Math.sin(i / 8 * TAU) * r, z], [PI / 2, 0, i / 8 * TAU]); // tread blocks
  k.add('solid', cyl(r * 0.5, r * 0.5, w + 0.06, 8), F.iron2, [x, r, z], [PI / 2, 0, 0]);
  k.add('glow', cyl(r * 0.18, r * 0.18, w + 0.1, 6), F.molten, [x, r, z], [PI / 2, 0, 0], 1, { fx: 3.4 });
}
function fTracks(k, len, z, h, w) {
  for (const s of [1, -1]) {
    k.add('solid', prism([[-len / 2 + 0.2, 0.04], [len / 2 - 0.4, 0.04], [len / 2, h * 0.6], [len / 2 - 0.2, h], [-len / 2, h], [-len / 2 - 0.15, h * 0.4]], w, 0.04), F.tire, [0, 0, s * z]);
    for (let x = -len / 2 + 0.05; x <= len / 2 - 0.2; x += 0.26) k.add('solid', box(0.09, 0.05, w + 0.05), F.iron2, [x, h + 0.02, s * z]);
    for (let i = 0; i < 4; i++) k.add('solid', cyl(0.24, 0.24, 0.08, 8), F.steel, [-len / 2 + 0.5 + i * (len - 1) / 3, 0.3, s * (z + w / 2 + 0.02)], [PI / 2, 0, 0]);
  }
}
function fRam(k, x, y, w, h, nSpikes = 3) { // forged iron ram prow pointing +X
  k.add('solid', prism([[0, 0], [0.55, h * 0.35], [0, h]], w, 0.04), F.iron, [x, y, 0]);
  k.add('solid', prism([[0, 0.1], [0.4, h * 0.38], [0, h - 0.1]], w * 0.6, 0.03), F.steel, [x + 0.12, y, 0]);
  for (let i = 0; i < nSpikes; i++) { const z = (i - (nSpikes - 1) / 2) * w / nSpikes; k.spike('solid', [x + 0.45, y + h * 0.35, z], [1, 0.05, 0], 0.6, 0.08, F.steel); }
}

function F_tank() { // low, fast siege crawler with forged ram + heat vents
  const k = new Kit('C');
  fTracks(k, 4.5, 1.1, 0.62, 0.6);
  k.add('solid', prism([[-2.3, 0.4], [1.6, 0.4], [2.3, 0.62], [1.4, 1.05], [-2.0, 1.12], [-2.4, 0.85]], 1.75, 0.06), F.rock2, [0, 0, 0]);
  for (const s of [1, -1]) {
    k.add('solid', prism([[-2.2, 0], [1.9, 0], [1.6, 0.22], [-2.0, 0.22]], 0.08, 0.02), F.red, [0, 0.72, s * 0.9]); // war-red side stripe
    k.add('solid', prism([[-2.2, 0.62], [2.0, 0.62], [2.25, 0.72], [-2.3, 0.82]], 0.66, 0.03), F.iron2, [0, 0, s * 1.1]); // track guards
    fRivets(k, [-1.8, 0.95, s * 0.9], [1.2, 0.95, s * 0.9], 6);
    k.line('solid', [-1.9, 0.9, s * 0.55], [-2.4, 1.55, s * 0.55], 0.1, F.iron, 6); k.flame([-2.4, 1.55, s * 0.55], 0.55, 0.12);
  }
  k.add('solid', bbox(1.2, 0.1, 1.2, 0.03), F.iron, [-1.55, 1.15, 0]);
  for (const x of [-1.95, -1.7, -1.45, -1.2]) fSeam(k, [x, 1.21, -0.45], [x, 1.21, 0.45], 0.07);
  k.embers([-1.6, 1.3, 0], 5, 0.8, 0.8);
  fRam(k, 2.0, 0.15, 2.4, 0.85, 4);
  k.add('glow', box(0.06, 0.1, 0.35), F.gold, [2.05, 0.82, 0.55], [0, 0, 0.4]); k.add('glow', box(0.06, 0.1, 0.35), F.gold, [2.05, 0.82, -0.55], [0, 0, 0.4]);
  const g = k.build();
  const t = new Kit('C');
  t.add('solid', prism([[-1.2, 0], [0.7, 0], [1.15, 0.22], [0.75, 0.5], [-1.0, 0.55], [-1.3, 0.25]], 1.45, 0.05), F.rock2, [0, 0, 0]);
  t.add('solid', prism([[-0.9, 0.5], [0.6, 0.5], [0.4, 0.62], [-0.8, 0.64]], 1.0, 0.03), F.red, [0, 0, 0]);
  for (const s of [1, -1]) { t.spike('solid', [-0.9, 0.4, s * 0.72], [-0.6, 0.5, s], 0.6, 0.07, F.iron2); fRivets(t, [-0.9, 0.3, s * 0.74], [0.5, 0.3, s * 0.74], 4, 0.06); }
  t.add('solid', bbox(0.4, 0.36, 0.5, 0.05), F.iron, [1.05, 0.3, 0]);
  t.add('solid', cyl(0.1, 0.12, 2.6, 8), F.iron2, [2.4, 0.3, 0], [0, 0, -PI / 2]);
  t.add('solid', cyl(0.17, 0.17, 0.5, 8), F.iron, [1.6, 0.3, 0], [0, 0, -PI / 2]);
  t.add('solid', bbox(0.36, 0.26, 0.3, 0.05), F.iron, [3.75, 0.3, 0]);
  t.add('glow', box(0.05, 0.14, 0.2), F.molten, [3.94, 0.3, 0]);
  const tur = t.build('turret'); tur.position.set(-0.2, 1.1, 0); g.add(tur);
  return fin(g, 'tank', 2.0);
}
function F_raider() { // sleek dune interceptor: big rear wheels, long wedge, glowing engine core
  const k = new Kit('C');
  fWheel(k, -1.1, 0.95, 0.62, 0.5); fWheel(k, -1.1, -0.95, 0.62, 0.5); fWheel(k, 1.15, 0.8, 0.4, 0.32); fWheel(k, 1.15, -0.8, 0.4, 0.32);
  k.add('solid', prism([[-1.7, 0.45], [0.6, 0.42], [1.9, 0.5], [1.85, 0.62], [0.2, 0.95], [-1.5, 1.05], [-1.8, 0.8]], 1.0, 0.05), F.rock2, [0, 0, 0]);
  k.add('solid', prism([[0.3, 0.88], [1.8, 0.6], [1.7, 0.68], [0.4, 0.98]], 0.6, 0.03), F.red, [0, 0.02, 0]);
  for (const s of [1, -1]) {
    k.bar('solid', [1.15, 0.4, s * 0.45], [1.15, 0.4, s * 0.68], 0.1, F.iron);
    k.add('solid', prism([[-1.6, 0], [-0.6, 0], [-0.8, 0.12], [-1.5, 0.15]], 0.5, 0.03), F.iron2, [0, 1.2, s * 0.95]); // rear fenders
    k.spike('solid', [-1.6, 1.0, s * 0.5], [-1, 0.25, s * 0.3], 0.7, 0.07, F.iron2);
    k.line('solid', [-1.4, 0.85, s * 0.32], [-2.1, 1.05, s * 0.32], 0.09, F.iron, 6); k.flame([-2.1, 1.05, s * 0.32], 0.45, 0.1, true);
  }
  k.add('solid', prism([[-0.5, 0], [0.4, 0], [0.1, 0.35], [-0.4, 0.38]], 0.55, 0.04), F.iron, [-0.2, 0.95, 0]); // cockpit
  k.add('glow', box(0.3, 0.08, 0.5), F.gold, [0.05, 1.18, 0], [0, 0, 0.75], 1, { fx: 3.2 });
  k.add('solid', cyl(0.32, 0.32, 0.6, 8), F.iron2, [-1.45, 0.95, 0], [PI / 2, 0, 0]);
  k.add('glow', cyl(0.24, 0.24, 0.64, 8), F.molten, [-1.45, 0.95, 0], [PI / 2, 0, 0], 1, { fx: 3.6 });
  k.embers([-1.6, 1.0, 0], 4, 0.4, 0.7);
  fRam(k, 1.85, 0.28, 1.0, 0.45, 2);
  k.add('solid', box(0.45, 0.14, 0.14), F.iron, [-0.55, 1.4, 0]); k.add('solid', cyl(0.045, 0.045, 1.0, 6), F.iron2, [0.15, 1.42, 0], [0, 0, -PI / 2]);
  k.add('glow', box(0.06, 0.08, 0.2), F.gold, [1.86, 0.6, 0.3]); k.add('glow', box(0.06, 0.08, 0.2), F.gold, [1.86, 0.6, -0.3]);
  return fin(k.build(), 'raider', 1.7);
}
function F_harvester() { // armored rock-cutter hauler with glowing crusher
  const k = new Kit('C'), r = rng(121);
  k.add('solid', bbox(4.0, 0.4, 1.6, 0.06), F.iron, [0, 0.72, 0]);
  for (const x of [1.25, 0.05, -1.2]) for (const s of [1, -1]) fWheel(k, x, s * 1.05, 0.5, 0.4);
  k.add('solid', prism([[0.4, 0.9], [1.7, 0.9], [1.75, 1.35], [1.35, 1.95], [0.5, 2.0]], 1.7, 0.06), F.rock2, [0, 0, 0]);
  k.add('glow', box(0.05, 0.16, 1.3), F.gold, [1.56, 1.65, 0], [0, 0, 0.55], 1, { fx: 3.3 });
  for (const s of [1, -1]) { k.add('solid', bbox(1.1, 0.25, 0.06, 0.02), F.red, [1.05, 1.25, s * 0.87]); fRivets(k, [0.5, 1.6, s * 0.87], [1.4, 1.6, s * 0.87], 4, 0.05); }
  // armoured ore hopper with crystals
  k.add('solid', prism([[-1.9, 0.9], [0.3, 0.9], [0.4, 2.0], [-2.0, 2.1]], 1.9, 0.06), F.rock2, [0, 0, 0]);
  k.add('solid', box(2.1, 0.05, 1.6), 0x1a1210, [-0.8, 2.02, 0]);
  for (let i = 0; i < 7; i++) k.add('glow', ico(0.3, 0), i % 3 ? F.cyan : 0xbff6ff, [-0.8 + (r() - 0.5) * 1.6, 2.15 + r() * 0.15, (r() - 0.5) * 1.2], [r(), r(), r()], [0.7, 1.3, 0.7]);
  for (const s of [1, -1]) { k.add('solid', box(2.4, 0.16, 0.16), F.iron2, [-0.8, 2.12, s * 0.98]); k.add('solid', bbox(1.8, 0.3, 0.06, 0.02), F.red, [-0.8, 1.45, s * 0.98]); }
  // crusher drum with glowing teeth
  k.add('solid', prism([[1.7, 0.2], [2.3, 0.15], [2.5, 0.9], [1.8, 1.2]], 2.2, 0.05), F.iron, [0, 0, 0]);
  k.add('glow', cyl(0.42, 0.42, 1.9, 10), F.molten, [2.45, 0.5, 0], [PI / 2, 0, 0], 1, { fx: 3.5 });
  k.add('solid', cyl(0.46, 0.46, 2.0, 6, true), F.iron2, [2.45, 0.5, 0], [PI / 2, 0, 0]);
  for (let i = 0; i < 6; i++) for (const z of [-0.6, 0, 0.6]) { const a = i / 6 * TAU + z; k.spike('solid', [2.45 + Math.cos(a) * 0.45, 0.5 + Math.sin(a) * 0.45, z], [Math.cos(a), Math.sin(a), 0], 0.3, 0.08, F.steel); }
  k.embers([2.6, 0.5, 0], 5, 1.4, 0.6);
  k.line('solid', [0.5, 1.9, 0.6], [0.4, 2.8, 0.6], 0.1, F.iron, 6); k.flame([0.4, 2.8, 0.6], 0.5, 0.12); k.smoke([0.4, 3.0, 0.6], 3, 0.6);
  return fin(k.build(), 'harvester', 2.4);
}
function F_cc() { // fortress-forge carved into a rock outcrop: crucible core + iron spire
  const k = new Kit('C'), r = rng(131);
  fRockFlare(k, [0, 0, 0], 7.8, 1.2, r, 11);
  k.add('stone', cyl(6.6, 8.0, 2.6, 9), stoneC(), [0, 1.3, 0], [0, 0.2, 0]);           // outcrop base
  k.add('stone', cyl(5.0, 6.4, 3.0, 7), stoneC(F.sand2), [0, 4.1, 0], [0, 0.5, 0]);   // carved upper tier
  k.add('solid', cyl(6.65, 6.65, 0.35, 9), F.iron, [0, 2.65, 0], [0, 0.2, 0]);         // iron band
  k.add('solid', cyl(5.05, 5.05, 0.3, 7), F.iron, [0, 5.6, 0], [0, 0.5, 0]);
  for (let i = 0; i < 9; i++) { const a = 0.2 + (i + 0.5) / 9 * TAU; k.add('solid', sph(0.16, 5, 3), F.iron2, polar(6.66, a, 2.65)); }
  // wedge buttresses
  for (let i = 0; i < 7; i++) { const a = 0.5 + (i + 0.5) / 7 * TAU, p = polar(6.3, a, 0);
    k.add('stone', prism([[-0.2, 0], [1.9, 0], [0.1, 5.3], [-0.2, 5.4]], 1.0, 0.06), stoneC(F.rock), p, [0, a - PI / 2, 0]);
    k.add('solid', box(0.3, 0.25, 1.1), F.iron, polar(6.45, a, 3.6), [0, a - PI / 2, 0]); }
  // molten pour channels down the rock face
  const lw = F.lavaW || 0.14;
  for (const a of [0.9, 2.6, 4.0, 5.4]) { fSeam(k, polar(4.95, a, 5.5), polar(6.5, a, 2.6), lw); fSeam(k, polar(6.75, a, 2.5), polar(7.9, a, 0.08), lw);
    if (F.spires) { k.add('glow', box(lw * 4, 0.06, lw * 4), F.gold, polar(7.95, a, 0.04), 0, 1, { fx: 3.2 }); k.embers(polar(7.6, a, 0.3), 3, 1, 0.6); } }
  if (F.spires) { k.add('glow', torus(8.3, 0.35, 3, 40), F.molten, [0, 0.12, 0], [PI / 2, 0, 0], [1, 1, 0.3], { fx: 3.1 }); k.add('glow', torus(8.3, 0.12, 3, 40), F.gold, [0, 0.2, 0], [PI / 2, 0, 0], [1, 1, 0.3], { fx: 3.6 }); k.embers([0, 0.4, 0], 16, 15, 0.9); }
  if (F.spires) for (let i = 0; i < 7; i++) { const a = 0.3 + i / 7 * TAU, h = 3.5 + (i % 3) * 2.2; k.spike('solid', polar(6.0 + (i % 2) * 1.1, a, 2.0), [Math.sin(a) * 0.25, 1, Math.cos(a) * 0.25], h, 0.55, F.iron2); }
  // crucible core
  k.add('solid', cyl(3.2, 2.2, 1.6, 10), F.iron, [0, 6.4, 0]);
  k.add('solid', torus(3.15, 0.18, 4, 20), F.iron2, [0, 7.2, 0], [PI / 2, 0, 0]);
  if (F.spires) { k.add('glow', torus(3.3, 0.16, 3, 28), F.molten, [0, 7.3, 0], [PI / 2, 0, 0], 1, { fx: 3.2 }); k.add('glow', torus(5.1, 0.14, 3, 28), F.molten, [0, 5.75, 0], [PI / 2, 0, 0], 1, { fx: 3.6 }); ccBeacon(k, [3.0, 5.6, 3.0], 0xff5a12, 4.5, 'solid'); }
  k.add('glow', cyl(2.95, 2.95, 0.08, 16), F.molten, [0, 7.05, 0], 0, 1, { fx: 3.1 });
  k.add('glow', cyl(1.6, 1.6, 0.1, 12), F.gold, [0, 7.1, 0], 0, 1, { fx: 3.7 });
  for (let i = 0; i < 6; i++) { const a = i / 6 * TAU; k.flame(polar(1.9, a, 7.05), 1.2 + (i % 2) * 0.6, 0.35); }
  k.embers([0, 7.4, 0], 22, 4.5, 1.4); k.haze([0, 7.8, 0], 4, 2.0);
  for (let i = 0; i < 4; i++) { const a = i / 4 * TAU + 0.4; k.add('solid', bbox(0.5, 1.8, 0.5, 0.06), F.iron2, polar(3.25, a, 6.4), [0, a, 0]); k.add('glow', box(0.08, 1.2, 0.2), F.molten, polar(3.52, a, 6.4), [0, a, 0], 1, { fx: 3.3 }); }
  // iron spire (rear) with spiked rings + chains to the rock
  k.push([-2.6, 5.6, -1.6]);
  k.add('solid', cyl(0.35, 1.1, 8.2, 6), F.iron, [0, 4.1, 0]);
  for (const [y, rr] of [[2.4, 1.05], [5.2, 0.75]]) { k.add('solid', cyl(rr, rr, 0.3, 6), F.iron2, [0, y, 0]); for (let i = 0; i < 6; i++) { const a = i / 6 * TAU; k.spike('solid', polar(rr, a, y), [Math.sin(a), 0.3, Math.cos(a)], 0.7, 0.08, F.steel); } }
  for (let i = 0; i < 3; i++) { const a = i / 3 * TAU; fSeam(k, polar(1.0, a, 0.4), polar(0.4, a, 7.8), 0.07, F.gold); }
  k.spike('solid', [0, 8.1, 0], [0, 1, 0], 1.4, 0.25, F.iron2);
  k.flame([0, 9.3, 0], 0.8, 0.14);
  k.pop();
  for (const a of [0.6, 2.4]) k.line('solid', [-2.6, 13.0, -1.6], polar(6.0, a, 2.8), 0.05, F.iron2, 4);
  // dressed-masonry gatehouse on +X with iron gate + glowing seams
  k.add('brick', bbox(2.4, 3.6, 4.4, 0.08), F.brick, [7.2, 1.8, 0]);
  k.add('solid', box(0.2, 2.6, 2.4), F.iron, [8.45, 1.4, 0]);
  for (const z of [-0.8, -0.27, 0.27, 0.8]) k.add('solid', box(0.08, 2.5, 0.12), F.iron2, [8.57, 1.4, z]);
  fSeam(k, [8.6, 0.1, 0], [8.6, 2.7, 0], 0.07); fSeam(k, [8.6, 2.75, -1.2], [8.6, 2.75, 1.2], 0.09);
  k.add('solid', prism([[0, 0], [0.5, 0], [0.5, 0.5]], 4.8, 0.03), F.iron, [7.9, 3.6, 0]);
  fCrest(k, 6.2, 8.2, 3.75, 2.2, 4, 0.6); fCrest(k, 6.2, 8.2, 3.75, -2.2, 4, 0.6);
  fBrazier(k, [8.8, 0, 2.7], 1.2); fBrazier(k, [8.8, 0, -2.7], 1.2);
  for (const a of [PI / 2 + 0.75, PI / 2 - 0.85, PI + 0.6, -0.4]) fWallBanner(k, polar(6.35, a, 3.6).map((v, i) => v + (i === 1 ? 0 : 0)), a, 1.3, 2.4);
  fBrazier(k, polar(5.6, PI + 1.2, 5.75), 1.0, false); fBrazier(k, polar(5.6, 1.4, 5.75), 1.0, false);
  return fin(k.build(), 'cc', 13.5);
}
function F_barracks() { // rock-cut hall with iron gates
  const k = new Kit('C'), r = rng(141);
  fRockFlare(k, [0, 0, 0], 4.6, 0.8, r, 8);
  k.add('stone', prism([[-3.4, 0], [3.4, 0], [2.9, 3.9], [-2.9, 3.9]], 7.6, 0.08), stoneC(), [-0.4, 0, 0], [0, PI / 2, 0]);
  k.add('stone', prism([[-3.6, 0], [3.6, 0], [1.0, 1.7], [-1.0, 1.7]], 7.0, 0.08), stoneC(F.rock), [-0.4, 3.9, 0], [0, PI / 2, 0]);
  k.add('solid', box(7.2, 0.25, 6.0), F.iron, [-0.4, 3.95, 0]);
  for (const x of [-3.0, -0.4, 2.2]) { k.add('solid', box(0.35, 0.2, 6.4), F.iron2, [x, 2.2, 0]); }
  // dressed-brick facade + iron double gate on +X
  k.add('brick', bbox(0.9, 4.6, 5.4, 0.08), F.brick, [3.4, 2.3, 0]);
  k.add('solid', box(0.2, 2.8, 2.6), F.iron, [3.88, 1.4, 0]);
  for (const z of [-0.9, -0.3, 0.3, 0.9]) k.add('solid', box(0.1, 2.7, 0.12), F.iron2, [3.99, 1.4, z]);
  fRivets(k, [4.0, 2.4, -1.2], [4.0, 2.4, 1.2], 7, 0.06);
  fSeam(k, [4.02, 0.05, 0], [4.02, 2.75, 0], 0.07); fSeam(k, [4.02, 2.85, -1.3], [4.02, 2.85, 1.3], 0.1, F.gold);
  k.add('solid', prism([[0, 0], [0.7, 0], [0.7, 0.4]], 5.6, 0.03), F.iron, [3.2, 4.6, 0]);
  fCrest(k, 2.9, 4.0, 4.98, 0, 3, 0.6);
  fBrazier(k, [4.5, 0, 2.2], 1.1); fBrazier(k, [4.5, 0, -2.2], 1.1);
  for (const s of [1, -1]) { fWallBanner(k, [0.4, 2.2, s * 3.1], s > 0 ? 0 : PI, 1.2, 2.2); fWallBanner(k, [-2.4, 2.2, s * 3.1], s > 0 ? 0 : PI, 1.2, 2.2); fSeam(k, [-3.6, 0.3, s * 3.15], [2.8, 0.3, s * 3.15], 0.1); }
  fChimney(k, [-2.8, 4.3, 1.4], 2.6, 0.45);
  fBanner(k, [-3.9, 0, -3.0], 6.5, 1.2, PI);
  return fin(k.build(), 'barracks', 6.0);
}
function F_factory() { // forge-hangar: molten pour channels, crucible, crane with ladle
  const k = new Kit('C'), r = rng(151);
  fRockFlare(k, [-2.3, 0, 0], 4.6, 0.8, r, 7);
  k.add('stone', prism([[-3.7, 0], [3.7, 0], [3.2, 4.6], [-3.2, 4.6]], 5.8, 0.08), stoneC(), [-2.3, 0, 0], [0, PI / 2, 0]);
  k.add('brick', bbox(0.5, 4.2, 6.6, 0.06), F.brick, [0.5, 2.1, 0]);
  for (const s of [1, -1]) { k.add('stone', prism([[0, 0], [4.4, 0], [4.4, 0.5], [0, 4.8]], 0.9, 0.06), stoneC(F.rock), [0.5, 0, s * 3.3]); }
  // iron hangar roof frame over the bay
  for (const x of [1.5, 3.0, 4.5]) k.bar('solid', [x, 4.6, -3.4], [x, 5.2, 0], 0.22, F.iron), k.bar('solid', [x, 5.2, 0], [x, 4.6, 3.4], 0.22, F.iron);
  k.add('solid', box(3.6, 0.08, 7.0), F.iron2, [3.0, 4.9, 0], [0, 0, 0.0]);
  // molten pour channel from crucible across the bay floor
  k.add('solid', cyl(1.0, 0.7, 1.1, 10), F.iron, [1.6, 0.55, -1.6]);
  k.add('glow', cyl(0.85, 0.85, 0.06, 10), F.molten, [1.6, 1.1, -1.6], 0, 1, { fx: 3.2 });
  k.add('stone', box(4.4, 0.25, 0.7), stoneC(F.rock2), [3.6, 0.12, -0.2]);
  k.add('glow', box(4.3, 0.06, 0.4), F.molten, [3.6, 0.27, -0.2], 0, 1, { fx: 3.5 });
  fSeam(k, [1.6, 0.3, -1.0], [1.6, 0.3, -0.2], 0.25);
  k.embers([1.6, 1.3, -1.6], 10, 1.0, 1); k.embers([3.8, 0.4, -0.2], 8, 2.5, 0.6);
  // gantry crane with molten ladle
  for (const s of [1, -1]) k.add('solid', bbox(0.45, 7.0, 0.45, 0.05), F.iron, [5.4, 3.5, s * 3.6]);
  k.add('solid', bbox(0.7, 0.6, 8.0, 0.06), F.iron2, [5.4, 7.1, 0]);
  fRivets(k, [5.78, 7.1, -3.6], [5.78, 7.1, 3.6], 10, 0.07);
  k.line('solid', [5.4, 6.8, 1.0], [5.4, 3.6, 1.0], 0.04, F.steel, 4);
  k.add('solid', cyl(0.7, 0.5, 0.9, 8), F.iron, [5.4, 3.1, 1.0]);
  k.add('glow', cyl(0.6, 0.6, 0.05, 8), F.molten, [5.4, 3.56, 1.0], 0, 1, { fx: 3.4 });
  k.flame([5.4, 3.55, 1.0], 0.5, 0.3);
  // chimneys + crest + banners
  fChimney(k, [-4.0, 4.6, -1.8], 3.4, 0.55); fChimney(k, [-4.0, 4.6, 1.8], 2.6, 0.45);
  fCrest(k, -5.0, 0.4, 4.75, 2.85, 7, 0.55); fCrest(k, -5.0, 0.4, 4.75, -2.85, 7, 0.55);
  for (const s of [1, -1]) { fWallBanner(k, [-2.3, 2.5, s * 3.05], s > 0 ? 0 : PI, 1.4, 2.4); fSeam(k, [-5.2, 0.3, s * 3.25], [0.4, 0.3, s * 3.25], 0.1); }
  fBrazier(k, [6.0, 0, 3.2], 1.0); fBrazier(k, [6.0, 0, -3.2], 1.0);
  return fin(k.build(), 'factory', 7.4);
}
function fEmplacement(k, R, h, r) { // octagonal carved stone ring, flared, iron-banded
  fRockFlare(k, [0, 0, 0], R + 0.1, 0.5, r, 6);
  k.add('stone', cyl(R * 0.82, R, h, 8), stoneC(), [0, h / 2, 0], [0, PI / 8, 0]);
  k.add('solid', cyl(R * 0.84, R * 0.84, 0.18, 8), F.iron, [0, h - 0.05, 0], [0, PI / 8, 0]);
  for (let i = 0; i < 8; i++) { const a = PI / 8 + i / 8 * TAU; k.add('solid', sph(0.09, 5, 3), F.iron2, polar(R * 0.85, a, h - 0.05)); }
  for (const a of [PI / 2, -PI / 2, PI]) fSeam(k, polar(R * 0.98, a, 0.12), polar(R * 0.85, a, h - 0.2), 0.09);
}
function F_turret_mg() {
  const k = new Kit('C'), r = rng(161); fEmplacement(k, 1.6, 0.9, r);
  const g = k.build();
  const t = new Kit('C');
  t.add('solid', cyl(0.75, 0.85, 0.25, 8), F.iron2, [0, 0.12, 0]);
  t.add('solid', prism([[-0.6, 0], [0.5, 0], [0.75, 0.3], [0.5, 0.7], [-0.6, 0.7]], 1.1, 0.04), F.rock2, [0, 0.2, 0]);
  t.add('solid', prism([[0, 0], [0.25, 0.4], [0, 0.95]], 1.4, 0.03), F.iron, [0.55, 0.2, 0]);
  for (const s of [1, -1]) { t.add('solid', cyl(0.06, 0.06, 1.3, 6), F.iron2, [1.25, 0.6, s * 0.18], [0, 0, -PI / 2]); t.add('glow', box(0.05, 0.08, 0.08), F.molten, [1.92, 0.6, s * 0.18]); t.spike('solid', [-0.5, 0.75, s * 0.4], [-0.5, 1, s * 0.4], 0.6, 0.07, F.iron2); }
  t.add('glow', box(0.5, 0.05, 0.6), F.gold, [-0.1, 0.93, 0], 0, 1, { fx: 3.4 });
  const tur = t.build('turret'); tur.position.y = 0.95; g.add(tur);
  return fin(g, 'turret_mg', 2.0);
}
function F_turret_cannon() { // primitive fallback (no glTF yet)
  const k = new Kit('C'), r = rng(171); fEmplacement(k, 1.6, 2.0, r);
  const g = k.build();
  const t = new Kit('C');
  t.add('solid', prism([[-0.95, 0], [0.7, 0], [1.1, 0.35], [0.75, 0.85], [-0.85, 0.9], [-1.1, 0.45]], 1.5, 0.05), F.rock2, [0, 0, 0]);
  t.add('solid', cyl(0.15, 0.17, 2.6, 8), F.iron2, [2.3, 0.45, 0], [0, 0, -PI / 2]);
  t.add('solid', cyl(0.24, 0.24, 0.5, 8), F.iron, [1.3, 0.45, 0], [0, 0, -PI / 2]);
  t.add('glow', box(0.05, 0.2, 0.2), F.molten, [3.62, 0.45, 0]);
  const tur = t.build('turret'); tur.position.y = 2.0; g.add(tur);
  return fin(g, 'turret_cannon', 3.4);
}
function F_artillery() {
  const k = new Kit('C'), r = rng(181);
  k.add('stone', bbox(4.2, 0.7, 4.2, 0.15), stoneC(), [0, 0.35, 0]); fRockFlare(k, [0, 0, 0], 2.3, 0.4, r, 6);
  const g = k.build();
  const t = new Kit('C');
  t.add('solid', cyl(1.2, 1.3, 0.3, 8), F.iron2, [0, 0.15, 0]);
  t.push([0.3, 1.0, 0], [0, 0, 0.6]);
  t.add('solid', bbox(1.0, 0.6, 0.65, 0.05), F.iron, [-0.1, 0, 0]);
  t.add('solid', cyl(0.22, 0.28, 3.8, 8), F.iron2, [1.9, 0, 0], [0, 0, -PI / 2]);
  t.pop();
  const tur = t.build('turret'); tur.position.y = 0.7; g.add(tur);
  return fin(g, 'artillery', 3.0);
}
function F_turret_cannon_gltf() { // carved stone emplacement + forged-iron mount + PBR cannon
  const k = new Kit('C'), r = rng(175); fEmplacement(k, 1.65, 1.0, r);
  fBrazier(k, polar(1.75, PI * 0.8, 0), 0.7, false);
  const g = k.build();
  const t = new Kit('C');
  t.add('solid', cyl(1.05, 1.1, 0.2, 8), F.iron2, [0, 0.1, 0]);
  for (const sd of [1, -1]) { t.add('solid', prism([[-0.8, 0], [0.9, 0], [0.6, 0.85], [-0.6, 0.9]], 0.14, 0.03), F.rock2, [0.1, 0.15, sd * 0.85]); t.spike('solid', [0.85, 0.5, sd * 0.85], [1, 0.4, sd * 0.3], 0.6, 0.07, F.iron2); fRivets(t, [-0.5, 0.6, sd * 0.93], [0.5, 0.6, sd * 0.93], 4, 0.05); }
  t.add('glow', box(1.4, 0.05, 0.05), F.gold, [0.1, 0.25, 0.93], 0, 1, { fx: 3.3 }); t.add('glow', box(1.4, 0.05, 0.05), F.gold, [0.1, 0.25, -0.93], 0, 1, { fx: 3.6 });
  if (F.dark) { t.add('glow', cyl(0.2, 0.2, 0.06, 10), F.molten, [2.23, 1.0, 0], [0, 0, PI / 2], 1, { fx: 3.5 }); t.embers([2.3, 1.0, 0], 3, 0.3, 0.5); }
  const tur = t.build('turret');
  addCannon(tur, [-0.15, 0.12, 0], 1.45);
  tur.position.y = 1.0; g.add(tur);
  return fin(g, 'turret_cannon', 2.6);
}
function F_artillery_gltf() {
  const k = new Kit('C'), r = rng(185);
  k.add('stone', bbox(4.2, 0.8, 4.2, 0.18), stoneC(), [0, 0.4, 0]); fRockFlare(k, [0, 0, 0], 2.4, 0.45, r, 7);
  k.add('solid', box(4.3, 0.15, 4.3), F.iron, [0, 0.82, 0]);
  for (const [x, z] of [[1.9, 1.9], [-1.9, 1.9], [1.9, -1.9], [-1.9, -1.9]]) k.spike('solid', [x, 0.85, z], [x, 2.5, z], 0.9, 0.12, F.iron2);
  fSeam(k, [-2.12, 0.5, -1.6], [-2.12, 0.5, 1.6], 0.1); fSeam(k, [2.12, 0.5, -1.6], [2.12, 0.5, 1.6], 0.1);
  fBrazier(k, [-1.6, 0.85, 1.6], 0.6, false);
  const g = k.build();
  const t = new Kit('C');
  t.add('solid', cyl(1.3, 1.35, 0.25, 8), F.iron2, [0, 0.12, 0]);
  t.add('stone', bbox(2.0, 0.5, 1.6, 0.06), stoneC(F.rock), [-0.3, 0.45, 0]);
  for (const sd of [1, -1]) t.add('solid', prism([[-0.9, 0], [1.0, 0], [0.7, 1.1], [-0.7, 1.2]], 0.14, 0.03), F.rock2, [0.1, 0.2, sd * 0.95]);
  t.add('glow', box(0.05, 0.6, 0.5), F.molten, [-1.32, 0.5, 0], 0, 1, { fx: 3.5 });
  const tur = t.build('turret');
  addCannon(tur, [-0.2, 0.7, 0], 1.9, 0.32);
  tur.position.y = 0.9; g.add(tur);
  return fin(g, 'artillery', 3.3);
}
function F_wall(variant) { // sandstone slab bound with iron, wedge buttresses, spiked crest
  const k = new Kit('C'), r = rng(191 + variant * 7);
  if (variant === 1) k.add('brick', prism([[-0.75, 0], [0.75, 0], [0.55, 1.75], [-0.55, 1.75]], 3.96, 0.05), F.brick, [0, 0, 0], [0, PI / 2, 0]);
  else k.add('stone', prism([[-0.75, 0], [0.75, 0], [0.55, 1.75], [-0.55, 1.75]], 3.96, 0.05), stoneC(variant ? F.sand2 : F.sand), [0, 0, 0], [0, PI / 2, 0]);
  for (const s of [1, -1]) {
    for (const x of [-1.75, 1.75]) k.add('stone', prism([[0, 0], [0.6, 0], [0.05, 1.5], [0, 1.6]], 0.5, 0.04), stoneC(F.rock), [x, 0, s * 0.62], [0, -s * PI / 2, 0]);
    k.add('solid', box(3.9, 0.16, 0.06), F.iron, [0, 0.35, s * 0.73], [s * 0.11, 0, 0]);
    k.add('solid', box(3.9, 0.2, 0.06), F.iron, [0, 1.45, s * 0.6], [s * 0.11, 0, 0]);
    fRivets(k, [-1.6, 1.45, s * 0.64], [1.6, 1.45, s * 0.64], 5, 0.06);
    if (variant === 2) fSeam(k, [-1.2, 0.2, s * 0.74], [0.4 + r(), 1.3, s * 0.62], 0.08);
  }
  for (const x of [-1.0, 1.0]) k.add('solid', box(0.2, 1.8, 1.56), F.iron2, [x, 0.9, 0]);
  k.add('solid', bbox(4.0, 0.22, 1.3, 0.05), F.iron, [0, 1.85, 0]);
  fCrest(k, -1.9, 1.9, 2.0, 0, 6, 0.55);
  return fin(k.build(), 'wall', 2.4);
}
function F_gate() { // massive iron portcullis between flared stone pylons, glowing seams
  const k = new Kit('C'), r = rng(201);
  for (const s of [1, -1]) {
    fRockFlare(k, [0, 0, s * 2.5], 1.2, 0.6, r, 5);
    k.add('stone', cyl(0.75, 1.25, 5.4, 6), stoneC(), [0, 2.7, s * 2.5], [0, 0.3, 0]);
    k.add('solid', cyl(0.95, 0.95, 0.3, 6), F.iron, [0, 3.6, s * 2.5], [0, 0.3, 0]);
    k.add('solid', cone(0.9, 1.2, 6), F.iron, [0, 6.0, s * 2.5], [0, 0.3, 0]);
    fBrazier(k, [0, 6.4, s * 2.5], 0.8);
    fSeam(k, [0.95, 0.3, s * 2.5], [0.7, 5.2, s * 2.5], 0.1);
    k.add('jacq', cloth(1.0, 2.4, 0.03, 0.08), F.red, [0.95, 3.2, s * 2.5], [0, PI / 2, 0], 1, { smooth: true });
  }
  k.add('solid', bbox(0.7, 0.7, 6.2, 0.08), F.iron, [0, 5.2, 0]);
  fCrest(k, -0.01, 0.01, 5.6, 0, 0, 0.5);
  for (let i = 0; i < 6; i++) k.spike('solid', [0, 5.5, -2.0 + i * 0.8], [0, 1, 0], 0.8, 0.1, F.iron2);
  // portcullis grid
  for (let z = -1.5; z <= 1.51; z += 0.375) { k.add('solid', box(0.18, 4.4, 0.14), F.iron2, [0.1, 2.5, z]); k.spike('solid', [0.1, 0.32, z], [0, -1, 0], 0.35, 0.08, F.steel); }
  for (const y of [1.0, 2.1, 3.2, 4.3]) k.add('solid', box(0.22, 0.18, 3.4), F.iron, [0.1, y, 0]);
  for (const y of [1.55, 2.65, 3.75]) fSeam(k, [0.08, y, -1.5], [0.08, y, 1.5], 0.06);
  for (const z of [-1.2, 1.2]) for (let y = 4.6; y < 5.0; y += 0.16) k.add('solid', torus(0.07, 0.022, 3, 6), F.steel, [0.1, y, z], [0, (y * 10 | 0) % 2 ? PI / 2 : 0, 0]);
  k.add('glow', box(0.06, 0.5, 0.5), F.molten, [0.25, 4.85, 0], [PI / 4, 0, 0], 1, { fx: 3.4 });
  return fin(k.build(), 'gate', 6.8);
}

// ======================================================================= EARTH CULT (team-1 candidate A)
// Red-rock mountainside, terraced temples, ancient trees, gold sun-discs firing light beams, floating rock, sun-crystals.
const E = { rock: 0xb0583a, rock2: 0x8a3e28, sand: 0xe0aa78, sand2: 0xf0c49a, moss: 0x4a9a44, leaf: 0x3a8a3c, leaf2: 0x6cc05a, bark: 0x5e3e28,
  gold: 0xe8b648, sun: 0xffd56a, white: 0xfff4d6, red: 0xb8302a, cyan: 0x39d8ff };
const eStone = (base = E.sand) => (x, y, z) => { const b = Math.sin(y * 2.2 + Math.sin(x * 0.6 + z * 0.4) * 0.9); return b > 0.55 ? E.rock : b < -0.65 ? E.sand2 : base; };
function eBoulder(k, p, s, r, col = E.rock, sy = 0.8) { k.add('stone', jitter(new T.DodecahedronGeometry(1, 0), r, 0.22), eStone(col), p, [r(), r() * 6, r()], [s * (1 + r() * 0.3), s * sy, s]); }
function eTree(k, p, h, s, r) { // ancient tree: thick trunk, roots gripping rock, layered canopy
  k.push(p, [0, r() * TAU, 0], s);
  k.add('leaf', cyl(0.35, 0.6, h, 7), E.bark, [0, h / 2, 0], [0.08, 0, 0.05]);
  for (let i = 0; i < 6; i++) { const a = i / 6 * TAU + r() * 0.4; k.line('leaf', [0, 0.6, 0], polar(1.4 + r() * 0.6, a, -0.25), 0.16, E.bark, 5); }
  for (let i = 0; i < 3; i++) { const a = i / 3 * TAU + 0.4; k.line('leaf', [0, h * 0.75, 0], polar(1.2, a, h + 0.3), 0.14, E.bark, 5); }
  const blobs = [[0, h + 1.0, 0, 2.0], [1.3, h + 0.5, 0.5, 1.4], [-1.2, h + 0.6, -0.4, 1.45], [0.3, h + 0.4, -1.3, 1.3], [-0.4, h + 0.5, 1.3, 1.3], [0.2, h + 1.9, 0.1, 1.2]];
  for (const [x, y, z, rr] of blobs) k.add('leaf', ico(rr, 0), (x2, y2) => (y2 > p[1] + (h + 0.9) * s ? E.leaf2 : E.leaf), [x, y, z], [r(), r(), r()], [1, 0.75, 1]);
  k.pop();
}
function eSunDisc(k, p, R, tilt = 0.6, ry = 0, beam = 0) { // gold mirror on a stone post, optional sunbeam upward
  k.push(p, [0, ry, 0]);
  k.add('gold', cyl(R, R, 0.12, 20), E.gold, [0, 0, 0], [PI / 2 - tilt, 0, 0]);
  k.add('glow', cyl(R * 0.55, R * 0.55, 0.14, 16), E.sun, [0, 0, 0], [PI / 2 - tilt, 0, 0], 1, { fx: 3.2 });
  for (let i = 0; i < 8; i++) { const a = i / 8 * TAU; k.push([0, 0, 0], [PI / 2 - tilt, 0, 0]); k.add('gold', cone(R * 0.16, R * 0.5, 4), E.gold, [Math.cos(a) * R * 1.15, 0, Math.sin(a) * R * 1.15], [0, 0, -PI / 2 + 0 * a], 1, { m: new T.Matrix4().compose(new T.Vector3(Math.cos(a) * R * 1.2, 0, Math.sin(a) * R * 1.2), new T.Quaternion().setFromUnitVectors(_up(), new T.Vector3(Math.cos(a), 0, Math.sin(a))), new T.Vector3(1, 1, 1)) }); k.pop(); }
  if (beam) k.add('beam', cyl(R * 0.35, R * 0.12, beam, 10, true), E.sun, [0, beam / 2 + 0.2, 0], 0, 1, { fx: 3.5, smooth: true });
  k.pop();
}
function eCrystal(k, p, h, w, tilt = 0, ry = 0) { k.add('glow', new T.OctahedronGeometry(1, 0), E.sun, [p[0], p[1] + h * 0.8, p[2]], [tilt, ry, 0], [w, h, w], { fx: 3 + Math.random() * 0.9 }); }
function eFloat(k, p, s, r) { // floating rock fragment (bobs via updateModels) with glowing underside + motes
  if (!k._bob) { k._bob = new Kit(k.theme); (k.subs ||= []).push(['bob', [0, 0, 0], [0, 0, 0], k._bob]); }
  const q = k._bob, w = new T.Vector3(...p).applyMatrix4(k.top()), P = [w.x, w.y, w.z];
  eBoulder(q, P, s, r, E.rock, 0.6);
  k.embers([p[0], p[1] - s, p[2]], 3, s, 0.6);
}
function eSteps(k, cx, cz, w, d, h, n, col = E.sand) { // terraced stepped platform
  for (let i = 0; i < n; i++) { const f = 1 - i / n * 0.45; k.add('stone', bbox(w * f, h, d * f, 0.08), eStone(col), [cx, h * (i + 0.5), cz]); k.add('glow', box(w * f + 0.02, 0.05, 0.05), E.sun, [cx, h * (i + 1) - 0.06, cz + d * f / 2], 0, 1, { fx: 3.6 }); }
}
function eColumn(k, p, h, r = 0.3) { k.add('stone', cyl(r, r * 1.1, h, 8), eStone(E.sand2), [p[0], p[1] + h / 2, p[2]]); k.add('gold', bbox(r * 2.6, 0.22, r * 2.6, 0.05), E.gold, [p[0], p[1] + h + 0.1, p[2]]); k.add('stone', bbox(r * 2.8, 0.25, r * 2.8, 0.06), eStone(), [p[0], p[1] + 0.12, p[2]]); }
function eMonolith(k, p, h, ry = 0) { k.add('stone', prism([[-0.5, 0], [0.5, 0], [0.35, h], [0, h + 0.5], [-0.35, h]], 0.6, 0.05), eStone(E.rock2), p, [0, ry, 0]); k.add('glow', box(0.08, h * 0.7, 0.62), E.sun, [p[0], p[1] + h * 0.5, p[2]], [0, ry, 0], 1, { fx: 3.3 }); }
function eBanner(k, p, h, w, ry = 0) { k.add('stone', cyl(0.12, 0.16, h, 6), eStone(E.sand2), [p[0], p[1] + h / 2, p[2]]); k.push(p, [0, ry, 0]); k.add('gold', box(0.1, 0.1, w + 0.2), E.gold, [0, h - 0.1, w / 2]); k.add('jacq', cloth(w, h * 0.5, 0.05, 0.08), E.red, [0, h - 0.15 - h * 0.25, w / 2], [0, PI / 2, 0], 1, { smooth: true }); eCrystal(k, [0, h, 0], 0.4, 0.18); k.pop(); }

function E_cc() { // temple grown from a red-rock mountainside, ancient tree, sun-disc firing a beam
  const k = new Kit('E'), r = rng(501);
  for (let i = 0; i < 12; i++) { const a = i / 12 * TAU + r() * 0.3, d = 6.2 + r() * 1.4; eBoulder(k, polar(d, a, 0.5), 1.2 + r() * 1.0, r, i % 3 ? E.rock : E.rock2); }
  k.add('stone', cyl(5.6, 7.6, 3.2, 9), eStone(E.rock), [0, 1.6, 0], [0, 0.3, 0]);           // mountainside mass
  for (let i = 0; i < 6; i++) { const a = i / 6 * TAU + 0.2; eBoulder(k, polar(5.6, a, 3.0), 1.3 + r() * 0.6, r, E.rock2, 1.2); }
  eSteps(k, 0.6, 0.6, 7.0, 7.0, 0.8, 4);                                                    // terraced temple on top (y 3.2 -> 6.4)
  k.push([0, 3.0, 0]);
  eSteps(k, 0.6, 0.6, 7.0, 7.0, 0.8, 4);
  k.pop();
  for (const [x, z] of [[3.0, 3.0], [3.0, -1.8], [-1.8, 3.0]]) eColumn(k, [x, 6.2, z], 2.4, 0.32);
  k.add('stone', bbox(3.6, 0.4, 3.6, 0.08), eStone(E.sand2), [0.6, 8.8, 0.6]);
  k.add('gold', cyl(0.01, 2.4, 1.6, 4), E.gold, [0.6, 9.8, 0.6], [0, PI / 4, 0]);
  ccBeacon(k, [-3.0, 6.4, 3.0], 0x5fd35f, 4.5, 'leaf');
  // sun disc + beam crowning the temple
  k.add('stone', cyl(0.5, 0.7, 2.6, 8), eStone(E.sand2), [0.6, 11.6, 0.6]);
  eSunDisc(k, [0.6, 13.5, 0.6], 1.8, 0.35, -0.6, 8);
  // ancient tree gripping the rock at the back
  eTree(k, [-3.6, 3.0, -3.4], 4.6, 1.6, r); eTree(k, [4.2, 2.0, -4.6], 3.0, 1.1, r); eTree(k, [-5.4, 1.2, 3.2], 2.6, 1.0, r);
  for (let i = 0; i < 5; i++) k.line('leaf', [-3.6, 3.4, -3.4], polar(6.6, PI + 0.6 + (i - 2) * 0.35, 0.3), 0.18, E.bark, 5);
  // stairway + gate on +X
  for (let i = 0; i < 5; i++) k.add('stone', bbox(1.0, 0.4, 3.0, 0.05), eStone(E.sand2), [7.4 - i * 0.6, 0.2 + i * 0.6, 0.6]);
  for (const z of [2.6, -1.4]) eMonolith(k, [7.6, 0, z], 3.2);
  // sun crystals clusters + floating fragments
  for (const [a, d] of [[0.7, 5.3], [2.4, 5.6], [4.1, 5.0], [5.5, 5.4]]) { const p = polar(d, a, 3.0); for (let j = 0; j < 3; j++) eCrystal(k, [p[0] + (j - 1) * 0.35, p[1], p[2]], 0.7 + j * 0.2, 0.25, (j - 1) * 0.4, j); }
  eFloat(k, [-4.2, 9.5, 3.2], 0.8, r); eFloat(k, [4.5, 8.4, -4.0], 0.65, r); eFloat(k, [-1.0, 12.6, -2.8], 0.5, r);
  for (const [p, ry] of [[[5.2, 0.5, 4.6], 0.4], [[5.0, 0.5, -4.4], -0.4], [[-6.4, 0.5, 1.8], PI]]) eBanner(k, p, 5.2, 1.2, ry);
  k.embers([0.6, 10.5, 0.6], 10, 3.0, 1.2);
  return fin(k.build(), 'cc', 13.5);
}
function E_barracks() { // terraced temple hall with columns and sun-disc facade
  const k = new Kit('E'), r = rng(511);
  for (let i = 0; i < 7; i++) eBoulder(k, polar(4.6 + r() * 0.6, i / 7 * TAU, 0.3), 0.8 + r() * 0.5, r);
  eSteps(k, 0, 0, 8.4, 6.8, 0.5, 2);
  k.add('stone', bbox(5.6, 3.0, 5.0, 0.1), eStone(), [-0.8, 2.5, 0]);
  for (const z of [-2.3, -0.8, 0.8, 2.3]) eColumn(k, [2.6, 1.0, z], 2.8, 0.26);
  k.add('stone', prism([[-3.6, 0], [3.6, 0], [0, 1.6]], 7.4, 0.08), eStone(E.rock), [0, 4.0, 0], [0, PI / 2, 0]);
  k.add('gold', box(7.6, 0.18, 0.3), E.gold, [0, 4.0, 3.55]); k.add('gold', box(7.6, 0.18, 0.3), E.gold, [0, 4.0, -3.55]);
  eSunDisc(k, [3.85, 4.6, 0], 0.75, 0, PI / 2);
  k.add('stone', box(0.2, 2.0, 1.8), 0x3a2418, [1.95, 2.0, 0]);
  k.add('glow', box(0.08, 1.8, 0.08), E.sun, [2.0, 2.0, 0.92], 0, 1, { fx: 3.2 }); k.add('glow', box(0.08, 1.8, 0.08), E.sun, [2.0, 2.0, -0.92], 0, 1, { fx: 3.6 });
  eTree(k, [-3.4, 1.0, 2.6], 2.4, 0.8, r);
  eMonolith(k, [3.6, 0.5, 3.2], 2.4); eMonolith(k, [3.6, 0.5, -3.2], 2.4);
  eBanner(k, [-3.6, 0.5, -3.0], 5.0, 1.0, PI);
  return fin(k.build(), 'barracks', 5.8);
}
function E_factory() { // rock-cut forge of light: great ring arch over a crystal shaper
  const k = new Kit('E'), r = rng(521);
  for (let i = 0; i < 8; i++) eBoulder(k, polar(5.0 + r() * 0.6, i / 8 * TAU, 0.3), 0.9 + r() * 0.6, r);
  eSteps(k, 0.3, 0, 10.0, 7.6, 0.4, 2);
  k.add('stone', bbox(4.6, 4.4, 7.0, 0.12), eStone(E.rock), [-2.6, 3.0, 0]);
  k.add('stone', bbox(0.4, 3.0, 5.0, 0.05), eStone(E.sand2), [-0.15, 2.3, 0]);
  k.add('stone', torus(3.0, 0.45, 6, 18), eStone(E.sand2), [2.3, 3.4, 0], [0, PI / 2, 0]);           // ring arch
  k.add('gold', torus(3.0, 0.12, 4, 24), E.gold, [2.6, 3.4, 0], [0, PI / 2, 0]);
  for (let i = 0; i < 8; i++) { const a = i / 8 * TAU; k.add('glow', box(0.12, 0.3, 0.3), E.sun, [2.75, 3.4 + Math.sin(a) * 3.0, Math.cos(a) * 3.0], 0, 1, { fx: 3 + i * 0.1 }); }
  k.add('stone', cyl(1.0, 1.3, 0.8, 8), eStone(), [2.3, 1.2, 0]);                                      // crystal shaper
  eCrystal(k, [2.3, 1.6, 0], 1.6, 0.6); k.add('beam', cyl(0.6, 0.2, 5.0, 10, true), E.sun, [2.3, 4.6, 0], 0, 1, { fx: 3.4, smooth: true });
  for (const z of [3.2, -3.2]) eColumn(k, [4.6, 0.8, z], 3.8, 0.3);
  eSunDisc(k, [-2.6, 6.2, 1.8], 1.0, 0.7, 0.5, 4);
  eTree(k, [-3.8, 5.2, -2.2], 1.8, 0.75, r);
  eFloat(k, [0.4, 7.4, -2.4], 0.6, r); eFloat(k, [3.8, 7.2, 2.0], 0.45, r);
  eBanner(k, [-4.9, 0.4, 3.4], 5.5, 1.1, PI);
  k.embers([2.3, 2.0, 0], 8, 1.5, 1);
  return fin(k.build(), 'factory', 7.4);
}
function eTowerBase(k, h, r) { for (let i = 0; i < 5; i++) eBoulder(k, polar(1.4, i / 5 * TAU, 0.2), 0.45, r); k.add('stone', cyl(1.05, 1.5, h, 7), eStone(), [0, h / 2, 0]); k.add('gold', cyl(1.1, 1.1, 0.14, 7), E.gold, [0, h - 0.1, 0]); k.add('glow', box(0.08, h * 0.7, 0.08), E.sun, [0, h * 0.45, 1.32], [-0.2, 0, 0], 1, { fx: 3.3 }); }
function E_turret_mg() { // sunbeam emitter pod: twin crystal prongs
  const k = new Kit('E'), r = rng(531); eTowerBase(k, 0.9, r);
  const g = k.build();
  const t = new Kit('E');
  t.add('stone', prism([[-0.7, 0], [0.5, 0], [0.8, 0.35], [0.5, 0.7], [-0.7, 0.7]], 1.1, 0.05), eStone(E.rock2), [0, 0, 0]);
  for (const s of [1, -1]) { t.add('gold', cyl(0.07, 0.09, 1.3, 6), E.gold, [1.2, 0.4, s * 0.2], [0, 0, -PI / 2]); t.add('glow', new T.OctahedronGeometry(1, 0), E.sun, [1.9, 0.4, s * 0.2], [0, 0, PI / 2], [0.1, 0.25, 0.1], { fx: 3.5 }); }
  eSunDisc(t, [-0.3, 0.95, 0], 0.32, 0.9, 0);
  const tur = t.build('turret'); tur.position.y = 0.9; g.add(tur);
  return fin(g, 'turret_mg', 2.0);
}
function E_turret_cannon() { // sunbeam obelisk: tall stone tower, rotating mirror head with crystal barrel
  const k = new Kit('E'), r = rng(541); eTowerBase(k, 2.2, r);
  const g = k.build();
  const t = new Kit('E');
  t.add('stone', prism([[-0.9, 0], [0.7, 0], [1.0, 0.4], [0.7, 0.85], [-0.8, 0.9]], 1.3, 0.05), eStone(E.sand2), [0, 0, 0]);
  t.add('gold', cyl(0.16, 0.2, 2.2, 8), E.gold, [1.9, 0.45, 0], [0, 0, -PI / 2]);
  for (let i = 0; i < 3; i++) t.add('glow', cyl(0.24, 0.24, 0.08, 8), E.sun, [1.3 + i * 0.6, 0.45, 0], [0, 0, -PI / 2], 1, { fx: 3 + i * 0.2 });
  t.add('glow', new T.OctahedronGeometry(1, 0), E.white, [3.15, 0.45, 0], [0, 0, PI / 2], [0.18, 0.4, 0.18], { fx: 3.6 });
  eSunDisc(t, [-0.5, 1.4, 0], 0.55, 0.7, 0);
  const tur = t.build('turret'); tur.position.y = 2.2; g.add(tur);
  return fin(g, 'turret_cannon', 3.6);
}
function E_artillery() { // fallback siege mount (no glTF)
  const k = new Kit('E'), r = rng(551); eSteps(k, 0, 0, 4.2, 4.2, 0.4, 2);
  const g = k.build();
  const t = new Kit('E');
  t.add('stone', cyl(1.2, 1.3, 0.3, 8), eStone(), [0, 0.15, 0]);
  t.push([0.3, 0.9, 0], [0, 0, 0.6]); t.add('stone', bbox(1.0, 0.6, 0.65, 0.05), eStone(E.rock2), [-0.1, 0, 0]); t.add('gold', cyl(0.22, 0.28, 3.6, 8), E.gold, [1.8, 0, 0], [0, 0, -PI / 2]); t.pop();
  const tur = t.build('turret'); tur.position.y = 0.8; g.add(tur);
  return fin(g, 'artillery', 3.0);
}
function E_artillery_gltf() { // stone-mounted siege piece (Poly Haven cannon)
  const k = new Kit('E'), r = rng(555);
  eSteps(k, 0, 0, 4.2, 4.2, 0.4, 2);
  for (const [x, z] of [[1.9, 1.9], [-1.9, 1.9], [1.9, -1.9], [-1.9, -1.9]]) eMonolith(k, [x, 0.4, z], 1.2);
  const g = k.build();
  const t = new Kit('E');
  t.add('stone', cyl(1.3, 1.35, 0.3, 8), eStone(E.rock2), [0, 0.15, 0]);
  t.add('gold', torus(1.3, 0.07, 4, 20), E.gold, [0, 0.3, 0], [PI / 2, 0, 0]);
  for (const sd of [1, -1]) t.add('stone', prism([[-0.9, 0], [1.0, 0], [0.7, 1.0], [-0.7, 1.1]], 0.2, 0.03), eStone(E.sand2), [0.1, 0.3, sd * 0.95]);
  eSunDisc(t, [-1.2, 1.4, 0], 0.45, 0.5, PI / 2);
  const tur = t.build('turret'); addCannon(tur, [-0.2, 0.75, 0], 1.9, 0.32);
  tur.position.y = 0.8; g.add(tur);
  return fin(g, 'artillery', 3.3);
}
function E_turret_cannon_gltf() { return E_turret_cannon(); }
function E_wall(variant) { // sandstone monolith slabs, moss crown, gold sun inlay
  const k = new Kit('E'), r = rng(561 + variant * 5);
  const mat = variant === 1 ? 'brick' : 'stone', col = variant === 1 ? 0xe0c0b0 : eStone(variant ? E.sand2 : E.sand);
  for (const x of [-1.35, 0, 1.35]) k.add(mat, prism([[-0.7, 0], [0.7, 0], [0.55, 1.9 + r() * 0.3], [-0.55, 1.95 + r() * 0.3]], 1.3, 0.05), col, [x, 0, 0], [0, PI / 2, (r() - 0.5) * 0.05]);
  for (const s of [1, -1]) { k.add('gold', box(3.9, 0.12, 0.06), E.gold, [0, 0.4, s * 0.66], [s * 0.08, 0, 0]); k.add('glow', cyl(0.18, 0.18, 0.04, 10), E.sun, [0, 1.15, s * 0.62], [PI / 2, 0, 0], 1, { fx: 3.4 }); }
  for (let i = 0; i < 4; i++) k.add('leaf', ico(0.4, 0), i % 2 ? E.moss : E.leaf, [-1.5 + i * 1.0, 2.05, (r() - 0.5) * 0.4], [r(), r(), r()], [1.1, 0.4, 1.4]);
  if (variant === 2) for (let i = 0; i < 3; i++) k.line('leaf', [-1.4 + i * 1.2, 2.0, 0.2], [-1.2 + i * 1.2, 0.0, 0.75], 0.07, E.bark, 4);
  eBoulder(k, [1.9, 0.2, 0.4], 0.45, r); eBoulder(k, [-1.9, 0.2, -0.5], 0.4, r);
  return fin(k.build(), 'wall', 2.3);
}
function eGuardian(k, p, s, ry) { // blocky stone guardian statue
  k.push(p, [0, ry, 0], s);
  k.add('stone', bbox(1.2, 0.6, 1.2, 0.06), eStone(E.rock2), [0, 0.3, 0]);
  for (const z of [0.3, -0.3]) k.add('stone', bbox(0.45, 1.4, 0.45, 0.06), eStone(), [0, 1.3, z]);
  k.add('stone', prism([[-0.5, 0], [0.5, 0], [0.6, 1.4], [-0.6, 1.5]], 1.2, 0.06), eStone(E.sand2), [0, 2.0, 0]);
  for (const z of [0.85, -0.85]) k.add('stone', bbox(0.4, 1.5, 0.4, 0.06), eStone(), [0.2, 2.6, z], [0, 0, 0.3]);
  k.add('stone', bbox(0.7, 0.7, 0.7, 0.08), eStone(E.rock), [0.05, 3.85, 0]);
  k.add('glow', box(0.06, 0.12, 0.45), E.sun, [0.42, 3.9, 0], 0, 1, { fx: 3.5 });
  k.add('gold', cone(0.25, 0.7, 4), E.gold, [0, 4.5, 0]);
  k.pop();
}
function E_gate() { // stone guardians flanking a sunlight barrier
  const k = new Kit('E'), r = rng(571);
  k.add('stone', bbox(2.0, 0.3, 6.6, 0.08), eStone(), [0, 0.15, 0]);
  eGuardian(k, [0, 0.3, 2.45], 1.2, 0); eGuardian(k, [0, 0.3, -2.45], 1.2, 0);
  k.add('gold', box(0.3, 0.3, 4.6), E.gold, [0, 5.4, 0]);
  eSunDisc(k, [0.2, 5.9, 0], 0.7, 0, PI / 2);
  k.add('beam', box(0.25, 4.6, 3.2), E.sun, [0, 2.65, 0], 0, 1, { fx: 3.1 });
  k.add('beam', box(0.06, 4.6, 3.2), E.white, [0.25, 2.65, 0], 0, 1, { fx: 3.7 });
  return fin(k.build(), 'gate', 6.3);
}
// --- vehicles: rock-striders / sun-gliders / stone-golem walker
function E_tank() { // stone-golem walker with a sun-crystal cannon
  const k = new Kit('E'), r = rng(581);
  for (const [x, z] of [[1.1, 0.95], [-1.1, 0.95], [1.1, -0.95], [-1.1, -0.95]]) { k.add('stone', bbox(0.7, 1.0, 0.6, 0.08), eStone(E.rock2), [x, 0.5, z]); k.add('stone', bbox(0.9, 0.25, 0.8, 0.06), eStone(), [x + 0.1, 0.12, z]); k.add('gold', box(0.72, 0.1, 0.62), E.gold, [x, 0.85, z]); }
  k.add('stone', prism([[-1.9, 0.9], [1.5, 0.9], [2.0, 1.25], [1.5, 1.7], [-1.6, 1.75], [-2.0, 1.3]], 2.0, 0.08), eStone(E.rock), [0, 0, 0]);
  k.add('glow', new T.OctahedronGeometry(1, 0), E.sun, [-1.95, 1.35, 0], 0, [0.2, 0.35, 0.35], { fx: 3.4 });
  for (const s of [1, -1]) { k.add('leaf', ico(0.35, 0), E.moss, [-0.8, 1.75, s * 0.75], [r(), r(), r()], [1.3, 0.4, 1]); k.add('gold', box(3.0, 0.1, 0.06), E.gold, [0, 1.3, s * 1.05]); }
  k.add('glow', box(0.06, 0.15, 0.5), E.sun, [1.9, 1.3, 0], [0, 0, 0.6]);
  const g = k.build();
  const t = new Kit('E');
  t.add('stone', prism([[-1.0, 0], [0.7, 0], [1.0, 0.3], [0.7, 0.65], [-0.9, 0.7]], 1.4, 0.06), eStone(E.sand2), [0, 0, 0]);
  t.add('gold', cyl(0.12, 0.15, 2.4, 8), E.gold, [2.0, 0.35, 0], [0, 0, -PI / 2]);
  t.add('glow', new T.OctahedronGeometry(1, 0), E.white, [3.3, 0.35, 0], [0, 0, PI / 2], [0.14, 0.3, 0.14], { fx: 3.6 });
  eSunDisc(t, [-0.5, 1.0, 0], 0.35, 0.8, 0);
  const tur = t.build('turret'); tur.position.set(-0.1, 1.75, 0); g.add(tur);
  return fin(g, 'tank', 2.6);
}
function E_raider() { // sun-glider: hovering wedge with gold sail-wings
  const k = new Kit('E');
  k.add('beam', cyl(1.2, 1.6, 0.05, 12), E.sun, [0, 0.08, 0], 0, [1.4, 1, 0.8], { fx: 3.3 });
  k.add('stone', prism([[-1.5, 0.5], [0.8, 0.45], [1.8, 0.6], [0.6, 0.95], [-1.3, 1.0]], 0.9, 0.06), eStone(E.rock2), [0, 0, 0]);
  for (const s of [1, -1]) k.add('gold', prism([[-1.3, 0], [0.6, 0], [-0.9, 0.1]], 0.05, 0.01), E.gold, [0, 0.95, s * 0.95], [s * -0.25, 0, 0], [1, 1, 1]), k.add('gold', box(1.6, 0.04, 1.2), E.gold, [-0.4, 0.98, s * 0.9], [s * 0.2, 0, 0]);
  k.add('glow', new T.OctahedronGeometry(1, 0), E.sun, [-1.4, 0.75, 0], 0, [0.2, 0.3, 0.3], { fx: 3.5 });
  k.add('gold', cyl(0.05, 0.05, 1.0, 6), E.gold, [1.2, 1.0, 0], [0, 0, -PI / 2]);
  k.add('glow', box(0.06, 0.08, 0.3), E.white, [1.8, 0.62, 0]);
  return fin(k.build(), 'raider', 1.4);
}
function E_harvester() { // rock-strider: six stone legs, crystal basket
  const k = new Kit('E'), r = rng(591);
  for (const x of [1.2, 0, -1.2]) for (const s of [1, -1]) { k.line('stone', [x, 1.0, s * 0.7], [x + 0.2, 0.0, s * 1.3], 0.18, E.rock2, 5); k.add('gold', sph(0.16, 6, 4), E.gold, [x, 1.0, s * 0.72]); }
  k.add('stone', bbox(3.8, 0.5, 1.6, 0.1), eStone(E.rock), [0, 1.15, 0]);
  k.add('stone', prism([[0.8, 1.3], [2.0, 1.3], [2.1, 1.7], [1.6, 2.2], [0.9, 2.3]], 1.4, 0.06), eStone(E.sand2), [0, 0, 0]);
  k.add('glow', box(0.05, 0.2, 1.0), E.sun, [1.86, 1.95, 0], [0, 0, 0.6], 1, { fx: 3.2 });
  for (let i = 0; i < 8; i++) k.line('leaf', polar(0.95, i / 8 * TAU, 1.4).map((v, j) => v + (j === 0 ? -0.7 : 0)), polar(1.2, i / 8 * TAU + 0.3, 2.4).map((v, j) => v + (j === 0 ? -0.7 : 0)), 0.05, E.bark, 4);
  k.add('leaf', torus(1.15, 0.08, 4, 12), E.bark, [-0.7, 2.4, 0], [PI / 2, 0, 0]);
  for (let i = 0; i < 6; i++) k.add('glow', ico(0.3, 0), i % 2 ? E.cyan : 0xbff6ff, [-0.7 + (r() - 0.5) * 1.2, 2.2 + r() * 0.2, (r() - 0.5) * 1.2], [r(), r(), r()], [0.7, 1.3, 0.7]);
  k.add('gold', prism([[2.0, 0.6], [2.6, 0.5], [2.4, 1.2], [2.0, 1.3]], 1.4, 0.04), E.gold, [0, 0, 0]);
  return fin(k.build(), 'harvester', 2.6);
}
function decorEarth(k, lx, lz, i, r, ry) {
  const t = i % 6;
  if (t === 0) eTree(k, [lx, 0, lz], 2.6 + r(), 0.9, r);
  else if (t === 1) { eMonolith(k, [lx, 0, lz], 3 + r() * 1.5, ry); eMonolith(k, [lx + 1.2, 0, lz + 0.6], 2 + r(), ry + 0.4); }
  else if (t === 2) { for (let j = 0; j < 4; j++) eCrystal(k, [lx + (r() - 0.5) * 1.4, 0, lz + (r() - 0.5) * 1.4], 0.6 + r() * 0.8, 0.22, (r() - 0.5) * 0.6, r() * 3); eBoulder(k, [lx, 0.2, lz], 0.6, r); }
  else if (t === 3) { k.add('stone', cyl(0.4, 0.55, 2.2, 7), eStone(E.sand2), [lx, 1.1, lz]); eSunDisc(k, [lx, 2.7, lz], 0.8, 0.5, ry, 6); }
  else if (t === 4) { eFloat(k, [lx, 3.2 + r() * 1.5, lz], 0.7, r); eBoulder(k, [lx + 0.6, 0.3, lz], 0.7, r); }
  else eBanner(k, [lx, 0, lz], 5.5, 1.2, ry);
}

// ======================================================================= STORM NOMADS (team 3)
// Sailcloth over bone-white steel ribs, tesla coils with arcing lightning, wind turbines, crimson banners.
const S = { bone: 0xe8e0cc, bone2: 0xc8bea6, grey: 0x5c6470, grey2: 0x3a4048, sand: 0xd8bf8a, cloth: 0xd9cdb0, crimson: 0xb0242a,
  volt: 0x9fe4ff, white: 0xeefaff, blue: 0x4aa8ff, cyan: 0x39d8ff };
function sailGeo(w, h, belly = 0.4) { // triangular sail in XY (luff along +Y at x=0), bellied along +Z
  return gc(`sail${w},${h},${belly}`, () => {
    const g = new T.PlaneGeometry(1, 1, 6, 8), p = g.attributes.position;
    for (let i = 0; i < p.count; i++) { const u = p.getX(i) + 0.5, v = p.getY(i) + 0.5, x = u * w * (1 - v * 0.92), y = v * h;
      p.setXYZ(i, x, y, belly * Math.sin(PI * u) * Math.sin(PI * Math.min(1, v * 1.1)) * w * 0.3); }
    g.computeVertexNormals(); return g;
  });
}
function sArc(k, a, b, n = 4) { // jagged lightning polyline, re-randomized in the shader (fx mode 6)
  const ph = Math.random() * 0.9;
  for (let i = 0; i < n; i++) {
    const t0 = i / n, t1 = (i + 1) / n, P = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    k.bar('glow', P(t0), P(t1), 0.07, i % 2 ? S.white : S.volt, { fx: 6 + ph });
  }
}
function sTesla(k, p, h, arcs = 4, s = 1) {
  k.push(p, [0, 0, 0], s);
  k.add('solid', cyl(0.5, 0.7, 0.4, 8), S.grey2, [0, 0.2, 0]);
  k.add('solid', cyl(0.14, 0.22, h, 8), S.bone, [0, h / 2, 0]);
  for (let i = 0; i < 4; i++) k.add('solid', torus(0.34 - i * 0.04, 0.06, 4, 12), S.grey, [0, h * 0.45 + i * h * 0.12, 0], [PI / 2, 0, 0]);
  k.add('glow', sph(0.38, 10, 6), S.volt, [0, h + 0.3, 0], 0, 1, { fx: 3.6, smooth: true });
  k.add('solid', torus(0.55, 0.08, 4, 16), S.bone, [0, h + 0.3, 0], [PI / 2, 0, 0]);
  for (let i = 0; i < arcs; i++) { const a = i / arcs * TAU + 0.4; sArc(k, [0, h + 0.3, 0], polar(1.4 + (i % 2) * 0.8, a, h - 0.6 - (i % 3) * 0.6), 4); }
  k.sparks([0, h + 0.3, 0], 5, 0.6);
  k.pop();
}
function sTurbine(k, p, h, R, ry = 0) { // mast + nacelle; rotor in a 'spin' sub-group (rotates about local X)
  k.push(p, [0, ry, 0]);
  k.add('solid', cyl(0.12, 0.3, h, 8), S.bone, [0, h / 2, 0]);
  k.add('solid', bbox(0.9, 0.4, 0.4, 0.08), S.grey, [-0.2, h, 0]);
  k.add('glow', box(0.06, 0.06, 0.3), S.blue, [-0.66, h, 0], 0, 1, { fx: 1.2 });
  k.pop();
  const c = Math.cos(ry), sn = Math.sin(ry);
  k.sub('spin', [p[0] + c * 0.3, p[1] + h, p[2] - sn * 0.3], [0, ry, 0], (q) => {
    q.add('solid', sph(0.18, 8, 5), S.bone2, [0, 0, 0]);
    for (let i = 0; i < 3; i++) { const a = i / 3 * TAU; q.add('solid', prism([[0, -0.05], [R, -0.12], [R, 0.04], [0, 0.14]], 0.05, 0), i ? S.bone : S.crimson, [0.06, 0, 0], [a, 0, 0], 1, { m: new T.Matrix4().makeRotationX(a).multiply(new T.Matrix4().makeRotationZ(PI / 2)).multiply(new T.Matrix4().makeRotationY(PI / 2)) }); }
  });
}
function sDome(k, p, R, h, col = S.cloth) { // sailcloth dome over bone ribs
  k.add('denim', gc(`dome${R}`, () => new T.SphereGeometry(1, 16, 7, 0, TAU, 0, PI / 2)), col, p, 0, [R, h, R], { smooth: true });
  for (let i = 0; i < 8; i++) { const a = i / 8 * TAU; let prev = null;
    for (let j = 0; j <= 5; j++) { const t = j / 5 * PI / 2, q = [p[0] + Math.sin(a) * Math.cos(t) * (R + 0.06), p[1] + Math.sin(t) * (h + 0.06), p[2] + Math.cos(a) * Math.cos(t) * (R + 0.06)];
      if (prev) k.bar('solid', prev, q, 0.14, S.bone); prev = q; } }
  k.add('solid', torus(R + 0.05, 0.12, 4, 24), S.bone2, [p[0], p[1] + 0.1, p[2]], [PI / 2, 0, 0]);
}
function sBanner(k, p, h, w, ry = 0) {
  k.add('solid', cyl(0.07, 0.09, h, 6), S.bone, [p[0], p[1] + h / 2, p[2]]);
  k.push(p, [0, ry, 0]);
  k.add('solid', box(0.08, 0.08, w + 0.2), S.bone2, [0, h - 0.1, w / 2]);
  k.add('jacq', cloth(w, h * 0.55, 0.05, 0.14), S.crimson, [0, h - 0.15 - h * 0.275, w / 2], [0, PI / 2, 0], 1, { smooth: true });
  k.add('glow', sph(0.12, 6, 4), S.volt, [0, h + 0.1, 0], 0, 1, { fx: 1.4 });
  k.pop();
}
function sSailTower(k, p, h, ry = 0, col = S.crimson) {
  k.add('solid', cyl(0.1, 0.18, h, 6), S.bone, [p[0], p[1] + h / 2, p[2]]);
  k.push(p, [0, ry, 0]);
  k.add('jacq', sailGeo(h * 0.45, h * 0.85, 0.5), col, [0.1, h * 0.1, 0], 0, 1, { smooth: true });
  k.bar('solid', [0, h * 0.12, 0], [h * 0.45, h * 0.12, 0], 0.07, S.bone2);
  k.pop();
}
function sDust(k, p, n = 3, s = 1.4) { k.haze(p, n, s); }

function S_cc() { // great sail-dome nomad hall, tesla spire, turbines, sail towers
  const k = new Kit('S'), r = rng(701);
  k.add('stone', cyl(7.8, 8.6, 0.6, 12), S.sand, [0, 0.3, 0]);
  k.add('solid', cyl(7.2, 7.4, 0.2, 12), S.grey2, [0, 0.65, 0]);
  for (let i = 0; i < 12; i++) { const a = i / 12 * TAU; k.add('solid', cyl(0.12, 0.16, 2.2, 6), S.bone, polar(7.5, a, 1.7)); if (i % 2) k.add('jacq', cloth(3.6, 1.2, 0.2, 0.06), i % 4 === 1 ? S.crimson : S.cloth, polar(7.4, a + PI / 12, 2.0), [0, a + PI / 12, 0], 1, { smooth: true }); }
  sDome(k, [0, 0.7, 0], 6.0, 5.2, S.cloth);
  k.add('jacq', gc('domeBand', () => new T.CylinderGeometry(1, 1, 1, 24, 1, true)), S.crimson, [0, 2.1, 0], 0, [6.02, 1.0, 6.02], { smooth: true });
  sDome(k, [0, 5.4, 0], 3.0, 2.6, S.grey);
  // lightning spire on top
  sTesla(k, [0, 7.9, 0], 8.0, 6, 1.1);
  k.add('solid', torus(6.1, 0.22, 4, 32), 0xffffff, [0, 0.9, 0], [PI / 2, 0, 0]); k.add('solid', torus(3.1, 0.16, 4, 24), 0xffffff, [0, 5.5, 0], [PI / 2, 0, 0]);
  ccBeacon(k, [3.6, 0.6, -3.6], 0xe8d27a, 7.0, 'solid');
  // door + awning on +X
  k.add('solid', bbox(1.4, 2.8, 3.0, 0.1), S.grey2, [6.2, 1.9, 0]);
  k.add('glow', box(0.08, 2.0, 2.0), S.volt, [6.92, 1.7, 0], 0, 1, { fx: 3.4 });
  k.add('jacq', sailGeo(3.0, 3.0, 0.3), S.crimson, [6.9, 3.3, -1.5], [0, 0, -PI / 2 + 0.2], 1, { smooth: true });
  // turbines + sail towers + small coils
  sTurbine(k, [-5.4, 0.6, -4.6], 7.5, 2.4, 0.3); sTurbine(k, [-6.2, 0.6, 3.4], 6.2, 2.0, -0.2);
  sSailTower(k, [4.6, 0.6, 5.2], 7.0, 0.6); sSailTower(k, [4.8, 0.6, -5.0], 6.0, -0.4, S.cloth);
  sTesla(k, [2.0, 0.6, 6.6], 3.2, 3, 0.8); sTesla(k, [-1.2, 0.6, -7.0], 3.2, 3, 0.8);
  for (const [pp, ry] of [[[6.8, 0.6, 3.0], 0.3], [[6.8, 0.6, -3.0], -0.3], [[-7.4, 0.6, -1.0], PI]]) sBanner(k, pp, 5.2, 1.3, ry);
  sDust(k, [0, 0.8, 7.5], 3, 1.6);
  return fin(k.build(), 'cc', 14);
}
function S_barracks() { // ribbed half-tube tent hall with crimson awning, coil
  const k = new Kit('S');
  k.add('stone', bbox(9.0, 0.3, 7.0, 0.08), S.sand, [0, 0.15, 0]);
  k.add('denim', gc('htube', () => new T.CylinderGeometry(1, 1, 1, 14, 1, true, -PI / 2, PI)), S.cloth, [-0.4, 0.3, 0], [0, 0, PI / 2], [3.1, 7.4, 3.1], { smooth: true });
  for (let x = -4.0; x <= 3.3; x += 1.2) for (let j = 0; j < 6; j++) { const t0 = j / 6 * PI, t1 = (j + 1) / 6 * PI; k.bar('solid', [x, 0.3 + Math.sin(t0) * 3.15, Math.cos(t0) * 3.15], [x, 0.3 + Math.sin(t1) * 3.15, Math.cos(t1) * 3.15], 0.14, S.bone); }
  k.add('jacq', cloth(7.4, 0.8, 0.05, 0.04), S.crimson, [-0.4, 2.3, 2.45], [0, 0, 0], [1, 1, 1], { smooth: true });
  k.add('jacq', cloth(7.4, 0.8, 0.05, 0.04), S.crimson, [-0.4, 2.3, -2.45], [0, PI, 0], [1, 1, 1], { smooth: true });
  k.add('solid', bbox(0.5, 2.6, 2.6, 0.08), S.grey2, [3.4, 1.6, 0]);
  k.add('glow', box(0.06, 2.0, 1.8), S.volt, [3.67, 1.35, 0], 0, 1, { fx: 3.2 });
  k.push([3.7, 2.9, 0], [0, 0, -0.35]); k.add('jacq', cloth(1.8, 3.6, 0.15, 0.03), S.crimson, [0.9, 0, 0], [-PI / 2, 0, 0], [1, 1, 1], { smooth: true }); k.pop();
  sTesla(k, [-3.6, 0.3, 2.6], 3.6, 3, 0.9);
  sBanner(k, [4.2, 0.3, 2.8], 4.8, 1.0, 0.3); sBanner(k, [4.2, 0.3, -2.8], 4.8, 1.0, -0.3);
  sTurbine(k, [-4.0, 0.3, -2.6], 5.4, 1.5, 0);
  return fin(k.build(), 'barracks', 5.6);
}
function S_factory() { // sail-roofed hangar w/ open bay, crane mast with sail, turbine
  const k = new Kit('S');
  k.add('stone', bbox(11, 0.3, 8.4, 0.08), S.sand, [0.3, 0.15, 0]);
  for (const x of [-4.8, -2.4, 0, 2.4, 4.6]) for (const z of [-3.5, 3.5]) k.add('solid', cyl(0.14, 0.2, 4.8, 6), S.bone, [x, 2.7, z]);
  for (const x of [-4.8, -2.4, 0, 2.4, 4.6]) { k.bar('solid', [x, 5.1, -3.6], [x, 6.6, 0], 0.16, S.bone); k.bar('solid', [x, 6.6, 0], [x, 5.1, 3.6], 0.16, S.bone); }
  k.push([-0.1, 5.85, 1.8], [0.4, 0, 0]); k.add('denim', cloth(9.8, 4.0, 0.3, 0.04), S.cloth, [0, 0, 0], [-PI / 2, 0, 0], 1, { smooth: true }); k.pop();
  k.push([-0.1, 5.85, -1.8], [-0.4, 0, 0]); k.add('denim', cloth(9.8, 4.0, 0.3, 0.04), S.grey, [0, 0, 0], [-PI / 2, 0, 0], 1, { smooth: true }); k.pop();
  k.add('solid', bbox(4.6, 4.2, 7.0, 0.1), S.grey2, [-2.6, 2.4, 0]);
  for (const z of [-2.4, 0, 2.4]) k.add('glow', box(0.06, 2.8, 0.1), S.volt, [-0.28, 2.2, z], 0, 1, { fx: 3 + z * 0.1 });
  for (const s2 of [1, -1]) k.add('jacq', cloth(4.4, 2.0, 0.1, 0.05), S.crimson, [2.4, 3.7, s2 * 3.52], [0, s2 > 0 ? 0 : PI, 0], 1, { smooth: true });
  // crane mast with sail
  k.add('solid', cyl(0.16, 0.26, 8.0, 6), S.bone, [5.4, 4.0, 3.4]);
  k.bar('solid', [5.4, 7.6, 3.4], [5.4, 7.2, -1.0], 0.14, S.bone2);
  k.line('solid', [5.4, 7.2, -1.0], [5.4, 3.0, -1.0], 0.03, S.grey, 4);
  k.add('solid', bbox(1.2, 0.8, 1.2, 0.08), S.grey, [5.4, 2.6, -1.0]);
  k.add('jacq', sailGeo(2.6, 5.5, 0.4), S.crimson, [5.4, 1.4, 3.4], [0, PI / 2, 0], 1, { smooth: true });
  sTurbine(k, [-4.6, 0.3, -3.6], 8.0, 2.2, 0); sTesla(k, [-4.4, 4.5, 2.4], 2.6, 3, 0.8);
  sDust(k, [5.6, 0.5, 0], 3, 1.6);
  return fin(k.build(), 'factory', 7.6);
}
function sPodBase(k, h) {
  k.add('stone', cyl(1.5, 1.75, 0.35, 10), S.sand, [0, 0.17, 0]);
  for (let i = 0; i < 3; i++) { const a = i / 3 * TAU; k.bar('solid', polar(1.35, a, 0.3), polar(0.35, a, h), 0.16, S.bone); }
  k.add('solid', cyl(0.5, 0.6, 0.3, 8), S.grey2, [0, h, 0]);
  k.add('glow', torus(1.4, 0.04, 3, 20), S.volt, [0, 0.38, 0], [PI / 2, 0, 0], 1, { fx: 3.3 });
}
function S_turret_mg() { // arc-gun pod on a bone tripod
  const k = new Kit('S'); sPodBase(k, 0.9);
  const g = k.build();
  const t = new Kit('S');
  t.add('solid', sph(0.6, 10, 6), S.bone, [0, 0.4, 0], 0, [1.2, 0.75, 0.95]);
  t.add('jacq', cloth(1.2, 0.5, 0.05, 0), S.crimson, [-0.1, 0.45, 0.58], 0, 1, { smooth: true });
  for (const s2 of [1, -1]) { t.add('solid', cyl(0.06, 0.08, 1.3, 6), S.grey2, [1.1, 0.4, s2 * 0.18], [0, 0, -PI / 2]); for (let i = 0; i < 3; i++) t.add('glow', torus(0.1, 0.025, 3, 8), S.volt, [0.8 + i * 0.3, 0.4, s2 * 0.18], [0, PI / 2, 0], 1, { fx: 3 + i * 0.2 }); }
  sArc(t, [1.75, 0.4, 0.18], [1.75, 0.4, -0.18], 2);
  const tur = t.build('turret'); tur.position.y = 1.05; g.add(tur);
  return fin(g, 'turret_mg', 2.0);
}
function S_turret_cannon() { // lightning tower: lattice mast + coil-barrel head
  const k = new Kit('S');
  k.add('stone', cyl(1.5, 1.75, 0.35, 10), S.sand, [0, 0.17, 0]);
  for (let i = 0; i < 4; i++) { const a = i / 4 * TAU + PI / 4; k.bar('solid', polar(1.2, a, 0.3), polar(0.5, a, 2.4), 0.14, S.bone); k.bar('solid', polar(1.0, a, 0.9), polar(0.8, a + PI / 2, 1.6), 0.07, S.bone2); }
  k.add('solid', cyl(0.75, 0.75, 0.2, 8), S.grey2, [0, 2.4, 0]);
  k.add('jacq', cloth(1.0, 1.6, 0.05, 0.1), S.crimson, polar(1.0, PI / 2, 1.3), [0, PI / 2, 0], 1, { smooth: true });
  const g = k.build();
  const t = new Kit('S');
  t.add('solid', prism([[-0.9, 0], [0.6, 0], [0.9, 0.35], [0.6, 0.75], [-0.8, 0.8]], 1.2, 0.06), S.bone, [0, 0, 0]);
  t.add('solid', cyl(0.13, 0.15, 2.2, 8), S.grey2, [1.9, 0.4, 0], [0, 0, -PI / 2]);
  for (let i = 0; i < 4; i++) t.add('solid', torus(0.24, 0.05, 4, 10), S.bone2, [1.2 + i * 0.45, 0.4, 0], [0, PI / 2, 0]);
  t.add('glow', sph(0.22, 8, 6), S.volt, [3.05, 0.4, 0], 0, 1, { fx: 3.6, smooth: true });
  sArc(t, [3.05, 0.4, 0], [2.0, 0.9, 0.4], 3); sArc(t, [3.05, 0.4, 0], [2.2, -0.1, -0.4], 3);
  const tur = t.build('turret'); tur.position.y = 2.5; g.add(tur);
  return fin(g, 'turret_cannon', 3.6);
}
function S_artillery() { // storm mortar: wide ring base, tall angled coil-howitzer
  const k = new Kit('S');
  k.add('stone', bbox(4.2, 0.35, 4.2, 0.1), S.sand, [0, 0.17, 0]);
  for (const [x, z] of [[1.7, 1.7], [-1.7, 1.7], [1.7, -1.7], [-1.7, -1.7]]) k.add('solid', cyl(0.1, 0.14, 2.2, 6), S.bone, [x, 1.3, z]);
  k.add('glow', torus(1.9, 0.04, 3, 24), S.volt, [0, 0.4, 0], [PI / 2, 0, 0], 1, { fx: 3.2 });
  const g = k.build();
  const t = new Kit('S');
  t.add('solid', cyl(1.3, 1.4, 0.3, 10), S.grey2, [0, 0.15, 0]);
  for (const s2 of [1, -1]) t.add('jacq', sailGeo(1.6, 1.6, 0.2), S.crimson, [-0.6, 0.3, s2 * 0.7], 0, 1, { smooth: true });
  t.push([0.2, 1.0, 0], [0, 0, 0.6]);
  t.add('solid', bbox(1.0, 0.6, 0.6, 0.06), S.bone, [-0.1, 0, 0]);
  t.add('solid', cyl(0.22, 0.26, 3.6, 8), S.grey2, [1.8, 0, 0], [0, 0, -PI / 2]);
  for (let i = 0; i < 5; i++) t.add('glow', torus(0.3, 0.04, 3, 10), S.volt, [0.8 + i * 0.6, 0, 0], [0, PI / 2, 0], 1, { fx: 3 + i * 0.15 });
  t.pop();
  const tur = t.build('turret'); tur.position.y = 0.35; g.add(tur);
  return fin(g, 'artillery', 3.2);
}
function S_wall(variant) { // swirling sand wall: bone posts, taut sailcloth, sand drift, dust
  const k = new Kit('S'), r = rng(711 + variant * 3);
  k.add('stone', prism([[-0.9, 0], [0.9, 0], [0.3, 1.1], [-0.4, 1.0]], 4.0, 0.05), S.sand, [0, 0, 0], [0, PI / 2, 0]);
  for (const x of [-1.9, 0, 1.9]) k.add('solid', cyl(0.1, 0.14, 2.4, 6), S.bone, [x, 1.2, 0]);
  for (const s2 of [1, -1]) k.add('jacq', cloth(1.9, 1.2, 0.12, 0.05), variant === 1 ? S.cloth : S.crimson, [s2 * 0.95, 1.65, 0], [0, 0, 0], 1, { smooth: true });
  k.bar('solid', [-2.0, 2.3, 0], [2.0, 2.3, 0], 0.1, S.bone2);
  k.add('glow', box(3.8, 0.04, 0.04), S.volt, [0, 2.38, 0], 0, 1, { fx: 3.5 });
  sDust(k, [r() * 2 - 1, 0.6, 0.8], 2, 1.4);
  return fin(k.build(), 'wall', 2.4);
}
function S_gate() { // tesla pylons with an electric curtain
  const k = new Kit('S');
  k.add('stone', bbox(2.0, 0.3, 6.6, 0.08), S.sand, [0, 0.15, 0]);
  for (const s2 of [1, -1]) {
    for (let i = 0; i < 3; i++) { const a = i / 3 * TAU; k.bar('solid', polar(0.9, a, 0.3).map((v, j) => v + (j === 2 ? s2 * 2.5 : 0)), [0, 5.2, s2 * 2.5], 0.16, S.bone); }
    for (let i = 0; i < 4; i++) k.add('solid', torus(0.45 - i * 0.05, 0.07, 4, 12), S.grey, [0, 3.4 + i * 0.4, s2 * 2.5], [PI / 2, 0, 0]);
    k.add('glow', sph(0.42, 10, 6), S.volt, [0, 5.5, s2 * 2.5], 0, 1, { fx: 3.6, smooth: true });
    sBanner(k, [0.6, 0.3, s2 * 3.2], 3.6, 0.8, s2 > 0 ? 0 : PI);
  }
  k.add('energy', box(0.2, 4.6, 4.4), S.blue, [0, 2.7, 0], 0, 1, { fx: 3.1 });
  for (let i = 0; i < 3; i++) sArc(k, [0, 5.5, 2.5], [0, 5.5 - i * 1.6, -2.5], 6);
  return fin(k.build(), 'gate', 6.0);
}
// vehicles: land-yacht raider, storm-runner tank, sail-hauler harvester
function sWheel(k, x, z, r, w) { k.add('solid', cyl(r, r, w, 10), S.grey2, [x, r, z], [PI / 2, 0, 0]); k.add('solid', cyl(r * 0.55, r * 0.55, w + 0.04, 8), S.bone, [x, r, z], [PI / 2, 0, 0]); k.add('glow', torus(r * 0.75, 0.03, 3, 12), S.volt, [x, r, z + Math.sign(z) * (w / 2 + 0.02)], 0, 1, { fx: 3.4 }); }
function S_raider() { // land-yacht with a huge sail
  const k = new Kit('S');
  sWheel(k, 1.5, 0, 0.32, 0.2); sWheel(k, -0.9, 1.05, 0.42, 0.25); sWheel(k, -0.9, -1.05, 0.42, 0.25);
  k.add('solid', prism([[-1.4, 0.4], [1.2, 0.35], [1.9, 0.5], [1.2, 0.7], [-1.3, 0.75]], 0.6, 0.05), S.bone, [0, 0, 0]);
  k.bar('solid', [-0.9, 0.55, -1.05], [-0.9, 0.55, 1.05], 0.12, S.bone2);
  k.add('solid', cyl(0.05, 0.07, 3.4, 6), S.bone, [0.2, 2.4, 0]);
  k.add('jacq', sailGeo(1.8, 3.0, 0.5), S.crimson, [0.25, 0.85, 0], [0, PI, 0], 1, { smooth: true });
  k.bar('solid', [0.2, 0.9, 0], [-1.6, 0.9, 0], 0.05, S.bone2);
  k.add('glow', box(0.06, 0.08, 0.2), S.white, [1.88, 0.55, 0]);
  sArc(k, [-1.3, 0.75, 0], [-1.6, 0.3, 0.4], 2);
  k.add('solid', cyl(0.04, 0.04, 0.9, 6), S.grey2, [1.0, 0.95, 0], [0, 0, -PI / 2]);
  return fin(k.build(), 'raider', 3.6);
}
function S_tank() { // low storm-runner: armored wedge, tesla turret
  const k = new Kit('S');
  for (const x of [1.3, 0, -1.3]) for (const z of [1.15, -1.15]) sWheel(k, x, z, 0.42, 0.35);
  k.add('solid', prism([[-2.2, 0.35], [1.7, 0.35], [2.35, 0.55], [1.6, 1.0], [-2.0, 1.05], [-2.3, 0.75]], 1.9, 0.06), S.grey, [0, 0, 0]);
  for (const s2 of [1, -1]) { k.add('solid', prism([[-2.0, 0], [1.6, 0], [1.3, 0.1], [-1.8, 0.12]], 0.4, 0.02), S.bone, [0, 1.0, s2 * 0.75]); k.add('jacq', cloth(2.6, 0.4, 0.02, 0), S.crimson, [-0.2, 0.75, s2 * 0.97], [0, s2 > 0 ? 0 : PI, 0], 1, { smooth: true }); }
  for (let i = 0; i < 3; i++) k.add('glow', box(0.07, 0.04, 1.2), S.volt, [-1.9 + i * 0.25, 1.06, 0], 0, 1, { fx: 3 + i * 0.2 });
  k.spike('solid', [2.2, 0.55, 0], [1, 0, 0], 0.6, 0.15, S.bone2);
  k.add('glow', box(0.06, 0.1, 0.4), S.white, [2.0, 0.8, 0.6], [0, 0, 0.5]); k.add('glow', box(0.06, 0.1, 0.4), S.white, [2.0, 0.8, -0.6], [0, 0, 0.5]);
  const g = k.build();
  const t = new Kit('S');
  t.add('solid', prism([[-1.1, 0], [0.7, 0], [1.05, 0.3], [0.7, 0.62], [-0.9, 0.66]], 1.4, 0.05), S.bone, [0, 0, 0]);
  t.add('solid', cyl(0.11, 0.13, 2.4, 8), S.grey2, [2.0, 0.32, 0], [0, 0, -PI / 2]);
  for (let i = 0; i < 4; i++) t.add('solid', torus(0.2, 0.04, 4, 10), S.bone2, [1.2 + i * 0.45, 0.32, 0], [0, PI / 2, 0]);
  t.add('glow', sph(0.18, 8, 6), S.volt, [3.25, 0.32, 0], 0, 1, { fx: 3.6, smooth: true });
  sArc(t, [3.25, 0.32, 0], [2.3, 0.75, 0.3], 3);
  t.add('solid', cyl(0.04, 0.05, 1.4, 4), S.bone, [-0.7, 1.3, -0.4]); t.add('glow', sph(0.1, 6, 4), S.volt, [-0.7, 2.0, -0.4], 0, 1, { fx: 1.3 });
  const tur = t.build('turret'); tur.position.set(-0.2, 1.05, 0); g.add(tur);
  return fin(g, 'tank', 2.1);
}
function S_harvester() { // sail-hauler: 6 wheels, crystal hopper, cargo sail
  const k = new Kit('S'), r = rng(731);
  k.add('solid', bbox(4.0, 0.35, 1.6, 0.06), S.grey2, [0, 0.72, 0]);
  for (const x of [1.3, 0.05, -1.2]) for (const s2 of [1, -1]) sWheel(k, x, s2 * 1.05, 0.48, 0.35);
  k.add('solid', prism([[0.5, 0.9], [1.9, 0.9], [2.0, 1.4], [1.6, 2.0], [0.6, 2.05]], 1.6, 0.06), S.bone, [0, 0, 0]);
  k.add('glow', box(0.05, 0.3, 1.3), S.volt, [1.8, 1.7, 0], [0, 0, 0.6], 1, { fx: 3.2 });
  k.add('solid', cyl(1.2, 0.85, 1.2, 8), S.grey, [-0.8, 1.6, 0]);
  for (let i = 0; i < 6; i++) k.add('glow', ico(0.3, 0), i % 2 ? S.cyan : 0xbff6ff, [-0.8 + (r() - 0.5) * 1.2, 2.15 + r() * 0.2, (r() - 0.5) * 1.2], [r(), r(), r()], [0.7, 1.3, 0.7]);
  k.add('solid', cyl(0.05, 0.07, 3.0, 6), S.bone, [0.4, 3.0, 0]);
  k.add('jacq', sailGeo(1.6, 2.4, 0.4), S.crimson, [0.42, 1.9, 0], [0, PI, 0], 1, { smooth: true });
  k.add('solid', prism([[1.9, 0.25], [2.5, 0.15], [2.6, 0.35], [2.1, 0.9], [1.9, 0.9]], 1.8, 0.04), S.grey2, [0, 0, 0]);
  return fin(k.build(), 'harvester', 3.5);
}
function decorStorm(k, lx, lz, i, r, ry) {
  const t = i % 6;
  if (t === 0) sTurbine(k, [lx, 0, lz], 6 + r() * 2, 1.8, ry * 0.2);
  else if (t === 1) sTesla(k, [lx, 0, lz], 3.4, 3, 0.9);
  else if (t === 2) sSailTower(k, [lx, 0, lz], 5.5, ry);
  else if (t === 3) { sDome(k, [lx, 0, lz], 1.8, 1.4, i % 2 ? S.cloth : S.grey); sDust(k, [lx, 0.4, lz + 1.6], 2, 1.2); }
  else if (t === 4) sBanner(k, [lx, 0, lz], 5.2, 1.2, ry);
  else { k.add('stone', prism([[-2, 0], [2, 0], [0.4, 0.9], [-0.6, 0.8]], 1.6, 0.05), S.sand, [lx, 0, lz], [0, ry, 0]); for (let j = 0; j < 3; j++) k.add('solid', bbox(0.7, 0.5, 0.5, 0.06), j % 2 ? S.grey : S.bone2, [lx + j * 0.8 - 0.8, 0.25, lz + 1.2], [0, r(), 0]); }
}

// ======================================================================= VANGUARD: INDUSTRIAL (team 0)
// Riveted steel + poured concrete, steel-blue panels, hazard stripes, smokestacks, cranes, sodium floodlights.
const I = { blue: 0x2f6fa8, blue2: 0x285a88, conc: 0xc8ccd0, conc2: 0xa4a8ac, steel: 0x4a5058, dark: 0x2a2e33, yellow: 0xe8b420, tire: 0x1c1c1e,
  rust: 0xc0a090, sodium: 0xffa040, cyan: 0x39d8ff, beacon: 0x3a8cff, red: 0xff3020, white: 0xfff0d8 };
function hazTex() {
  if (TEX.haz) return TEX.haz;
  const [c, g] = canvas(128, 128); g.fillStyle = '#e8b420'; g.fillRect(0, 0, 128, 128); g.fillStyle = '#1a1a1a';
  for (let k = -2; k < 4; k++) { g.beginPath(); g.moveTo(k * 64, 128); g.lineTo(k * 64 + 32, 128); g.lineTo(k * 64 + 160, 0); g.lineTo(k * 64 + 128, 0); g.fill(); }
  blotches(g, rng(3), 40, '30,20,10', 0.1, 10);
  return (TEX.haz = texFrom(c));
}
function iHaz(k, p, w, h, d, r = [0, 0, 0]) { k.add('haz', box(w, h, d), 0xffffff, p, r); }
function iLight(k, p, col = I.sodium, s = 0.3, fx = 0) { k.add('glow', box(s, s * 0.5, s), col, p, 0, 1, { fx }); }
function iBeacon(k, p) { k.add('steel', cyl(0.12, 0.14, 0.15, 8), I.dark, p); k.add('glow', sph(0.14, 8, 5), I.beacon, [p[0], p[1] + 0.16, p[2]], 0, 1, { fx: 1 + Math.random() * 0.9, smooth: true }); }
function iFlood(k, p, h, ry = 0) { // sodium floodlight pole
  k.add('conc', cyl(0.3, 0.35, 0.4, 8), I.conc2, [p[0], p[1] + 0.2, p[2]]);
  k.add('steel', cyl(0.07, 0.1, h, 6), I.steel, [p[0], p[1] + h / 2, p[2]]);
  k.push([p[0], p[1] + h, p[2]], [0, ry, 0]);
  k.add('steel', box(0.9, 0.1, 0.1), I.dark, [0, 0, 0]);
  for (const x of [-0.35, 0.35]) { k.add('steel', box(0.3, 0.22, 0.3), I.dark, [x, 0.1, 0], [0, 0, 0.4]); k.add('glow', box(0.22, 0.05, 0.24), I.sodium, [x + 0.05, -0.02, 0], [0, 0, 0.4], 1, { fx: 3.9 }); }
  k.pop();
}
function iStack(k, p, h, r = 0.55) { // concrete/steel smokestack with grey smoke
  k.add('conc', cyl(r * 0.8, r * 1.15, h, 12), I.conc, [p[0], p[1] + h / 2, p[2]]);
  for (const t of [0.82, 0.9]) iHazRing(k, [p[0], p[1] + h * t, p[2]], r * (1.15 - t * 0.35) + 0.04);
  k.add('steel', cyl(r * 0.85, r * 0.8, 0.3, 12), I.dark, [p[0], p[1] + h + 0.1, p[2]]);
  k.add('glow', sph(0.1, 6, 4), I.red, [p[0] + r * 0.8, p[1] + h - 0.2, p[2]], 0, 1, { fx: 1.5, smooth: true });
  k.smoke([p[0], p[1] + h + 0.4, p[2]], 6, 1.3);
}
function iHazRing(k, p, r) { k.add('haz', cyl(r, r, 0.35, 12, true), 0xffffff, p, 0, 1, { smooth: true }); }
function iPipe(k, a, b, r = 0.14, col = I.steel) { k.line('steel', a, b, r, col, 8); for (const t of [0.15, 0.85]) k.line('steel', [a[0] + (b[0] - a[0]) * (t - 0.02), a[1] + (b[1] - a[1]) * (t - 0.02), a[2] + (b[2] - a[2]) * (t - 0.02)], [a[0] + (b[0] - a[0]) * (t + 0.02), a[1] + (b[1] - a[1]) * (t + 0.02), a[2] + (b[2] - a[2]) * (t + 0.02)], r * 1.35, I.dark, 8); }
function iCrane(k, p, h, len, ry = 0) { // yellow lattice tower crane
  k.push(p, [0, ry, 0]);
  k.add('conc', bbox(1.4, 0.5, 1.4, 0.06), I.conc2, [0, 0.25, 0]);
  for (const [x, z] of [[0.35, 0.35], [-0.35, 0.35], [0.35, -0.35], [-0.35, -0.35]]) k.bar('steel', [x, 0.5, z], [x, h, z], 0.09, I.yellow);
  for (let y = 0.5; y < h - 0.5; y += 0.9) for (const s of [1, -1]) { k.bar('steel', [0.35 * s, y, 0.35], [-0.35 * s, y + 0.9, 0.35], 0.04, I.yellow); k.bar('steel', [0.35, y, 0.35 * s], [0.35, y + 0.9, -0.35 * s], 0.04, I.yellow); }
  k.add('steel', bbox(0.9, 0.7, 0.9, 0.05), I.blue, [0, h + 0.3, 0]);
  k.add('glow', box(0.92, 0.18, 0.5), I.cyan, [0.1, h + 0.4, 0.2]);
  k.bar('steel', [-len * 0.3, h + 0.8, 0], [len, h + 0.8, 0], 0.3, I.yellow);
  k.bar('steel', [0, h + 1.8, 0], [len * 0.7, h + 0.85, 0], 0.05, I.steel); k.bar('steel', [0, h + 1.8, 0], [-len * 0.3, h + 0.85, 0], 0.05, I.steel);
  k.bar('steel', [0, h + 0.6, 0], [0, h + 1.9, 0], 0.12, I.yellow);
  k.add('conc', bbox(0.9, 0.7, 0.8, 0.05), I.conc2, [-len * 0.28, h + 0.5, 0]);
  k.line('steel', [len * 0.75, h + 0.7, 0], [len * 0.75, h * 0.45, 0], 0.025, I.dark, 4);
  k.add('haz', box(0.35, 0.35, 0.35), 0xffffff, [len * 0.75, h * 0.45 - 0.2, 0]);
  k.add('glow', sph(0.12, 6, 4), I.red, [len, h + 1.0, 0], 0, 1, { fx: 1.2, smooth: true });
  k.pop();
}
function iRadar(k, p, R = 1.4) { // spinning radar dish (sub-group 'spinY')
  k.add('steel', cyl(0.15, 0.25, 1.0, 8), I.dark, [p[0], p[1] + 0.5, p[2]]);
  k.sub('spinY', [p[0], p[1] + 1.0, p[2]], [0, 0, 0], (q) => {
    q.add('steel', bbox(0.4, 0.3, 0.4, 0.05), I.steel, [0, 0.1, 0]);
    q.add('steel', gc('dish', () => new T.CylinderGeometry(1, 0.2, 0.45, 14, 1, true)), 0xc8ccd0, [0.2, 0.8, 0], [0, 0, -1.2], [R, 1, R], { smooth: true });
    q.bar('steel', [0.2, 0.6, 0], [1.0, 1.1, 0], 0.05, I.dark);
  });
}
function iContainer(k, p, ry, L, col, s = 1) {
  k.push(p, [0, ry, 0], s);
  k.add('corr', box(L, 2.4, 2.4), col, [0, 1.2, 0], [0, 0, 0]);
  for (const x of [-L / 2, L / 2]) for (const z of [-1.2, 1.2]) k.add('steel', box(0.16, 2.44, 0.16), I.dark, [x, 1.2, z]);
  for (const z of [-0.45, 0.45]) k.add('steel', box(0.06, 2.2, 0.06), I.steel, [L / 2 + 0.04, 1.2, z]);
  k.pop();
}
function iDrum(k, p, col = I.blue, tilt = 0) { k.add('steel', cyl(0.34, 0.34, 0.9, 10), col, [p[0], p[1] + 0.45, p[2]], [tilt, 0, 0]); for (const y of [0.25, 0.65]) k.add('steel', cyl(0.36, 0.36, 0.05, 10), I.dark, [p[0], p[1] + y, p[2]], [tilt, 0, 0]); }
function iRazor(k, a, b) {
  const A = new T.Vector3(...a), B = new T.Vector3(...b), L = A.distanceTo(B), n = Math.max(2, (L / 0.18) | 0), d = B.clone().sub(A).normalize();
  const q = new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 0, 1), d);
  for (let i = 0; i < n; i++) { const p = A.clone().addScaledVector(d, (i + 0.5) * L / n); k.addM('steel', torus(0.22, 0.02, 3, 8), 0x9aa0a8, new T.Matrix4().compose(p, q.clone().multiply(new T.Quaternion().setFromEuler(new T.Euler(0.3, 0, i))), new T.Vector3(1, 1, 1))); }
}
function iTracks(k, len, z, h, w) {
  for (const s of [1, -1]) {
    k.add('steel', prism([[-len / 2 + 0.2, 0.04], [len / 2 - 0.2, 0.04], [len / 2 + 0.15, h * 0.5], [len / 2 - 0.1, h], [-len / 2 + 0.1, h], [-len / 2 - 0.15, h * 0.5]], w, 0.04), I.tire, [0, 0, s * z]);
    for (let x = -len / 2 + 0.05; x <= len / 2 - 0.05; x += 0.24) k.add('steel', box(0.08, 0.05, w + 0.05), I.steel, [x, h + 0.02, s * z]);
    for (let i = 0; i < 6; i++) { const x = -len / 2 + 0.45 + i * (len - 0.9) / 5; k.add('steel', cyl(0.28, 0.28, 0.1, 10), I.steel, [x, 0.36, s * (z + w / 2 + 0.03)], [PI / 2, 0, 0]); k.add('steel', cyl(0.1, 0.1, 0.14, 6), I.dark, [x, 0.36, s * (z + w / 2 + 0.06)], [PI / 2, 0, 0]); }
  }
}
function iWheel(k, x, z, r, w) { k.add('steel', cyl(r, r, w, 12), I.tire, [x, r, z], [PI / 2, 0, 0]); k.add('steel', cyl(r * 0.5, r * 0.5, w + 0.04, 8), I.steel, [x, r, z], [PI / 2, 0, 0]); for (let i = 0; i < 6; i++) k.add('steel', box(0.08, w + 0.02, 0.18), 0x26262a, [x + Math.cos(i / 6 * TAU) * r, r + Math.sin(i / 6 * TAU) * r, z], [PI / 2, 0, i / 6 * TAU]); }

function I_cc() { // fortified industrial command plant
  const k = new Kit('I');
  k.add('conc', cyl(8.0, 8.6, 0.5, 8), I.conc2, [0, 0.25, 0], [0, PI / 8, 0]);
  for (let i = 0; i < 8; i++) { const a = PI / 8 + (i + 0.5) / 8 * TAU; iHaz(k, polar(8.3, a, 0.52), 0.2, 0.06, 6.0, [0, a, 0]); }
  k.add('conc', cyl(6.4, 7.5, 3.4, 8), I.conc, [0, 2.2, 0], [0, PI / 8, 0]);                 // squat sloped bunker core
  for (let i = 0; i < 8; i++) { const a = (i / 8) * TAU + PI / 4, p = polar(7.0, a, 2.0);
    k.add('steel', bbox(0.2, 1.6, 3.6, 0.04), i % 2 ? I.blue : I.blue2, p, [0, a - PI / 2, 0.14 * 0], 1);
    for (const dz of [-1.5, 1.5]) k.add('steel', sph(0.08, 5, 3), I.dark, [p[0] + Math.cos(a) * dz * 0 + Math.sin(a) * 0.12, 2.6, p[2] - Math.sin(a) * dz + Math.cos(a) * 0.12]); }
  k.add('steel', cyl(6.45, 6.45, 0.35, 8), I.dark, [0, 3.95, 0], [0, PI / 8, 0]);
  k.add('conc', bbox(7.0, 2.4, 7.0, 0.12), I.conc, [-0.6, 5.3, 0]);
  k.add('corr', bbox(7.3, 0.25, 7.3, 0.05), 0x3a6ea5, [-0.6, 6.6, 0]);
  for (const s2 of [1, -1]) { iHaz(k, [-0.6, 6.78, s2 * 3.6], 7.3, 0.12, 0.25); iHaz(k, [-0.6 + s2 * 3.6, 6.78, 0], 0.25, 0.12, 7.3); }
  ccBeacon(k, [-2.8, 6.75, 2.6], 0x2fb8ff, 4.5, 'steel');
  for (const z of [-2.0, 0, 2.0]) k.add('glow', box(0.06, 0.4, 1.2), I.cyan, [2.92, 5.4, z], 0, 1, { fx: 2.2 });
  // steel control tower + radar
  k.add('steel', bbox(2.8, 5.2, 2.8, 0.08), I.blue, [1.4, 9.3, -1.2]);
  k.add('glow', box(2.86, 0.5, 2.86), I.cyan, [1.4, 10.8, -1.2], 0, 1, { fx: 3.8 });
  k.add('steel', bbox(3.4, 0.3, 3.4, 0.06), I.dark, [1.4, 11.95, -1.2]);
  iHaz(k, [1.4, 7.0, -1.2], 2.9, 0.3, 2.9);
  iRadar(k, [1.4, 12.1, -1.2], 1.4);
  iBeacon(k, [2.8, 12.1, 0.2]); iBeacon(k, [0.0, 12.1, -2.6]);
  // two smokestacks + crane
  iStack(k, [-3.6, 6.6, -2.4], 6.5, 0.6); iStack(k, [-3.6, 6.6, 1.6], 5.2, 0.5);
  iCrane(k, [-5.6, 0.5, 5.2], 9.5, 6.5, -0.7);
  // blast door on +X
  k.add('conc', bbox(1.6, 3.2, 4.6, 0.1), I.conc2, [7.2, 1.6, 0]);
  k.add('shutter', box(0.2, 2.6, 3.4), I.blue, [8.0, 1.5, 0]);
  iHaz(k, [8.05, 2.95, 0], 0.22, 0.3, 4.0); iHaz(k, [8.05, 0.15, 0], 0.22, 0.3, 4.0);
  for (const z of [2.0, -2.0]) iLight(k, [8.05, 3.25, z], I.sodium, 0.3, 3.9);
  // pipes + floodlights
  iPipe(k, [-6.8, 1.2, -2.5], [-2.0, 1.2, -6.6], 0.2); iPipe(k, [-6.8, 1.7, -2.5], [-2.0, 1.7, -6.6], 0.14, I.blue);
  for (const a of [0.6, 2.4, 3.9, 5.4]) iFlood(k, polar(7.9, a, 0.5), 5.0, a);
  return fin(k.build(), 'cc', 13);
}
function I_barracks() { // concrete barracks block, steel doors, watchtower
  const k = new Kit('I');
  k.add('conc', bbox(9.2, 0.3, 7.4, 0.08), I.conc2, [0, 0.15, 0]);
  k.add('conc', bbox(7.6, 3.6, 5.8, 0.12), I.conc, [-0.4, 2.1, 0]);
  k.add('corr', prism([[-3.1, 0], [3.1, 0], [0, 1.1]], 8.0, 0.04), 0x3a6ea5, [-0.4, 3.9, 0], [0, PI / 2, 0]);
  for (const s2 of [1, -1]) iHaz(k, [-0.4, 3.95, s2 * 3.1], 8.0, 0.14, 0.2);
  for (const s of [1, -1]) { k.add('steel', box(7.0, 0.5, 0.08), I.blue, [-0.4, 2.8, s * 2.92]); for (const x of [-3, -1.4, 0.2, 1.8]) k.add('glow', box(0.8, 0.3, 0.05), I.cyan, [x, 1.8, s * 2.93], 0, 1, { fx: 2.1 }); }
  k.add('shutter', box(0.18, 2.4, 2.4), I.steel, [3.45, 1.5, 0]);
  iHaz(k, [3.5, 2.85, 0], 0.2, 0.3, 3.0); for (const z of [1.35, -1.35]) iHaz(k, [3.5, 1.5, z], 0.2, 2.6, 0.3);
  iLight(k, [3.55, 3.2, 0], I.sodium, 0.35, 3.9);
  // watchtower
  k.push([-3.4, 0.3, -2.6]);
  for (const [x, z] of [[0.6, 0.6], [-0.6, 0.6], [0.6, -0.6], [-0.6, -0.6]]) k.bar('steel', [x, 0, z], [x * 0.8, 6.0, z * 0.8], 0.12, I.steel);
  k.add('steel', bbox(1.8, 1.2, 1.8, 0.06), I.blue, [0, 6.6, 0]); k.add('glow', box(1.84, 0.3, 1.84), I.cyan, [0, 6.75, 0], 0, 1, { fx: 3.7 });
  k.add('corr', box(2.2, 0.1, 2.2), I.dark, [0, 7.3, 0]); iBeacon(k, [0, 7.35, 0]);
  k.pop();
  for (const x of [-2.0, 0.8]) { k.add('steel', bbox(1.2, 0.7, 1.0, 0.06), I.steel, [x, 4.3, 1.2]); k.add('steel', cyl(0.35, 0.35, 0.05, 10), I.dark, [x, 4.67, 1.2]); }
  iFlood(k, [4.3, 0.3, 3.2], 4.5, 0.4);
  iPipe(k, [-4.2, 0.6, 2.95], [3.0, 0.6, 2.95], 0.12);
  return fin(k.build(), 'barracks', 6.0);
}
function I_factory() { // steel assembly hall, rolling door, overhead crane, rail spur
  const k = new Kit('I');
  k.add('conc', bbox(11, 0.3, 8.4, 0.08), I.conc2, [0.3, 0.15, 0]);
  k.add('corr', box(9.2, 5.0, 7.2), I.blue, [-0.3, 2.8, 0]);
  k.add('corr', prism([[-3.8, 0], [3.8, 0], [0, 1.6]], 9.6, 0.04), 0x3a6ea5, [-0.3, 5.3, 0], [0, PI / 2, 0]);
  for (const s2 of [1, -1]) iHaz(k, [-0.3, 5.35, s2 * 3.8], 9.6, 0.14, 0.22);
  for (const x of [-4.8, -1.6, 1.6, 4.3]) for (const s of [1, -1]) k.add('steel', box(0.25, 5.2, 0.25), I.dark, [x, 2.8, s * 3.65]);
  k.add('conc', bbox(9.4, 1.0, 7.4, 0.06), I.conc, [-0.3, 0.8, 0]);
  // rolling door (half open) on +X
  k.add('steel', box(0.2, 1.4, 4.6), I.dark, [4.35, 0.9, 0]);
  k.add('shutter', box(0.15, 2.6, 4.4), I.steel, [4.45, 3.8, 0]);
  iHaz(k, [4.5, 5.25, 0], 0.22, 0.3, 5.2); for (const z of [2.45, -2.45]) iHaz(k, [4.5, 2.6, z], 0.22, 5.0, 0.3);
  k.add('glow', box(0.05, 0.4, 4.2), I.sodium, [4.35, 1.8, 0], 0, 1, { fx: 3.8 });
  // rail spur out of the door
  for (const z of [-0.7, 0.7]) k.add('steel', box(7.0, 0.12, 0.12), I.steel, [5.0, 0.36, z]);
  for (let x = 1.8; x < 8.4; x += 0.7) k.add('steel', box(0.25, 0.08, 2.0), 0x4a3a30, [x, 0.3, 0]);
  // overhead gantry crane in front
  for (const s of [1, -1]) { k.add('steel', bbox(0.45, 6.6, 0.45, 0.05), I.yellow, [5.8, 3.6, s * 3.7]); }
  k.add('steel', bbox(0.7, 0.7, 8.0, 0.06), I.yellow, [5.8, 7.0, 0]); iHaz(k, [5.8, 7.0, 0], 0.72, 0.3, 2.0);
  k.add('steel', bbox(1.0, 0.6, 1.0, 0.05), I.steel, [5.8, 6.4, -1.2]); k.line('steel', [5.8, 6.1, -1.2], [5.8, 3.4, -1.2], 0.03, I.dark, 4);
  k.add('steel', bbox(2.0, 1.0, 1.4, 0.08), I.blue2, [5.8, 2.8, -1.2]); iLight(k, [5.8, 7.4, 3.7], I.red, 0.2, 1.3);
  iStack(k, [-4.2, 0.3, -2.6], 10.0, 0.6);
  iPipe(k, [-4.9, 3.5, 3.2], [-4.9, 3.5, -1.8], 0.22); iPipe(k, [-4.9, 3.5, 3.2], [-4.9, 6.2, 3.2], 0.22);
  for (const x of [-3.4, -0.3, 2.8]) k.add('glow', box(1.4, 0.06, 0.06), I.cyan, [x, 6.5, 0], 0, 1, { fx: 2.3 });
  iFlood(k, [4.9, 0.3, -3.9], 5.0, -0.4); iBeacon(k, [4.4, 5.5, 3.4]);
  return fin(k.build(), 'factory', 7.4);
}
function iPillbox(k, h) {
  k.add('conc', cyl(1.4, 1.7, h, 8), I.conc, [0, h / 2, 0], [0, PI / 8, 0]);
  k.add('steel', box(0.08, 0.2, 1.2), I.dark, [1.5, h * 0.55, 0]);
  iHaz(k, [0, h - 0.1, 0], 0.01, 0.01, 0.01);
  iHazRing(k, [0, 0.2, 0], 1.72);
  iLight(k, [0.0, h * 0.4, 1.62], I.cyan, 0.15, 2.3);
}
function I_turret_mg() {
  const k = new Kit('I'); iPillbox(k, 1.0);
  const g = k.build();
  const t = new Kit('I');
  t.add('steel', cyl(0.9, 1.0, 0.25, 10), I.dark, [0, 0.12, 0]);
  t.add('steel', prism([[-0.7, 0], [0.5, 0], [0.8, 0.3], [0.5, 0.7], [-0.7, 0.7]], 1.2, 0.05), I.blue, [0, 0.2, 0]);
  for (const s of [1, -1]) { t.add('steel', cyl(0.06, 0.06, 1.4, 8), I.dark, [1.3, 0.55, s * 0.18], [0, 0, -PI / 2]); t.add('steel', cyl(0.1, 0.1, 0.4, 8), I.steel, [0.85, 0.55, s * 0.18], [0, 0, -PI / 2]); }
  t.add('steel', box(0.5, 0.3, 0.3), I.steel, [-0.2, 0.55, 0.7]);
  t.add('glow', box(0.04, 0.06, 0.2), I.cyan, [0.82, 0.75, 0]);
  const tur = t.build('turret'); tur.position.y = 1.0; g.add(tur);
  return fin(g, 'turret_mg', 2.0);
}
function I_turret_cannon() {
  const k = new Kit('I'); iPillbox(k, 2.0);
  const g = k.build();
  const t = new Kit('I');
  t.add('steel', prism([[-1.0, 0], [0.7, 0], [1.1, 0.35], [0.75, 0.85], [-0.85, 0.9], [-1.1, 0.45]], 1.5, 0.06), I.blue, [0, 0, 0]);
  t.add('steel', bbox(0.45, 0.5, 0.6, 0.06), I.dark, [1.1, 0.45, 0]);
  t.add('steel', cyl(0.13, 0.15, 2.8, 10), I.steel, [2.5, 0.45, 0], [0, 0, -PI / 2]);
  t.add('steel', cyl(0.2, 0.2, 0.5, 10), I.dark, [1.7, 0.45, 0], [0, 0, -PI / 2]);
  t.add('steel', bbox(0.4, 0.3, 0.34, 0.05), I.dark, [3.95, 0.45, 0]);
  t.add('haz', box(0.4, 0.06, 1.52), 0xffffff, [-0.3, 0.88, 0]);
  t.add('glow', box(0.04, 0.08, 0.3), I.cyan, [1.02, 0.72, 0]);
  const tur = t.build('turret'); tur.position.y = 2.0; g.add(tur);
  return fin(g, 'turret_cannon', 3.4);
}
function I_artillery() {
  const k = new Kit('I');
  k.add('conc', bbox(4.2, 0.6, 4.2, 0.12), I.conc, [0, 0.3, 0]);
  for (const [x, z] of [[1.7, 1.7], [-1.7, 1.7], [1.7, -1.7], [-1.7, -1.7]]) k.add('steel', bbox(0.5, 0.5, 0.5, 0.05), I.dark, [x, 0.85, z]);
  iHaz(k, [0, 0.62, 2.05], 4.0, 0.08, 0.12); iHaz(k, [0, 0.62, -2.05], 4.0, 0.08, 0.12);
  const g = k.build();
  const t = new Kit('I');
  t.add('steel', cyl(1.3, 1.4, 0.3, 10), I.dark, [0, 0.15, 0]);
  for (const s of [1, -1]) t.add('steel', bbox(1.8, 1.2, 0.2, 0.05), I.blue, [0.1, 0.9, s * 0.62]);
  t.push([0.3, 1.0, 0], [0, 0, 0.6]);
  t.add('steel', bbox(1.0, 0.6, 0.65, 0.05), I.steel, [-0.1, 0, 0]);
  t.add('steel', cyl(0.22, 0.28, 3.9, 10), I.steel, [1.95, 0, 0], [0, 0, -PI / 2]);
  t.add('steel', bbox(0.5, 0.42, 0.46, 0.05), I.dark, [4.0, 0, 0]);
  for (const s of [1, -1]) t.add('steel', cyl(0.07, 0.07, 1.6, 6), I.dark, [0.9, 0.3, s * 0.2], [0, 0, -PI / 2]);
  t.pop();
  const tur = t.build('turret'); tur.position.y = 0.6; g.add(tur);
  return fin(g, 'artillery', 3.0);
}
function I_wall(variant) { // precast jersey barriers + steel girders + razor wire
  const k = new Kit('I');
  const jersey = [[-0.75, 0], [0.75, 0], [0.7, 0.3], [0.32, 0.6], [0.25, 1.5], [-0.25, 1.5], [-0.32, 0.6], [-0.7, 0.3]];
  for (const x of [-1.0, 1.0]) k.add('conc', prism(jersey, 1.96, 0.04), variant ? I.conc2 : I.conc, [x, 0, 0], [0, PI / 2, 0]);
  for (const s of [1, -1]) iHaz(k, [0, 0.15, s * 0.73], 3.9, 0.2, 0.04);
  for (const x of [-1.95, 1.95]) { k.add('steel', box(0.3, 2.3, 0.12), I.steel, [x, 1.15, 0]); k.add('steel', box(0.3, 0.06, 0.5), I.dark, [x, 2.28, 0]); }
  k.add('steel', box(4.0, 0.2, 0.12), I.blue, [0, 1.65, 0]);
  iRazor(k, [-1.9, 2.05, 0], [1.9, 2.05, 0]);
  return fin(k.build(), 'wall', 2.3);
}
function I_gate() { // sliding steel blast door between concrete pylons
  const k = new Kit('I');
  k.add('conc', bbox(2.0, 0.3, 6.8, 0.08), I.conc2, [0, 0.15, 0]);
  for (const s of [1, -1]) { k.add('conc', bbox(1.8, 5.0, 1.4, 0.1), I.conc, [0, 2.8, s * 2.8]); iHaz(k, [0.92, 4.0, s * 2.8], 0.05, 0.5, 1.4); iBeacon(k, [0, 5.35, s * 2.8]); iLight(k, [0.95, 4.8, s * 2.4], I.sodium, 0.3, 3.9); }
  k.add('steel', bbox(0.8, 0.5, 6.6, 0.06), I.dark, [0, 5.05, 0]);
  k.add('steel', bbox(0.5, 4.3, 4.6, 0.08), I.blue, [0, 2.45, -0.4]);
  for (let y = 0.8; y < 4.4; y += 0.9) k.add('steel', box(0.56, 0.12, 4.5), I.blue2, [0, y, -0.4]);
  iHaz(k, [0.27, 0.6, -0.4], 0.04, 0.5, 4.5); iHaz(k, [-0.27, 0.6, -0.4], 0.04, 0.5, 4.5);
  k.add('steel', box(0.3, 0.12, 6.4), I.steel, [0, 0.36, 0]);
  return fin(k.build(), 'gate', 5.6);
}
function I_tank() { // tracked steel MBT with long cannon + exhaust stacks
  const k = new Kit('I');
  iTracks(k, 4.4, 1.15, 0.85, 0.72);
  k.add('steel', prism([[-2.2, 0.55], [1.6, 0.55], [2.35, 0.85], [1.7, 1.3], [-1.95, 1.38], [-2.25, 1.0]], 1.95, 0.08), I.blue, [0, 0, 0]);
  for (const s of [1, -1]) { k.add('steel', prism([[-2.1, 0.85], [2.0, 0.85], [2.2, 1.0], [-2.2, 1.0]], 0.75, 0.03), I.blue2, [0, 0, s * 1.15]); k.line('steel', [-1.9, 1.0, s * 0.7], [-2.1, 2.0, s * 0.7], 0.1, I.dark, 8); k.smoke([-2.1, 2.1, s * 0.7], 3, 0.6); }
  k.add('haz', box(0.12, 0.12, 2.2), 0xffffff, [2.3, 0.72, 0]);
  k.add('steel', bbox(1.2, 0.1, 1.5, 0.03), I.dark, [-1.4, 1.42, 0]);
  for (const z of [0.6, -0.6]) iLight(k, [2.15, 1.0, z], I.white, 0.16);
  const g = k.build();
  const t = new Kit('I');
  t.add('steel', prism([[-1.25, 0], [0.8, 0], [1.25, 0.3], [0.9, 0.68], [-1.0, 0.74], [-1.35, 0.35]], 1.65, 0.07), I.blue, [0, 0, 0]);
  t.add('steel', bbox(0.5, 0.45, 0.7, 0.06), I.dark, [1.25, 0.38, 0]);
  t.add('steel', cyl(0.11, 0.13, 2.9, 10), I.steel, [2.9, 0.38, 0], [0, 0, -PI / 2]);
  t.add('steel', cyl(0.17, 0.17, 0.45, 10), I.dark, [2.4, 0.38, 0], [0, 0, -PI / 2]);
  t.add('steel', bbox(0.4, 0.26, 0.32, 0.05), I.dark, [4.35, 0.38, 0]);
  t.add('steel', cyl(0.28, 0.3, 0.12, 10), I.steel, [-0.35, 0.78, 0.35]);
  t.line('steel', [-0.95, 0.7, -0.55], [-1.05, 2.1, -0.55], 0.03, I.dark, 4);
  t.add('steel', box(0.5, 0.35, 1.5), I.blue2, [-1.45, 0.35, 0]);
  const tur = t.build('turret'); tur.position.set(-0.2, 1.4, 0); g.add(tur);
  return fin(g, 'tank', 2.4);
}
function I_raider() { // armored 6-wheel APC with roof MG
  const k = new Kit('I');
  for (const x of [1.15, 0, -1.15]) for (const s of [1, -1]) iWheel(k, x, s * 0.95, 0.42, 0.34);
  k.add('steel', prism([[-1.7, 0.5], [1.3, 0.5], [1.85, 0.85], [1.3, 1.45], [-1.6, 1.5], [-1.75, 1.0]], 1.6, 0.08), I.blue, [0, 0, 0]);
  for (const s of [1, -1]) { k.add('steel', box(2.6, 0.12, 0.06), I.blue2, [-0.2, 1.05, s * 0.82]); k.add('glow', box(0.5, 0.12, 0.04), I.cyan, [0.6, 1.25, s * 0.82], 0, 1, { fx: 2.4 }); }
  for (const z of [0.5, -0.5]) iLight(k, [1.82, 0.95, z], I.sodium, 0.14);
  k.add('haz', box(0.1, 0.15, 1.5), 0xffffff, [1.86, 0.62, 0]);
  k.add('steel', cyl(0.3, 0.34, 0.2, 10), I.dark, [-0.3, 1.6, 0]);
  k.add('steel', box(0.08, 0.4, 0.7), I.blue2, [0.0, 1.85, 0], [0, 0, -0.2]);
  k.add('steel', box(0.5, 0.18, 0.16), I.dark, [-0.3, 1.85, 0]); k.add('steel', cyl(0.045, 0.045, 1.0, 6), I.steel, [0.45, 1.88, 0], [0, 0, -PI / 2]);
  k.line('steel', [-1.4, 1.5, 0.5], [-1.5, 2.6, 0.5], 0.025, I.dark, 4); iBeacon(k, [-1.2, 1.52, -0.5]);
  return fin(k.build(), 'raider', 2.0);
}
function I_harvester() { // heavy mining dump truck
  const k = new Kit('I'), r = rng(901);
  k.add('steel', bbox(4.2, 0.4, 1.6, 0.06), I.dark, [0, 0.8, 0]);
  for (const x of [1.35, -0.4, -1.4]) for (const s of [1, -1]) iWheel(k, x, s * 1.05, 0.55, 0.42);
  k.add('steel', prism([[0.8, 1.0], [2.15, 1.0], [2.2, 1.5], [1.9, 2.3], [0.9, 2.35]], 1.7, 0.06), I.blue, [0, 0, 0]);
  k.add('glow', box(0.05, 0.4, 1.3), I.cyan, [2.05, 1.95, 0], [0, 0, 0.36], 1, { fx: 2.2 });
  k.add('steel', prism([[-2.1, 1.0], [0.6, 1.0], [0.8, 2.3], [-2.2, 2.0]], 2.1, 0.06), I.yellow, [0, 0, 0]);
  k.add('steel', box(2.6, 0.05, 1.8), 0x222222, [-0.75, 2.12, 0]);
  for (let i = 0; i < 6; i++) k.add('glow', ico(0.32, 0), i % 2 ? I.cyan : 0xbff6ff, [-0.75 + (r() - 0.5) * 2.0, 2.25 + r() * 0.2, (r() - 0.5) * 1.3], [r(), r(), r()], [0.7, 1.3, 0.7]);
  k.add('haz', box(0.1, 0.4, 2.12), 0xffffff, [0.72, 1.8, 0]);
  k.line('steel', [1.0, 2.0, 0.65], [0.9, 3.0, 0.65], 0.09, I.dark, 8); k.smoke([0.9, 3.1, 0.65], 3, 0.6);
  iBeacon(k, [1.4, 2.4, -0.5]); for (const z of [0.6, -0.6]) iLight(k, [2.2, 1.25, z], I.white, 0.15);
  return fin(k.build(), 'harvester', 2.8);
}
function decorInd(k, lx, lz, i, r, ry) {
  const t = i % 6, ry2 = Math.round(ry / (PI / 2)) * PI / 2;
  if (t === 0) { iContainer(k, [lx, 0, lz], ry2, 5.5, pick(r, [I.blue, 0x8a3a2a, 0x3a6a4a, I.conc2])); if (r() < 0.5) iContainer(k, [lx, 2.45, lz], ry2 + 0.1, 5.5, pick(r, [I.blue2, 0x9a6a20])); }
  else if (t === 1) { for (let j = 0; j < 5; j++) iDrum(k, [lx + (j % 3) * 0.75, 0, lz + ((j / 3) | 0) * 0.75], pick(r, [I.blue, 0x8a3a2a, I.yellow])); }
  else if (t === 2) iFlood(k, [lx, 0, lz], 6, ry);
  else if (t === 3) { k.push([lx, 0, lz], [0, ry2, 0]); for (const z of [-0.7, 0.7]) k.add('steel', box(9, 0.12, 0.12), I.steel, [0, 0.12, z]); for (let x = -4.2; x < 4.4; x += 0.7) k.add('steel', box(0.25, 0.08, 2.0), 0x4a3a30, [x, 0.05, 0]); k.pop(); }
  else if (t === 4) { k.push([lx, 0, lz], [0, ry2, 0]); for (const x of [-2.5, 0, 2.5]) { k.add('steel', box(0.25, 3.0, 0.25), I.steel, [x, 1.5, -0.6]); k.add('steel', box(0.25, 3.0, 0.25), I.steel, [x, 1.5, 0.6]); k.add('steel', box(0.3, 0.2, 1.5), I.dark, [x, 3.0, 0]); }
    iPipe(k, [-3, 2.8, -0.35], [3, 2.8, -0.35], 0.2, I.steel); iPipe(k, [-3, 2.8, 0.35], [3, 2.8, 0.35], 0.16, I.blue); iPipe(k, [-3, 3.35, 0], [3, 3.35, 0], 0.12, I.yellow); k.pop(); }
  else { for (let j = 0; j < 3; j++) k.add('steel', bbox(1.2, 0.18, 1.0, 0.03), 0x8a6a48, [lx + j * 0.2, 0.09 + j * 0.2, lz], [0, j * 0.2, 0]); k.add('steel', bbox(1.0, 0.8, 0.9, 0.05), I.blue2, [lx + 1.4, 0.4, lz + 0.3]); iBeacon(k, [lx + 1.4, 0.8, lz + 0.3]); }
}

// ======================================================================= roster specials + air
function blobTex() {
  if (TEX.blob) return TEX.blob;
  const [c, g] = canvas(64, 64), gr = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  gr.addColorStop(0, 'rgba(0,0,0,0.75)'); gr.addColorStop(0.6, 'rgba(0,0,0,0.35)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return (TEX.blob = texFrom(c));
}
const BLOB_MAT = () => MATS.blob || (MATS.blob = new T.MeshBasicMaterial({ map: blobTex(), transparent: true, depthWrite: false, toneMapped: false }));
function airify(g, span) { // soft ground shadow that stays on y=0 wherever the flyer is (kept by updateModels)
  const b = new T.Mesh(gc('blobP', () => new T.PlaneGeometry(1, 1).rotateX(-PI / 2)), BLOB_MAT());
  b.scale.set(span, 1, span * 0.7); b.name = 'airShadow'; b.renderOrder = 1; b.raycast = () => {};
  g.add(b); g.userData.air = true; return g;
}
// ---- Earth: Sunwing (great golden-winged flyer), Glider, Burrower (+ mound)
function E_sunwing() {
  const k = new Kit('E');
  k.add('stone', prism([[-1.4, -0.2], [0.9, -0.25], [1.7, 0.05], [0.9, 0.35], [-1.2, 0.3]], 0.9, 0.08), eStone(E.rock2), [0, 0, 0]);
  k.add('gold', cone(0.3, 0.9, 5), E.gold, [2.0, 0.05, 0], [0, 0, -PI / 2]);
  k.add('glow', new T.OctahedronGeometry(1, 0), E.sun, [0.2, 0.1, 0], 0, [0.3, 0.4, 0.3], { fx: 3.5 });
  for (const s of [1, -1]) {
    for (let i = 0; i < 5; i++) { // layered feather blades, swept back
      const z0 = s * (0.4 + i * 0.75), len = 1.9 - i * 0.22;
      k.add('gold', prism([[-len, 0], [0.5, 0], [0.3, 0.06], [-len + 0.2, 0.05]], 0.7, 0.01), i % 2 ? E.gold : 0xf4d070, [0.2 - i * 0.28, 0.1 + i * 0.05, z0], [s * -0.08, 0, 0]);
    }
    k.bar('glow', [0.5, 0.18, s * 0.4], [-0.6, 0.35, s * 3.6], 0.06, E.white, { fx: 3.3 });
    k.add('gold', prism([[-1.2, 0], [0, 0], [-1.6, 0.6]], 0.05, 0.01), E.gold, [-1.1, 0.1, s * 0.25], [s * 0.4, 0, 0]);
  }
  k.embers([-1.3, 0, 0], 6, 0.6, 0.7);
  return airify(fin(k.build(), 'air', 1.2), 7);
}
function E_glider() {
  const k = new Kit('E');
  k.add('gold', gc('delta', () => { const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute([1.2, 0, 0, -0.9, 0.12, 1.8, -0.9, 0.12, -1.8, 1.2, 0, 0, -0.9, 0.12, -1.8, -0.9, 0.12, 1.8], 3)); g.setAttribute('uv', new T.Float32BufferAttribute([0.5, 1, 0, 0, 1, 0, 0.5, 1, 1, 0, 0, 0], 2)); g.computeVertexNormals(); return g; }), 0xe8b648, [0, 0.4, 0], 0, 1, { smooth: true });
  k.bar('gold', [1.2, 0.4, 0], [-0.9, 0.52, 1.8], 0.05, E.gold); k.bar('gold', [1.2, 0.4, 0], [-0.9, 0.52, -1.8], 0.05, E.gold); k.bar('gold', [-0.9, 0.52, -1.8], [-0.9, 0.52, 1.8], 0.04, E.gold);
  k.add('stone', prism([[-0.6, -0.15], [0.5, -0.12], [0.8, 0], [0.4, 0.15], [-0.5, 0.12]], 0.35, 0.03), eStone(E.rock2), [0, 0, 0]);
  k.add('glow', box(0.5, 0.04, 0.04), E.sun, [-0.9, 0.52, 0], 0, 1, { fx: 3.4 });
  return airify(fin(k.build(), 'air', 0.8), 3.8);
}
function E_burrower() { // rock-armored drill beast
  const k = new Kit('E'), r = rng(611);
  for (let i = 0; i < 3; i++) { const x = 0.6 - i * 1.15, s = 1 - i * 0.15; k.add('stone', ico(0.85 * s, 0), eStone(i ? E.rock : E.rock2), [x, 0.75 * s, 0], [r(), r(), r()], [1.2, 0.9, 1]); k.add('gold', torus(0.75 * s, 0.06, 4, 10), E.gold, [x + 0.45 * s, 0.75 * s, 0], [0, PI / 2, 0]); }
  k.add('gold', cone(0.6, 1.5, 7), E.gold, [1.95, 0.75, 0], [0, 0, -PI / 2]);
  for (let i = 0; i < 3; i++) k.bar('glow', [1.4 + i * 0.35, 0.75 + 0.5 - i * 0.15, 0], [1.6 + i * 0.35, 0.75 - 0.4 + i * 0.12, 0.3], 0.05, E.sun, { fx: 3.2 });
  for (const s of [1, -1]) for (const x of [0.5, -0.6]) k.line('stone', [x, 0.6, s * 0.6], [x + 0.3, 0, s * 1.0], 0.17, E.rock2, 5);
  for (const s of [1, -1]) k.add('glow', box(0.08, 0.1, 0.12), E.sun, [1.1, 1.05, s * 0.35]);
  return fin(k.build(), 'burrower', 1.6);
}
function E_mound() { // dirt mound shown while burrowed
  const k = new Kit('E'), r = rng(613);
  k.add('stone', gc('mound', () => new T.SphereGeometry(1, 10, 5, 0, TAU, 0, PI / 2)), (x, y) => (y > 0.5 ? 0x8a5a3a : 0x6a4428), [0, 0, 0], 0, [1.6, 0.6, 1.3]);
  for (let i = 0; i < 6; i++) eBoulder(k, polar(1.4 + r() * 0.4, r() * TAU, 0.1), 0.25 + r() * 0.2, r, E.rock2);
  for (let i = 0; i < 3; i++) k.bar('glow', polar(0.2, i * 2, 0.6), polar(1.2, i * 2 + 0.4, 0.2), 0.05, E.sun, { fx: 3.6 });
  k.haze([0, 0.4, 0], 2, 1.2);
  return fin(k.build(), 'mound', 0.8);
}
// ---- Volcanic: Magma Juggernaut, Ash Cannon AA
function F_juggernaut() {
  const k = new Kit('C');
  fTracks(k, 5.4, 1.45, 0.9, 0.85);
  k.add('solid', prism([[-2.7, 0.55], [2.0, 0.55], [2.8, 0.9], [1.9, 1.65], [-2.4, 1.75], [-2.8, 1.2]], 2.4, 0.1), F.rock2, [0, 0, 0]);
  for (let i = 0; i < 4; i++) { const x = -1.9 + i * 1.15; k.add('stone', bbox(1.0, 0.25, 2.7, 0.08), stoneC(F.rock), [x, 1.8, 0], [0, 0, (i % 2 ? 0.05 : -0.05)]); fSeam(k, [x + 0.55, 1.8, -1.3], [x + 0.55, 1.8, 1.3], 0.1); }
  for (const s of [1, -1]) { k.add('stone', prism([[-2.6, 0.9], [2.4, 0.9], [2.6, 1.3], [-2.7, 1.4]], 0.4, 0.05), stoneC(F.rock), [0, 0, s * 1.45]); fSeam(k, [-2.4, 1.15, s * 1.67], [2.3, 1.1, s * 1.67], 0.12); k.line('solid', [-2.3, 1.4, s * 0.8], [-2.8, 2.7, s * 0.8], 0.16, F.iron, 6); k.flame([-2.8, 2.7, s * 0.8], 0.8, 0.18); k.embers([-2.8, 2.9, s * 0.8], 4, 0.4, 0.7); }
  fRam(k, 2.6, 0.2, 3.0, 1.2, 5);
  const g = k.build();
  const t = new Kit('C');
  t.add('solid', prism([[-1.5, 0], [0.9, 0], [1.4, 0.35], [0.9, 0.85], [-1.3, 0.9], [-1.6, 0.4]], 2.0, 0.07), F.rock2, [0, 0, 0]);
  fSeam(t, [-1.3, 0.92, 0], [0.8, 0.88, 0], 0.12);
  t.add('solid', cyl(0.2, 0.24, 3.0, 10), F.iron2, [2.6, 0.45, 0], [0, 0, -PI / 2]);
  t.add('glow', cyl(0.18, 0.18, 0.08, 10), F.molten, [4.12, 0.45, 0], [0, 0, PI / 2], 1, { fx: 3.5 });
  for (const s of [1, -1]) t.spike('solid', [-1.2, 0.7, s * 0.95], [-0.6, 0.6, s], 0.9, 0.1, F.iron2);
  const tur = t.build('turret'); tur.position.set(-0.3, 1.9, 0); g.add(tur);
  return fin(g, 'tank', 3.0);
}
function F_ashcannon() { // tracked AA: twin upward magma flak barrels
  const k = new Kit('C');
  fTracks(k, 3.8, 1.0, 0.65, 0.6);
  k.add('solid', prism([[-1.9, 0.4], [1.5, 0.4], [2.0, 0.6], [1.4, 1.0], [-1.8, 1.05]], 1.6, 0.06), F.rock2, [0, 0, 0]);
  fSeam(k, [-1.6, 1.08, -0.6], [-1.6, 1.08, 0.6], 0.1); k.embers([-1.6, 1.1, 0], 4, 0.6, 0.7);
  const g = k.build();
  const t = new Kit('C');
  t.add('solid', cyl(0.8, 0.9, 0.35, 8), F.iron, [0, 0.17, 0]);
  t.push([0.1, 0.6, 0], [0, 0, 0.95]);
  for (const s of [1, -1]) { t.add('solid', cyl(0.12, 0.14, 2.2, 8), F.iron2, [1.0, 0, s * 0.28], [0, 0, -PI / 2]); t.add('glow', cyl(0.11, 0.11, 0.06, 8), F.molten, [2.12, 0, s * 0.28], [0, 0, PI / 2], 1, { fx: 3.6 }); }
  t.add('solid', bbox(0.7, 0.6, 0.9, 0.06), F.rock2, [0, 0, 0]);
  t.pop();
  const tur = t.build('turret'); tur.position.y = 1.05; g.add(tur);
  return fin(g, 'aa', 2.8);
}
// ---- Vanguard: flak truck (AA)
function I_flak() {
  const k = new Kit('I');
  for (const x of [1.2, -0.3, -1.3]) for (const s of [1, -1]) iWheel(k, x, s * 0.95, 0.44, 0.34);
  k.add('steel', bbox(4.0, 0.35, 1.6, 0.06), I.dark, [0, 0.8, 0]);
  k.add('steel', prism([[0.9, 1.0], [2.0, 1.0], [2.05, 1.45], [1.75, 2.0], [0.95, 2.05]], 1.6, 0.06), I.blue, [0, 0, 0]);
  k.add('glow', box(0.05, 0.3, 1.2), I.cyan, [1.9, 1.7, 0], [0, 0, 0.5], 1, { fx: 2.2 });
  k.add('steel', bbox(2.4, 0.5, 1.8, 0.06), I.blue2, [-0.6, 1.2, 0]);
  iHaz(k, [-0.6, 1.47, 0.91], 2.4, 0.12, 0.04); iHaz(k, [-0.6, 1.47, -0.91], 2.4, 0.12, 0.04);
  for (const z of [0.55, -0.55]) iLight(k, [2.05, 1.2, z], I.white, 0.14);
  const g = k.build();
  const t = new Kit('I');
  t.add('steel', cyl(0.7, 0.8, 0.3, 10), I.dark, [0, 0.15, 0]);
  t.push([0, 0.55, 0], [0, 0, 0.8]);
  t.add('steel', bbox(0.8, 0.55, 1.1, 0.06), I.blue, [0, 0, 0]);
  for (const s of [1, -1]) for (const dy of [0.12, -0.12]) t.add('steel', cyl(0.05, 0.05, 1.6, 6), I.steel, [1.05, dy, s * 0.35], [0, 0, -PI / 2]);
  t.pop();
  t.add('steel', bbox(0.5, 0.4, 0.06, 0.02), I.yellow, [-0.3, 0.5, 0.62]);
  iRadar(t, [-0.55, 0.3, -0.45], 0.4);
  const tur = t.build('turret'); tur.position.set(-0.6, 1.45, 0); g.add(tur);
  return fin(g, 'aa', 2.6);
}
// ---- Storm: tesla AA rig with a tethered storm kite
function S_kite() {
  const k = new Kit('S');
  for (const x of [1.0, -1.0]) for (const s of [1, -1]) sWheel(k, x, s * 0.95, 0.4, 0.3);
  k.add('solid', prism([[-1.7, 0.4], [1.4, 0.4], [1.9, 0.6], [1.3, 0.9], [-1.6, 0.95]], 1.5, 0.06), S.grey, [0, 0, 0]);
  k.add('jacq', cloth(2.4, 0.35, 0.02, 0), S.crimson, [-0.2, 0.7, 0.77], 0, 1, { smooth: true });
  sTesla(k, [-0.6, 0.9, 0], 2.0, 3, 0.75);
  k.line('solid', [0.6, 0.9, 0], [-1.5, 6.4, 0.5], 0.015, S.bone, 3);
  k.sub('bob', [-1.6, 6.5, 0.5], [0, 0, 0], (q) => {
    q.add('jacq', gc('kite', () => { const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute([0, 0.9, 0, -0.7, 0, 0, 0, -1.2, 0, 0, 0.9, 0, 0, -1.2, 0, 0.7, 0, 0], 3)); g.setAttribute('uv', new T.Float32BufferAttribute([0.5, 1, 0, 0.5, 0.5, 0, 0.5, 1, 0.5, 0, 1, 0.5], 2)); g.computeVertexNormals(); return g; }), S.crimson, [0, 0, 0], [-0.9, 0, 0], [1.6, 1.6, 1.6], { smooth: true });
    q.add('glow', sph(0.12, 6, 4), S.volt, [0, 0, 0], 0, 1, { fx: 1.2 });
    sArc(q, [0, 0, 0], [0.8, -1.4, 0.4], 3);
  });
  return fin(k.build(), 'aa', 3.0);
}

// ======================================================================= neutral
function N_crystal(variant) {
  const k = new Kit('N'), r = rng(301 + variant * 13);
  const rockC = (x, y, z) => (y > 0.35 ? 0x7a5a48 : 0x5e4638);
  k.add('rock', jitter(new T.DodecahedronGeometry(1.15, 0), r, 0.18), rockC, [0, 0.15, 0], [0, r() * 6, 0], [1, 0.42, 0.95]);
  for (let i = 0; i < 3; i++) { const a = r() * TAU; k.add('rock', jitter(new T.DodecahedronGeometry(0.4, 0), r, 0.1), rockC, polar(1.1, a, 0.15), [r(), r(), r()], [1, 0.7, 1]); }
  const n = 5 + ((r() * 4) | 0);
  for (let i = 0; i < n; i++) {
    const main = i === 0, a = r() * TAU, tilt = main ? 0.08 : 0.35 + r() * 0.45, h = main ? 1.6 + r() * 0.4 : 0.6 + r() * 0.7, w = main ? 0.45 : 0.22 + r() * 0.16;
    const d = new T.Vector3(Math.sin(a) * Math.sin(tilt), Math.cos(tilt), Math.cos(a) * Math.sin(tilt)).normalize();
    const base = new T.Vector3(Math.sin(a) * (main ? 0 : 0.35 + r() * 0.4), 0.35, Math.cos(a) * (main ? 0 : 0.35 + r() * 0.4));
    const q = new T.Quaternion().setFromUnitVectors(_up(), d).multiply(new T.Quaternion().setFromEuler(new T.Euler(0, r() * 3, 0)));
    k.addM('crystal', new T.OctahedronGeometry(1, 0), 0xffffff, new T.Matrix4().compose(base.clone().addScaledVector(d, h * 0.75), q, new T.Vector3(w, h, w)));
  }
  return fin(k.build(), 'crystal', 3);
}
function jitter(g, r, amt) {
  const pos = g.attributes.position, map = new Map();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
    if (!map.has(key)) map.set(key, [1 + (r() - 0.5) * 2 * amt, 1 + (r() - 0.5) * 2 * amt, 1 + (r() - 0.5) * 2 * amt]);
    const j = map.get(key); pos.setXYZ(i, pos.getX(i) * j[0], pos.getY(i) * j[1], pos.getZ(i) * j[2]);
  }
  return g;
}
function N_rock(variant) {
  const k = new Kit('N'), r = rng(401 + variant * 17);
  const band = (x, y, z) => { const s = Math.sin(y * 7 + x * 0.8 + z * 0.5); return s > 0.55 ? 0x9a5d3c : y > 0.9 ? 0xd59968 : s < -0.6 ? 0xb06c45 : 0xc27c50; };
  k.add('rock', jitter(new T.DodecahedronGeometry(1, 1), r, 0.16), band, [0, 0.3, 0], [r() * 0.4, r() * 6, r() * 0.4], [1, 0.6 + r() * 0.35, 0.85 + r() * 0.25]);
  for (let i = 0; i < 2; i++) { const a = r() * TAU; k.add('rock', jitter(new T.DodecahedronGeometry(0.45, 0), r, 0.15), band, polar(0.95, a, 0.15), [r(), r(), r()], [1, 0.8, 1]); }
  return fin(k.build(), 'rock', 1.5);
}

function decorScrap(k, lx, lz, i, r, ry) {
      const t = i % 6;
  if (i === 0) cBanner(k, [lx, 0, lz], 6, 1.4, C.red, ry);
  else if (t === 0) { for (let h = 0; h < 4; h++) cTire(k, [lx + (r() - 0.5) * 0.4, 0.2 + h * 0.32, lz + (r() - 0.5) * 0.4], 0.62); cTire(k, [lx + 1.1, 0.2, lz + 0.4], 0.62); cTire(k, [lx + 0.6, 0.55, lz - 0.9], 0.62, true, r()); }
  else if (t === 1) { cDrum(k, [lx, 0, lz], C.red, true); cDrum(k, [lx + 0.8, 0, lz + 0.2], C.rust); cDrum(k, [lx + 0.3, 0, lz - 0.75], C.rust3, false, 1.5); }
  else if (t === 2) cHulk(k, [lx, 0, lz], ry, pick(r, [C.rust, C.red, C.rust2]), r() < 0.5);
  else if (t === 3) { for (let j = 0; j < 7; j++) k.add(r() < 0.5 ? 'scrap' : 'solid', box(0.6 + r() * 1.4, 0.2 + r() * 0.5, 0.5 + r() * 1.0), pick(r, [C.rust, C.rust2, C.steel2, C.red, C.rust3]), [lx + (r() - 0.5) * 2, 0.15 + r() * 0.6, lz + (r() - 0.5) * 2], [(r() - 0.5) * 0.8, r() * 3, (r() - 0.5) * 0.8]); cSpike(k, [lx, 0.5, lz], [0.2, 1, 0.1], 1.4, 0.1, C.steel); }
  else if (t === 4) cTotem(k, [lx, 0, lz], 2.6 + r());
  else if (i % 12 === 5) { cScaffold(k, [lx, 0, lz], 2.0, 3.5); cDrum(k, [lx + 0.2, 3.55, lz], C.soot, true); }
  else { cTarp(k, [lx, 0, lz], ry, 3.2, 2.6, 2.0); cDrum(k, [lx + 0.4, 0, lz + 0.3], C.rust); for (let h = 0; h < 2; h++) cTire(k, [lx - 0.7, 0.2 + h * 0.32, lz - 0.4], 0.6); }
}
function decorCyber(k, lx, lz, i, r, ry0) {
  const ry = (ry0 - PI) * 0.15; // billboards roughly face the camera (+z)
      const t = i % 5;
  if (t === 0) { // light pole
    k.add('lit', bbox(0.5, 0.2, 0.5, 0.05), V.trim, [lx, 0.1, lz]);
    k.line('lit', [lx, 0, lz], [lx, 4.2, lz], 0.08, V.body2, 6);
    k.bar('lit', [lx, 4.2, lz], [lx + 0.9, 4.4, lz], 0.1, V.body2);
    k.add('glow', box(0.6, 0.08, 0.25), i % 2 ? V.cyan : V.mag, [lx + 0.8, 4.3, lz]);
    k.add('holo', plane(3.0, 3.0), 0xffffff, [lx + 0.8, 0.06, lz], [-PI / 2, 0, 0], 1, { uv: cellUV(i % 2 ? 3 : 4), fx: 3.5, smooth: true });
  } else if (t === 1) { // holo billboard
    for (const d of [-1.5, 1.5]) k.line('lit', [lx + Math.cos(ry) * d, 0, lz - Math.sin(ry) * d], [lx + Math.cos(ry) * d, 4.5, lz - Math.sin(ry) * d], 0.1, V.body2, 6);
    k.sign([lx, 3.6, lz], ry, 3.6, 2.1, pick(r, [0, 1, 2]), 2, 0xffffff, -0.55);
    k.add('glow', box(0.2, 0.2, 0.2), V.red, [lx, 4.7, lz], 0, 1, { fx: 1.3 });
  } else if (t === 2) { // cable bundle
    for (let j = 0; j < 4; j++) { const off = (j - 1.5) * 0.18; k.line('lit', [lx - 3 * Math.cos(ry) + off, 0.1, lz + 3 * Math.sin(ry)], [lx + 3 * Math.cos(ry) + off, 0.1 + j * 0.03, lz - 3 * Math.sin(ry) + off], 0.08, j % 2 ? V.body2 : V.trim, 5); }
    k.add('glow', box(0.1, 0.1, 0.1), V.cyan, [lx, 0.22, lz]);
    k.add('lit', bbox(0.8, 0.9, 0.8, 0.06), V.trim, [lx + 3 * Math.cos(ry), 0.45, lz - 3 * Math.sin(ry)]);
    k.add('glow', box(0.82, 0.08, 0.82), V.cyan, [lx + 3 * Math.cos(ry), 0.7, lz - 3 * Math.sin(ry)], 0, 1, { fx: 3.2 });
  } else if (t === 3) { // vending kiosk
    k.push([lx, 0, lz], [0, -PI / 2 + (ry - PI) * 0.15, 0]);
    k.add('lit', bbox(1.2, 2.2, 1.0, 0.08), V.body, [0, 1.1, 0]);
    k.add('glow', box(0.06, 1.4, 0.8), 0x0d2236, [0.61, 1.2, 0]);
    k.sign([0.64, 1.2, 0], PI / 2, 0.8, 1.4, i % 2, 2);
    k.bar('glow', [0.62, 2.2, -0.5], [0.62, 2.2, 0.5], 0.06, V.mag);
    k.pop();
  } else { // antenna mast / crate stack
    k.add('lit', bbox(1.4, 1.0, 1.4, 0.08), V.body2, [lx, 0.5, lz], [0, ry, 0]);
    k.add('lit', bbox(1.0, 0.8, 1.0, 0.08), V.blue, [lx, 1.4, lz], [0, ry + 0.4, 0]);
    vAntenna(k, [lx, 1.8, lz], 3.0);
    k.bar('glow', [lx - 0.5, 1.02, lz], [lx + 0.5, 1.02, lz], 0.05, V.cyan);
  }
}
function decorForge(k, lx, lz, i, r, ry) {
  const t = i % 6;
  if (t === 0) fBanner(k, [lx, 0, lz], 6.5, 1.3, ry);
  else if (t === 1) fBrazier(k, [lx, 0, lz], 1.3);
  else if (t === 2) { // red-rock spire
    for (let j = 0; j < 3; j++) k.add('stone', jitter(new T.DodecahedronGeometry(1, 0), r, 0.2), stoneC(F.rock), [lx + (r() - 0.5) * 1.2, 0.8 + j * 1.3, lz + (r() - 0.5) * 1.2], [r(), r() * 6, r()], [1.4 - j * 0.3, 1.2, 1.3 - j * 0.3]);
  } else if (t === 3) { // crucible pool in a stone ring
    k.add('stone', cyl(1.5, 1.8, 0.5, 8), stoneC(F.rock2), [lx, 0.25, lz]);
    k.add('glow', cyl(1.15, 1.15, 0.05, 10), F.molten, [lx, 0.52, lz], 0, 1, { fx: 3.2 });
    k.embers([lx, 0.6, lz], 6, 1.6, 0.8); k.haze([lx, 0.8, lz], 2, 1.2);
  } else if (t === 4) { // iron obelisk with glowing seams
    k.add('stone', cyl(0.9, 1.2, 0.6, 4), stoneC(), [lx, 0.3, lz], [0, PI / 4, 0]);
    k.add('solid', cyl(0.25, 0.6, 4.5, 4), F.iron, [lx, 2.85, lz], [0, PI / 4, 0]);
    fSeam(k, [lx + 0.45, 0.7, lz], [lx + 0.18, 4.8, lz], 0.07); fSeam(k, [lx, 0.7, lz + 0.45], [lx, 4.8, lz + 0.18], 0.07);
    k.spike('solid', [lx, 5.1, lz], [0, 1, 0], 0.8, 0.2, F.iron2);
  } else { // ore pile + anvil
    for (let j = 0; j < 6; j++) k.add('stone', jitter(new T.DodecahedronGeometry(0.45, 0), r, 0.2), stoneC(F.rock2), [lx + (r() - 0.5) * 1.6, 0.25, lz + (r() - 0.5) * 1.6], [r(), r(), r()], 1);
    k.add('solid', prism([[-0.6, 0], [0.6, 0], [0.9, 0.5], [0.6, 0.7], [-0.6, 0.7]], 0.5, 0.04), F.iron, [lx + 1.6, 0.1, lz]);
    fBrazier(k, [lx - 1.2, 0, lz + 1.0], 0.8, false);
  }
}

const VOLC = { sand: 0x6a5e58, sand2: 0x7a6c64, rock: 0x4a3c36, rock2: 0x2a1c1a, iron: 0x2b2724, iron2: 0x161012, steel: 0x3e3634,
  red: 0xa3241c, red2: 0x6e1a14, molten: 0xff5a12, gold: 0xffb340, brick: 0x8a6e66, lavaW: 0.5, spires: true, dark: true };
const F0 = { ...F, lavaW: 0, spires: false, dark: false };
function withPal(pal, fn) { return (v) => { Object.assign(F, pal); MAT_OVERRIDE = 'X'; try { return fn(v); } finally { Object.assign(F, F0); MAT_OVERRIDE = null; } }; }
function decorVolcanic(k, lx, lz, i, r, ry) {
  if (i % 3 === 0) { // glowing cracked-lava ground decal
    let p = [lx, 0.04, lz];
    for (let j = 0; j < 6; j++) { const a = ry + (r() - 0.5) * 1.6, l = 0.8 + r() * 1.2, q = [p[0] + Math.cos(a) * l, 0.04, p[2] + Math.sin(a) * l]; k.bar('glow', p, q, 0.12 + r() * 0.1, j % 2 ? F.molten : F.gold, { fx: 3 + r() * 0.9 }); p = q; }
    k.embers([lx, 0.2, lz], 4, 2.5, 0.6);
  } else if (i % 3 === 1) { // obsidian shards
    for (let j = 0; j < 5; j++) k.spike('solid', [lx + (r() - 0.5) * 2, 0, lz + (r() - 0.5) * 2], [(r() - 0.5) * 0.6, 1, (r() - 0.5) * 0.6], 0.8 + r() * 2.2, 0.25 + r() * 0.2, F.iron2);
  } else decorForge(k, lx, lz, i, r, ry);
  if (i % 4 === 2) k.haze([lx, 0.3, lz], 3, 1.4); // sulfur/steam vent puffs
}
// ---------------------------------------------------------------- registry
function fin(g, kind, height) { g.userData.kind = kind; g.userData.height = height; g.name = 'model_' + kind; return g; }
// Theme registry: each team-1 look is a swappable builder set. mat = material family, gltf = overrides when the cannon glTF is loaded.
const THEMES = {
  cyber: { mat: 'V', tank: V_tank, raider: V_raider, harvester: V_harvester, cc: V_cc, barracks: V_barracks, factory: V_factory, turret_mg: V_turret_mg, turret_cannon: V_turret_cannon, artillery: V_artillery, wall: V_wall, gate: V_gate, decor: decorCyber },
  scrap: { mat: 'C', tank: C_tank, raider: C_raider, harvester: C_harvester, cc: C_cc, barracks: C_barracks, factory: C_factory, turret_mg: C_turret_mg, turret_cannon: C_turret_cannon, artillery: C_artillery, wall: C_wall, gate: C_gate, decor: decorScrap, variants: { wall: 4 } },
  forge: { mat: 'C', tank: F_tank, raider: F_raider, harvester: F_harvester, cc: F_cc, barracks: F_barracks, factory: F_factory, turret_mg: F_turret_mg, turret_cannon: F_turret_cannon, artillery: F_artillery, wall: F_wall, gate: F_gate, decor: decorForge, variants: { wall: 3 },
    gltf: { turret_cannon: F_turret_cannon_gltf, artillery: F_artillery_gltf } },
  volcanic: { mat: 'X', tank: withPal(VOLC, F_tank), raider: withPal(VOLC, F_raider), harvester: withPal(VOLC, F_harvester), cc: withPal(VOLC, F_cc), barracks: withPal(VOLC, F_barracks),
    factory: withPal(VOLC, F_factory), turret_mg: withPal(VOLC, F_turret_mg), turret_cannon: withPal(VOLC, F_turret_cannon), artillery: withPal(VOLC, F_artillery), wall: withPal(VOLC, F_wall), gate: withPal(VOLC, F_gate),
    juggernaut: withPal(VOLC, F_juggernaut), ash: withPal(VOLC, F_ashcannon), special: withPal(VOLC, F_juggernaut), air: withPal(VOLC, F_ashcannon),
    decor: withPal(VOLC, (a) => a), variants: { wall: 3 }, gltf: { turret_cannon: withPal(VOLC, F_turret_cannon_gltf), artillery: withPal(VOLC, F_artillery_gltf) } },
  industrial: { mat: 'I', tank: I_tank, raider: I_raider, harvester: I_harvester, cc: I_cc, barracks: I_barracks, factory: I_factory, turret_mg: I_turret_mg, turret_cannon: I_turret_cannon, artillery: I_artillery, wall: I_wall, gate: I_gate, decor: decorInd, variants: { wall: 2 }, special: I_flak, air: I_flak, flak: I_flak },
  earth: { mat: 'E', tank: E_tank, raider: E_raider, harvester: E_harvester, cc: E_cc, barracks: E_barracks, factory: E_factory, turret_mg: E_turret_mg, turret_cannon: E_turret_cannon, artillery: E_artillery, wall: E_wall, gate: E_gate, decor: decorEarth, variants: { wall: 3 }, sunwing: E_sunwing, glider: E_glider, burrow: E_burrower, mound: E_mound, special: E_burrower, air: E_sunwing,
    gltf: { artillery: E_artillery_gltf } },
  storm: { mat: 'S', tank: S_tank, raider: S_raider, harvester: S_harvester, cc: S_cc, barracks: S_barracks, factory: S_factory, turret_mg: S_turret_mg, turret_cannon: S_turret_cannon, artillery: S_artillery, wall: S_wall, gate: S_gate, decor: decorStorm, variants: { wall: 2 }, yacht: S_raider, kite: S_kite, tesla: S_kite, special: S_kite, air: S_kite },
  neutral: { mat: 'N', crystal: N_crystal, rock: N_rock, variants: { crystal: 4, rock: 4 } },
};
const TEAM_THEME = { 0: 'industrial', 1: 'volcanic', 2: 'earth', 3: 'storm', '-1': 'cyber' };
// Swap a team's look (call before spawning, or existing meshes keep the old look). Returns false for unknown themes.
export function setTeamTheme(team, name) { if (!THEMES[name]) return false; TEAM_THEME[team] = name; return true; }
export function registerTheme(name, set) { THEMES[name] = set; }
const TPL = new Map();

const FACTION = { vanguard: 'industrial', industrial: 'industrial', volcanic: 'volcanic', earth: 'earth', storm: 'storm', cyber: 'cyber' };
const themeOf = (team, faction) => (faction && FACTION[faction]) || TEAM_THEME[team] || 'cyber';
// Roster routing: namespaced kinds (e.g. 'earth_sunwing', 'volcanic_juggernaut') resolve by ROSTER[kind].faction/.role
// (pass the roster via setRoster or globalThis.ROSTER), else by name keywords. Infantry returns null (characters.js owns it).
let ROSTER_REF = null;
export function setRoster(r) { ROSTER_REF = r; }
const KEYWORDS = ['sunwing', 'glider', 'burrow', 'mound', 'juggernaut', 'ash', 'flak', 'yacht', 'kite', 'tesla'];
const ROLE_KIND = { light: 'raider', heavy: 'tank', harvester: 'harvester', special: 'special', air: 'air', aa: 'air' };
const ROLE_WORDS = [[/tank|heavy|crawler|golem|walker|siege/, 'tank'], [/raider|buggy|runner|strider|bike|light|interceptor|scout/, 'raider'], [/harvest|hauler|miner/, 'harvester'], [/infantry|trooper|warden|soldier|warrior|hero/, null]];
function resolveKind(kind, faction) {
  if (!kind.includes('_') || BASE_KINDS.has(kind)) return [kind, faction];
  const R = ROSTER_REF || globalThis.ROSTER, info = R?.[kind];
  const fac = info?.faction || faction || kind.split('_')[0], rest = kind.slice(kind.indexOf('_') + 1);
  const kw = KEYWORDS.find(w => rest.includes(w)); if (kw) return [kw, fac];
  const role = info?.role; if (role) return [role === 'infantry' ? null : ROLE_KIND[role] || 'tank', fac];
  for (const [re, k2] of ROLE_WORDS) if (re.test(rest)) return [k2, fac];
  return [BASE_KINDS.has(rest) ? rest : 'tank', fac];
}
const BASE_KINDS = new Set(['tank', 'raider', 'harvester', 'cc', 'barracks', 'factory', 'turret_mg', 'turret_cannon', 'artillery', 'wall', 'gate', 'crystal', 'rock']);
export function makeModel(THREE, kind, team, faction) {
  T = T || THREE;
  const orig = kind; [kind, faction] = resolveKind(kind, faction); if (!kind) return null;
  const tn = kind === 'crystal' || kind === 'rock' ? 'neutral' : themeOf(team, faction), th = THEMES[tn];
  let fn = th[kind]; if (typeof fn !== 'function' || kind === 'decor') return null;
  const useG = !!(CANNON && th.gltf?.[kind]); if (useG) fn = th.gltf[kind];
  const nv = th.variants?.[kind] || 1, v = nv > 1 ? (Math.random() * nv) | 0 : 0, key = `${tn}:${kind}:${v}:${useG ? 'g' : 'p'}`;
  if (!TPL.has(key)) TPL.set(key, fn(v));
  const o = TPL.get(key).clone();
  const tur = o.getObjectByName('turret'); if (tur) o.userData.turret = tur;
  regAnim(o); if (orig !== kind) o.userData.kind = orig;
  if (INST_ON && kind !== 'rock') addProxy(key, TPL.get(key), o);
  return o;
}

// ---------------------------------------------------------------- GPU instancing
// Every entity model is a "proxy": a normal Object3D tree (engine moves/rotates/hides it and raycasts it), whose meshes
// are invisible. updateModels() copies each proxy mesh's world matrix into one shared InstancedMesh per template mesh,
// so N tanks of a faction cost the same draw calls as one. Hidden proxies (or hidden ancestors) are skipped.
let INST_ON = true;
export function setInstancing(on) { INST_ON = !!on; }
const BATCH = new Map();
let SCENE = null;
function addProxy(key, tpl, o) {
  let b = BATCH.get(key);
  if (!b) { const tm = []; tpl.traverse(m => { if (m.isMesh) tm.push(m); }); b = { tm, proxies: [], ims: [], cap: 0 }; BATCH.set(key, b); }
  const pm = []; o.traverse(m => { if (m.isMesh) { pm.push(m); m.visible = false; } });
  b.proxies.push({ o, pm, born: U.time.value });
}
function growBatch(b, need) {
  const cap = Math.max(8, 1 << Math.ceil(Math.log2(need)));
  for (const im of b.ims) { im.parent?.remove(im); im.dispose(); }
  b.ims = b.tm.map(m => { const im = new T.InstancedMesh(m.geometry, m.material, cap);
    im.castShadow = m.castShadow; im.receiveShadow = m.receiveShadow; im.renderOrder = m.renderOrder; im.frustumCulled = m.frustumCulled; im.raycast = () => {}; im.count = 0;
    im.userData.instanced = true; SCENE.add(im); return im; });
  b.cap = cap;
}
function syncInstances(tt) {
  for (const b of BATCH.values()) {
    for (let i = b.proxies.length - 1; i >= 0; i--) {
      const p = p_root(b.proxies[i]);
      if (!p.inScene) { if (tt - b.proxies[i].born > 10 || tt < b.proxies[i].born) b.proxies.splice(i, 1); else b.proxies[i].vis = false; continue; }
      SCENE = SCENE || p.root; b.proxies[i].vis = p.vis;
    }
    if (!SCENE) continue;
    const live = b.proxies.filter(p => p.vis);
    if (live.length > b.cap || !b.ims.length) growBatch(b, Math.max(1, live.length));
    live.forEach((p, n) => { p.o.updateMatrixWorld(true); for (let j = 0; j < b.ims.length; j++) b.ims[j].setMatrixAt(n, p.pm[j].matrixWorld); });
    for (const im of b.ims) { im.count = live.length; im.instanceMatrix.needsUpdate = true; if (im.frustumCulled && live.length) im.computeBoundingSphere(); }
  }
}
function p_root(px) { let r = px.o, vis = r.visible; while (r.parent) { r = r.parent; if (!r.visible) vis = false; } return { root: r, inScene: !!r.isScene, vis }; }

const ANIM = [];
function regAnim(o) { o.traverse(c => { if (c.name === 'spin' || c.name === 'spinY' || c.name === 'bob' || c.name === 'airShadow') ANIM.push({ o: c, y0: c.position.y, ph: Math.random() * TAU, born: U.time.value }); }); }
export function updateModels(dt, t) {
  U.time.value = Number.isFinite(t) ? t : U.time.value + (dt || 0);
  if (TEX.scan) TEX.scan.offset.y = -U.time.value * 0.35;
  const tt = U.time.value;
  if (BATCH.size) syncInstances(tt);
  for (let i = ANIM.length - 1; i >= 0; i--) {
    const a = ANIM[i]; let r = a.o; while (r.parent) r = r.parent;
    if (!r.isScene) { if (tt - a.born > 10 || tt < a.born) ANIM.splice(i, 1); continue; }
    if (a.o.name === 'airShadow') { const pr = a.o.parent; a.o.position.y = -(pr.position.y) / (pr.scale.y || 1) + 0.06; continue; }
    if (a.o.name === 'spin') a.o.rotation.x += (dt || 0.016) * 2.2; else if (a.o.name === 'spinY') a.o.rotation.y += (dt || 0.016) * 1.2; else a.o.position.y = a.y0 + Math.sin(tt * 1.1 + a.ph) * 0.35;
  }
}

// Non-entity props around a base. Keeps clear of cc/barracks/factory, the front lane (toward map centre),
// and the defense slots (turrets at R15-17 near the front, artillery at R11-12 at +-90deg and 180deg).
export function decorateBase(THREE, scene, team, x, z, faction) {
  T = T || THREE;
  const tn = themeOf(team, faction), th = THEMES[tn], volc = tn === 'volcanic';
  if (volc) { Object.assign(F, VOLC); MAT_OVERRIDE = 'X'; }
  try {
  const theme = th.mat, k = new Kit(theme), r = rng(555 + team * 222);
  const s = x < 0 ? 1 : -1;
  const blocks = [{ x, z, r: 9.5 }, { x: x + s * 10, z: z + s * 10, r: 6.5 }, { x: x + s * 10, z: z - s * 10, r: 6.5 }];
  const face = Math.atan2(-z, -x);
  for (const da of [PI / 2, -PI / 2, PI]) for (const R of [11, 12]) blocks.push({ x: x + Math.cos(face + da) * R, z: z + Math.sin(face + da) * R, r: 3.2 });
  for (const [R, da] of [[17, 0.45], [17, -0.45], [15, 0.9], [15, -0.9]]) blocks.push({ x: x + Math.cos(face + da) * R, z: z + Math.sin(face + da) * R, r: 3.2 });
  const spots = [];
  for (let tries = 0; tries < 600 && spots.length < 16; tries++) {
    const a = r() * TAU, R = 10 + r() * 8, px = x + Math.cos(a) * R, pz = z + Math.sin(a) * R;
    let da = a - face; da = Math.atan2(Math.sin(da), Math.cos(da));
    if (Math.abs(da) < 1.05) continue;
    if (blocks.some(b => Math.hypot(px - b.x, pz - b.z) < b.r)) continue;
    if (spots.some(p => Math.hypot(px - p[0], pz - p[1]) < 3.2)) continue;
    spots.push([px, pz]);
  }
  const dec = volc ? decorVolcanic : th.decor;
  spots.forEach(([px, pz], i) => dec(k, px - x, pz - z, i, r, r() * TAU));
  const g = k.build('decor_' + theme); g.position.set(x, 0, z); g.userData.kind = 'decor';
  g.traverse(o => { if (o.isMesh) o.raycast = () => {}; });
  scene?.add(g); regAnim(g);
  return g;
  } finally { if (volc) { Object.assign(F, F0); MAT_OVERRIDE = null; } }
}

// Loads the Poly Haven PBR textures and the cannon_01 glTF. Safe to call more than once; never throws.
let preloadP = null;
export function preloadModels(THREE) {
  T = T || THREE;
  if (preloadP) return preloadP;
  preloadP = (async () => {
    pbrMats(); pbr('rocky_terrain_02'); mats('I');
    const texWait = Object.values(PBR).flatMap(m => [m.map, m.normalMap, m.roughnessMap]).map(t => new Promise(res => {
      if (t.image) return res(); const iv = setInterval(() => { if (t.image) { clearInterval(iv); res(); } }, 50); setTimeout(() => { clearInterval(iv); res(); }, 8000);
    }));
    try {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const gltf = await new GLTFLoader().loadAsync(PH('cannon_01/cannon_01_1k.gltf'));
      gltf.scene.updateMatrixWorld(true);
      const geos = []; let mat = null;
      gltf.scene.traverse(o => { if (!o.isMesh) return; mat = mat || o.material;
        const g = o.geometry.clone(); for (const n of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(n)) g.deleteAttribute(n);
        g.applyMatrix4(o.matrixWorld); geos.push(g.index ? g.toNonIndexed() : g); });
      const geo = mergeGeometries(geos, false);
      if (geo && mat) { mat.envMap = envTex(); mat.envMapIntensity = 0.6; geo.computeBoundingSphere(); CANNON = { geo, mat }; }
    } catch (e) { console.warn('[models] cannon glTF unavailable, using primitive cannon:', e?.message || e); }
    await Promise.all(texWait);
    return !!CANNON;
  })();
  return preloadP;
}
