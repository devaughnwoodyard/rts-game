// Vanguard models (GRAPHICS-B). Procedural, merged-per-material primitive models with two faction themes:
//   team 0 VANGUARD  = cyberpunk neon citadel (dark gloss, cyan/magenta neon, holo signage)
//   team 1 CRIMSON   = Mad Max scrap fortress (rust, war paint, bone, tires, fire, smoke)
// Exports:
//   makeModel(THREE, kind, team)            -> Object3D | null  (models face +X; userData.turret on turreted kinds)
//   updateModels(dt, t)                     -> drives shader time (neon blink/flicker, holo spin, flames, smoke)
//   decorateBase(THREE, scene, team, x, z)  -> Group of non-entity props around a cc (also added to scene)
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
function smokeMat() {
  return new T.ShaderMaterial({
    uniforms: { uTime: U.time, uColor: { value: new T.Vector3(0.16, 0.14, 0.13) } },
    transparent: true, depthWrite: false,
    vertexShader: `uniform float uTime; attribute vec3 aBase; attribute vec2 aPS; varying float vA; varying vec2 vUv;
      void main(){ float k = fract(uTime * 0.2 + aPS.x);
        vec4 wb = modelMatrix * vec4(aBase, 1.0);
        wb.xyz += vec3(sin(aPS.x * 40.0) * 0.5 * k + k * 1.6, k * 6.5 * aPS.y, cos(aPS.x * 23.0) * 0.5 * k);
        vec4 mv = viewMatrix * wb; float sz = aPS.y * (0.8 + k * 3.2);
        mv.xy += position.xy * sz; gl_Position = projectionMatrix * mv;
        vA = smoothstep(0.0, 0.1, k) * (1.0 - k); vUv = position.xy; }`,
    fragmentShader: `uniform vec3 uColor; varying float vA; varying vec2 vUv;
      void main(){ float d = length(vUv) * 2.0; float a = (1.0 - smoothstep(0.3, 1.0, d)) * vA * 0.75; if (a < 0.01) discard; gl_FragColor = vec4(uColor * (1.2 - d * 0.4), a); }`,
  });
}
const MATS = {};
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
  };
  else if (theme === 'C') m = {
    scrap: new T.MeshStandardMaterial({ vertexColors: true, map: rustTex(), metalness: 0.45, roughness: 0.7, envMap: env, envMapIntensity: 0.4 }),
    solid: new T.MeshStandardMaterial({ vertexColors: true, map: grimeTex(), metalness: 0.3, roughness: 0.7, envMap: env, envMapIntensity: 0.35 }),
    glow, fire: fireMat(), smoke: smokeMat(),
  };
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

// ---------------------------------------------------------------- Kit: collects geometry per material slot, merges on build
class Kit {
  constructor(theme) { this.theme = theme; this.s = {}; this.st = [null]; this.smokes = []; }
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
      const ax = Math.abs(nor.getX(i)), ay = Math.abs(nor.getY(i)), az = Math.abs(nor.getZ(i)), k = 0.32;
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
  smoke(p, n = 4, size = 1) { const v = new T.Vector3(...p).applyMatrix4(this.top()); for (let i = 0; i < n; i++) this.smokes.push([v.x, v.y, v.z, i / n + Math.random() * 0.1, size]); return this; }
  sign(p, ry, w, h, cell, fx = 2, color = 0xffffff, rx = 0) { return this.add('holo', plane(w, h), color, p, [rx, ry, 0], [1, 1, 1], { uv: cellUV(cell), fx: fx + Math.random() * 0.9, smooth: true }); }
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
    if (this.smokes.length) {
      const n = this.smokes.length, pos = new Float32Array(n * 12), ab = new Float32Array(n * 12), ps = new Float32Array(n * 8), idx = [];
      const corners = [-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5];
      this.smokes.forEach(([x, y, z, ph, sz], i) => {
        for (let c = 0; c < 4; c++) { pos.set([corners[c * 2], corners[c * 2 + 1], 0], (i * 4 + c) * 3); ab.set([x, y, z], (i * 4 + c) * 3); ps.set([ph, sz], (i * 4 + c) * 2); }
        idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
      });
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setAttribute('aBase', new T.BufferAttribute(ab, 3)); g.setAttribute('aPS', new T.BufferAttribute(ps, 2));
      g.setIndex(idx);
      const mesh = new T.Mesh(g, M.smoke || mats('C').smoke); mesh.frustumCulled = false; mesh.renderOrder = 3; mesh.raycast = () => {};
      grp.add(mesh);
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
    const p = polar(7.2, a, 2.0); k.sign(p, a - PI / 2 + PI / 2, 1.6, 2.6, cell, 2);
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
function cTotem(k, p, h = 3) { k.line('solid', p, [p[0], p[1] + h, p[2]], 0.09, C.soot, 5); k.bar('solid', [p[0], p[1] + h * 0.7, p[2] - 0.5], [p[0], p[1] + h * 0.7, p[2] + 0.5], 0.08, C.rust2); cSkull(k, [p[0], p[1] + h + 0.2, p[2]], 1); }
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
  // scrap mound base
  k.add('solid', cyl(7.6, 8.6, 0.6, 9), C.dirt, [0, 0.3, 0]);
  for (let i = 0; i < 14; i++) { const a = r() * TAU, d = 5 + r() * 3; k.add(r() < 0.5 ? 'scrap' : 'solid', box(0.8 + r() * 1.6, 0.3 + r() * 0.5, 0.6 + r() * 1.2), pick(r, [C.rust, C.rust2, C.steel2, C.rust3]), polar(d, a, 0.6), [(r() - 0.5) * 0.6, r() * 3, (r() - 0.5) * 0.6]); }
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
  for (const s of [1, -1]) { k.line('solid', [0.6, 3.0, s * 1.5], [0.4, 6.0, s * 1.5], 0.2, C.soot, 8); k.flame([0.4, 6.0, s * 1.5], 1.6, 0.35); k.smoke([0.4, 6.4, s * 1.5], 5, 1.4); }
  k.pop();
  // trailer half-buried behind
  cContainer(k, [-1.2, -0.3, 2.6], 0.35 + PI, 6.5, C.rust, 1);
  // scrap tower: stacked containers + scaffold watchtower + totem
  cContainer(k, [-3.0, 0.4, -2.2], 0.2, 5.0, C.rust2);
  cContainer(k, [-3.2, 2.8, -2.4], -0.35, 4.2, C.red);
  cContainer(k, [-3.0, 5.2, -2.1], 0.6, 3.4, C.bone, 0.95);
  cScaffold(k, [-3.0, 7.4, -2.1], 2.4, 2.4);
  k.flame([-2.0, 9.9, -1.2], 1.4, 0.3); k.smoke([-2.0, 10.4, -1.2], 4, 1.2);
  cTotem(k, [-4.0, 9.8, -3.0], 2.4);
  cPlates(k, r, 6, -5, -1, 1, 6, -3.6);
  // flame jets on the trailer roof (pipes)
  for (const p of [[-0.2, 2.6, 4.0], [-2.6, 2.6, 2.3]]) { k.line('solid', [p[0], 1.6, p[2]], p, 0.16, C.steel2, 6); k.flame(p, 1.2, 0.26); }
  // tire walls + drums + spikes ring
  for (let i = 0; i < 18; i++) { const a = i / 18 * TAU + 0.1; if (Math.cos(a) > 0.6 && Math.abs(Math.sin(a)) < 0.6) continue; for (let h = 0; h < 2 + (i % 2); h++) cTire(k, polar(7.6, a, 0.75 + h * 0.32), 0.62); }
  for (let i = 0; i < 12; i++) { const a = i / 12 * TAU + 0.25, b = polar(8.1, a, 0.5); cSpike(k, b, [Math.sin(a), 0.6, Math.cos(a)], 1.3, 0.12); }
  cDrum(k, [5.5, 0.6, -3.6], C.red, true); cDrum(k, [6.1, 0.6, -2.9], C.rust); cDrum(k, [-6.0, 0.6, 2.2], C.rust3, true);
  // war banners
  for (const p of [[3.5, 0.6, -5.5], [-5.5, 0.6, 3.8], [0.5, 0.6, -6.6]]) {
    k.line('solid', p, [p[0], p[1] + 5, p[2]], 0.08, C.soot, 5); k.bar('solid', [p[0], p[1] + 4.9, p[2]], [p[0], p[1] + 4.9, p[2] + 1.2], 0.08, C.soot);
    k.add('solid', box(0.05, 2.0, 1.1), C.red, [p[0], p[1] + 3.85, p[2] + 0.6], [0.05, 0, 0.04]);
    k.add('solid', box(0.06, 0.4, 0.4), C.bone, [p[0], p[1] + 4.0, p[2] + 0.6]);
  }
  cBarbed(k, [-6.8, 1.6, 3.6], [-3.5, 1.6, 6.8]);
  return fin(k.build(), 'cc', 12);
}
function C_barracks() {
  const k = new Kit('C'), r = rng(141);
  k.add('solid', bbox(9.0, 0.25, 7.2, 0.06), C.dirt, [0, 0.12, 0]);
  cContainer(k, [-0.6, 0.25, -1.55], 0, 7.0, C.rust);
  cContainer(k, [-0.6, 0.25, 1.15], 0, 7.0, C.red);
  cContainer(k, [-1.2, 2.65, -0.2], 0.12, 5.2, C.rust2);
  // lean-to corrugated roof over the door side
  k.add('scrap', box(2.0, 0.08, 6.6), C.rust3, [3.6, 3.0, -0.2], [0, 0, -0.35]);
  for (const z of [-3.2, 2.8]) k.bar('solid', [4.4, 0.25, z], [4.4, 2.75, z], 0.14, C.steel2);
  k.add('solid', box(0.15, 2.0, 1.6), 0x1e1612, [2.95, 1.25, 0.1]);
  for (let i = 0; i < 4; i++) k.add('solid', box(0.06, 0.08, 1.6), C.steel, [3.02, 0.6 + i * 0.45, 0.1]);
  k.add('glow', box(0.1, 0.12, 1.2), C.amber, [3.02, 2.38, 0.1], 0, 1, { fx: 3.4 });
  // war paint stripes + plates
  for (const s of [1, -1]) cPlates(k, r, 5, -3.8, 2.5, 0.6, 2.2, s * (s > 0 ? 2.32 : 2.72));
  k.add('solid', box(0.06, 0.5, 6.4), C.bone, [-4.08, 1.6, -0.2]);
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
  for (const s of [1, -1]) k.add('scrap', box(4.2, 4.0, 0.3), s > 0 ? C.red : C.rust2, [2.6, 2.25, s * 3.4], [0, 0, s * 0.02]);
  k.add('scrap', box(4.8, 0.1, 7.6), C.rust3, [2.7, 4.5, 0], [0, 0, -0.12]);
  k.add('scrap', box(6.0, 0.1, 4.0), C.rust2, [-2.3, 5.0, 1.8], [0.25, 0, 0]);
  k.add('scrap', box(6.0, 0.1, 4.0), C.rust, [-2.3, 5.0, -1.8], [-0.25, 0, 0]);
  k.add('solid', box(0.2, 3.8, 6.4), 0x1e1612, [0.52, 2.2, 0]);
  k.add('glow', box(0.12, 0.2, 5.0), C.amber, [0.66, 3.9, 0], 0, 1, { fx: 3.2 });
  cPlates(k, r, 8, -4.8, 0.2, 0.6, 4.0, 3.62); cPlates(k, r, 6, -4.8, 0.2, 0.6, 4.0, -3.62);
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
  // war-rig grille hanging on chains
  k.add('scrap', bbox(0.3, 3.2, 3.4, 0.06), C.red, [0, 2.05, 0]);
  for (let z = -1.45; z <= 1.46; z += 0.29) k.add('solid', box(0.14, 2.9, 0.09), C.steel, [0.12, 2.05, z]);
  k.add('solid', box(0.18, 0.35, 3.5), C.steel2, [0.15, 3.55, 0]); k.add('solid', box(0.18, 0.35, 3.5), C.steel2, [0.15, 0.6, 0]);
  for (const z of [-1.3, 1.3]) { k.add('glow', box(0.08, 0.3, 0.4), C.amber, [0.25, 3.0, z * 0.85], 0, 1, { fx: 3.4 }); for (let y = 3.8; y < 4.95; y += 0.16) k.add('solid', torus(0.07, 0.022, 3, 6), C.steel2, [0, y, z], [0, (y * 10 | 0) % 2 ? PI / 2 : 0, 0]); }
  for (const z of [-1.2, -0.4, 0.4, 1.2]) cSpike(k, [0.15, 0.45, z], [0.3, -1, 0], 0.5, 0.08, C.steel);
  return fin(k.build(), 'gate', 6.0);
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

// ---------------------------------------------------------------- registry
function fin(g, kind, height) { g.userData.kind = kind; g.userData.height = height; g.name = 'model_' + kind; return g; }
const BUILD = {
  V: { tank: V_tank, raider: V_raider, harvester: V_harvester, cc: V_cc, barracks: V_barracks, factory: V_factory, turret_mg: V_turret_mg, turret_cannon: V_turret_cannon, artillery: V_artillery, wall: V_wall, gate: V_gate },
  C: { tank: C_tank, raider: C_raider, harvester: C_harvester, cc: C_cc, barracks: C_barracks, factory: C_factory, turret_mg: C_turret_mg, turret_cannon: C_turret_cannon, artillery: C_artillery, wall: C_wall, gate: C_gate },
  N: { crystal: N_crystal, rock: N_rock },
};
const VARIANTS = { 'C:wall': 3, 'N:crystal': 4, 'N:rock': 4 };
const TPL = new Map();

export function makeModel(THREE, kind, team) {
  T = T || THREE;
  const theme = kind === 'crystal' || kind === 'rock' ? 'N' : team === 1 ? 'C' : 'V';
  const fn = BUILD[theme][kind]; if (!fn) return null;
  const nv = VARIANTS[`${theme}:${kind}`] || 1, v = nv > 1 ? (Math.random() * nv) | 0 : 0, key = `${theme}:${kind}:${v}`;
  if (!TPL.has(key)) TPL.set(key, fn(v));
  const o = TPL.get(key).clone();
  const tur = o.getObjectByName('turret'); if (tur) o.userData.turret = tur;
  return o;
}

export function updateModels(dt, t) {
  U.time.value = Number.isFinite(t) ? t : U.time.value + (dt || 0);
  if (TEX.scan) TEX.scan.offset.y = -U.time.value * 0.35;
}

// Non-entity props around a base. Keeps clear of cc/barracks/factory, the front lane (toward map centre),
// and the defense slots (turrets at R15-17 near the front, artillery at R11-12 at +-90deg and 180deg).
export function decorateBase(THREE, scene, team, x, z) {
  T = T || THREE;
  const theme = team === 1 ? 'C' : 'V', k = new Kit(theme), r = rng(team === 1 ? 777 : 555);
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
  spots.forEach(([px, pz], i) => {
    const lx = px - x, lz = pz - z, ry = r() * TAU;
    if (theme === 'C') {
      const t = i % 6;
      if (t === 0) { for (let h = 0; h < 4; h++) cTire(k, [lx + (r() - 0.5) * 0.4, 0.2 + h * 0.32, lz + (r() - 0.5) * 0.4], 0.62); cTire(k, [lx + 1.1, 0.2, lz + 0.4], 0.62); cTire(k, [lx + 0.6, 0.55, lz - 0.9], 0.62, true, r()); }
      else if (t === 1) { cDrum(k, [lx, 0, lz], C.red, true); cDrum(k, [lx + 0.8, 0, lz + 0.2], C.rust); cDrum(k, [lx + 0.3, 0, lz - 0.75], C.rust3, false, 1.5); }
      else if (t === 2) cHulk(k, [lx, 0, lz], ry, pick(r, [C.rust, C.red, C.rust2]), r() < 0.5);
      else if (t === 3) { for (let j = 0; j < 7; j++) k.add(r() < 0.5 ? 'scrap' : 'solid', box(0.6 + r() * 1.4, 0.2 + r() * 0.5, 0.5 + r() * 1.0), pick(r, [C.rust, C.rust2, C.steel2, C.red, C.rust3]), [lx + (r() - 0.5) * 2, 0.15 + r() * 0.6, lz + (r() - 0.5) * 2], [(r() - 0.5) * 0.8, r() * 3, (r() - 0.5) * 0.8]); cSpike(k, [lx, 0.5, lz], [0.2, 1, 0.1], 1.4, 0.1, C.steel); }
      else if (t === 4) cTotem(k, [lx, 0, lz], 2.6 + r());
      else { cScaffold(k, [lx, 0, lz], 2.0, 3.5); cDrum(k, [lx + 0.2, 3.55, lz], C.soot, true); }
    } else {
      const t = i % 5;
      if (t === 0) { // light pole
        k.add('lit', bbox(0.5, 0.2, 0.5, 0.05), V.trim, [lx, 0.1, lz]);
        k.line('lit', [lx, 0, lz], [lx, 4.2, lz], 0.08, V.body2, 6);
        k.bar('lit', [lx, 4.2, lz], [lx + 0.9, 4.4, lz], 0.1, V.body2);
        k.add('glow', box(0.6, 0.08, 0.25), i % 2 ? V.cyan : V.mag, [lx + 0.8, 4.3, lz]);
        k.add('holo', plane(3.0, 3.0), 0xffffff, [lx + 0.8, 0.06, lz], [-PI / 2, 0, 0], 1, { uv: cellUV(i % 2 ? 3 : 4), fx: 3.5, smooth: true });
      } else if (t === 1) { // holo billboard
        for (const d of [-1.2, 1.2]) k.line('lit', [lx + Math.cos(ry) * d, 0, lz - Math.sin(ry) * d], [lx + Math.cos(ry) * d, 4.5, lz - Math.sin(ry) * d], 0.1, V.body2, 6);
        k.sign([lx, 3.6, lz], ry, 3.0, 1.8, pick(r, [0, 1, 2]), 2);
        k.add('glow', box(0.2, 0.2, 0.2), V.red, [lx, 4.7, lz], 0, 1, { fx: 1.3 });
      } else if (t === 2) { // cable bundle
        for (let j = 0; j < 4; j++) { const off = (j - 1.5) * 0.18; k.line('lit', [lx - 3 * Math.cos(ry) + off, 0.1, lz + 3 * Math.sin(ry)], [lx + 3 * Math.cos(ry) + off, 0.1 + j * 0.03, lz - 3 * Math.sin(ry) + off], 0.08, j % 2 ? V.body2 : V.trim, 5); }
        k.add('glow', box(0.1, 0.1, 0.1), V.cyan, [lx, 0.22, lz]);
        k.add('lit', bbox(0.8, 0.9, 0.8, 0.06), V.trim, [lx + 3 * Math.cos(ry), 0.45, lz - 3 * Math.sin(ry)]);
        k.add('glow', box(0.82, 0.08, 0.82), V.cyan, [lx + 3 * Math.cos(ry), 0.7, lz - 3 * Math.sin(ry)], 0, 1, { fx: 3.2 });
      } else if (t === 3) { // vending kiosk
        k.push([lx, 0, lz], [0, ry, 0]);
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
  });
  const g = k.build('decor_' + theme); g.position.set(x, 0, z); g.userData.kind = 'decor';
  g.traverse(o => { if (o.isMesh) o.raycast = () => {}; });
  scene?.add(g);
  return g;
}
