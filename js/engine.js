// Vanguard engine: scene, 3 cameras, render loop, input + selection, ground, obstacles, meshes, overlay.
// TODO.md (engine):
//  - Models face local +X. If sim uses rot = atan2(dz, dx), set mesh.rotation.y = -rot.
//  - Tank/turret aim: rotate mesh.userData.turret.rotation.y (local, same +X convention).
//  - world.lights {hemi, sun} exposed for fx day/night tinting.
//  - Ground plane is 3x map size; out-of-bounds darkening is a shader patch on world.ground.material.
//    Fog near/far is set per view in placeCamera (fx only lerps fog colour).
//  - Wardens are animated squads (js/characters.js, assets/chars/soldier.glb); primitive capsules if the GLB fails.
//    mesh.userData.anim.play(name) pins a clip (idle/walk/fire/reload/die/harvest/melee); otherwise driven by entity state.
//  - Non-warden kinds route through models.js makeModel() when present; primitives are the fallback.
//  - Rendering: ACES, PCF-soft sun shadow fitted to the view (?shadows=0|1024), HDRI scene.environment
//    (?hdri=resting|harbour|none), envMapIntensity scaled per material (r160 has no scene.environmentIntensity).
//  - ?gallery=1: warden lineup for screenshots (tools/gallery-shots.mjs).
import * as THREE from 'three';

const VIEWS = {
  aerial:   { zoom: 34, min: 16, max: 48 },             // ortho half-height
  tactical: { pitch: 68, fov: 50, zoom: 38, min: 22, max: 100 },  // zoom = camera distance
  low:      { pitch: 40, fov: 55, zoom: 30, min: 16, max: 46 },
};
const BASES = [{ x: -55, z: 25 }, { x: 55, z: -25 }];

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

export async function createEngine() {
  const glCanvas = document.getElementById('gl');
  const overlay = document.getElementById('overlay');
  for (const c of [glCanvas, overlay]) c.style.touchAction = 'none';
  const octx = overlay.getContext('2d');

  const params = new URLSearchParams(location.search);
  // optional modules: start fetching in parallel right away, await where needed
  const modelsP = import('./models.js').then(async (m) => { // GRAPHICS-B: preload PBR textures + cannon before spawning
    try { await m.preloadModels?.(THREE); } catch (err) { console.warn('[engine] preloadModels failed', err?.message); }
    try { const r = await import('./roster.js'); const R = r.ROSTER || r.default; if (R) m.setRoster?.(R); } catch { /* roster.js optional */ }
    return m;
  });
  const charsP = import('./characters.js').then((c) => c.loadCharacters(null).then(() => c));
  // TERRAIN worker's js/terrain.js (v2 map/biomes): when it exports createTerrain, it replaces the
  // legacy ground plane + rock obstacles below. Missing module → legacy behaviour.
  // A missing module would log a 404 console error (fails smoke tests), so this is a switch, not a probe:
  // flip TERRAIN_MODULE to true once js/terrain.js lands (or test with ?terrain=1 / ?terrain=0).
  const TERRAIN_MODULE = true;
  const useTerrain = params.has('terrain') ? params.get('terrain') === '1' : TERRAIN_MODULE;
  const terrainP = useTerrain ? import('./terrain.js') : Promise.resolve({});
  modelsP.catch(() => {}); charsP.catch(() => {}); terrainP.catch(() => {});
  const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, powerPreference: 'high-performance' });
  // Quality: ?q=low|med|high, else saved choice, else med on touch devices / high on desktop.
  //  low: no shadows, no ground normal/AO maps, gradient env (no HDRI), pixel ratio 1
  //  med: 1024 shadow map, full ground, HDRI, pixel ratio <= 1.5      high: 2048 shadows, pixel ratio <= 2
  const QUALITIES = ['low', 'med', 'high'];
  let savedQ = null; try { savedQ = localStorage.getItem('vanguard.quality'); } catch { /* private mode */ }
  const touch = (navigator.maxTouchPoints || 0) > 0 || matchMedia?.('(pointer: coarse)')?.matches;
  const QUALITY = QUALITIES.includes(params.get('q')) ? params.get('q') : QUALITIES.includes(savedQ) ? savedQ : (touch ? 'med' : 'high');
  const DPR_CAP = { low: 1, med: 1.5, high: 2 }[QUALITY];
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, DPR_CAP));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  // Shadows: one PCF-soft directional map whose frustum tracks the visible ground (see fitShadow).
  // ?shadows=0 turns them off, ?shadows=1024 picks a smaller map.
  const SHADOW = params.get('shadows') === '0' ? 0 : (+params.get('shadows') || { low: 0, med: 1024, high: 2048 }[QUALITY]);
  renderer.shadowMap.enabled = SHADOW > 0;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const SKY = 0xb7a58e; // hazy late-afternoon sky; fog matches so the horizon dissolves
  renderer.setClearColor(SKY);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 220, 520);

  // fx.js day/night finds the first DirectionalLight + HemisphereLight by scene.traverse; keep exactly one of each.
  const sun = new THREE.DirectionalLight(0xffc996, 2.9);   // warm low key light from the south-west
  const SUN_DIR = new THREE.Vector3(-0.55, 0.62, 0.56).normalize(); // toward the sun (x west, z south)
  sun.position.copy(SUN_DIR).multiplyScalar(120);
  sun.castShadow = SHADOW > 0;
  if (SHADOW) {
    sun.shadow.mapSize.set(SHADOW, SHADOW);
    sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.04; sun.shadow.radius = 2.5;
    sun.shadow.camera.near = 1; sun.shadow.camera.far = 400;
  }
  const hemi = new THREE.HemisphereLight(0x9fbce6, 0x7a5434, 1.25); // cool sky fill, warm ground bounce
  scene.add(sun, sun.target, hemi);
  // Small prefiltered sky/ground gradient (+ warm sun spot) used as envMap by metallic materials (soldiers);
  // exposed as world.envMap so models.js can opt in. Not set as scene.environment (keeps Lambert looks unchanged).
  let envMap = null;
  try {
    const es = new THREE.Scene();
    const sg = new THREE.SphereGeometry(10, 24, 12), col = [], pa = sg.attributes.position;
    const top = new THREE.Color(0x8fb4e8), hor = new THREE.Color(0xe6cfae), bot = new THREE.Color(0x6a4a30), c = new THREE.Color();
    for (let i = 0; i < pa.count; i++) {
      const y = pa.getY(i) / 10;
      if (y > 0) c.copy(hor).lerp(top, Math.pow(y, 0.6)); else c.copy(hor).lerp(bot, Math.min(1, -y * 3));
      col.push(c.r, c.g, c.b);
    }
    sg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    es.add(new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
    const spot = new THREE.Mesh(new THREE.SphereGeometry(1.1, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffd7a8).multiplyScalar(6) }));
    spot.position.copy(SUN_DIR).multiplyScalar(8.5); es.add(spot);
    const pm = new THREE.PMREMGenerator(renderer);
    envMap = pm.fromScene(es, 0.02).texture; pm.dispose();
  } catch (err) { console.warn('[engine] env map failed', err?.message); }
  scene.environment = envMap; // replaced by the HDRI below once it loads

  // Image-based lighting: Poly Haven HDRI → PMREM → scene.environment (not shown as background).
  // r160 has no scene.environmentIntensity, so envMapIntensity is scaled per material (trackEnv):
  // ENV_I for materials using scene.environment, and everything dims with world.ui.nightFactor.
  const HDRI = { harbour: 'small_harbour_morning_1k.hdr', resting: 'resting_place_2_1k.hdr' };
  const ENV_I = 0.6, envMats = new Set();
  let envNight = 1;
  function applyEnv(m) { m.envMapIntensity = m.userData.envBase * (m.envMap ? 1 : ENV_I) * envNight; }
  function trackEnv(root) {
    root?.traverse?.((o) => {
      const ms = o.material; if (!ms) return;
      for (const m of Array.isArray(ms) ? ms : [ms]) {
        if (!(m.isMeshStandardMaterial) || envMats.has(m)) continue;
        if (m.userData.envBase === undefined) m.userData.envBase = m.envMapIntensity;
        envMats.add(m); applyEnv(m);
      }
    });
  }
  function updateEnvNight() {
    const nf = Math.min(1, Math.max(0, +world.ui?.nightFactor || 0)), v = 1 - 0.7 * nf;
    if (Math.abs(v - envNight) < 0.01) return;
    envNight = v; for (const m of envMats) applyEnv(m);
  }
  if (params.get('hdri') !== 'none' && QUALITY !== 'low') (async () => {
    try {
      const { RGBELoader } = await import('three/addons/loaders/RGBELoader.js');
      const hdr = await new RGBELoader().loadAsync('assets/ph/hdri/' + (HDRI[params.get('hdri')] || HDRI.resting));
      const pm = new THREE.PMREMGenerator(renderer);
      scene.environment = pm.fromEquirectangular(hdr).texture; pm.dispose(); hdr.dispose();
    } catch (err) { console.warn('[engine] HDRI failed, keeping gradient env:', err?.message || err); }
  })();

  // GRAPHICS-B themed models (optional; primitives below are the fallback)
  let models = null;
  try { models = await modelsP; if (typeof models.makeModel !== 'function') models = null; }
  catch (err) { console.warn('[engine] models.js not loaded, using primitives:', err?.message || err); }

  const world = {
    THREE, scene, renderer, camera: null,
    clock: { t: 0, dt: 0, speed: 1 },
    map: { w: 160, h: 100 },
    obstacles: [],
    teams: { P: 0, E: 1 },
    colors: { 0: 0x2f7cff, 1: 0xe23a3a },
    entities: [],
    bus: new EventTarget(),
    input: { tap: null, drag: null, selected: new Set(), command: null },
    ui: { crystals: 0, supply: 0, supplyCap: 0, time: 0, phase: 'day',
          queues: { barracks: [], factory: [] }, defenseTier: 0, enemyTier: 0,
          message: null, gameOver: null },
    lights: { hemi, sun },
    quality: QUALITY, qualities: QUALITIES,
    setQuality: (q) => { if (!QUALITIES.includes(q)) return; try { localStorage.setItem('vanguard.quality', q); } catch {} location.reload(); },
    envMap,
    camTarget: { x: BASES[0].x + 17, z: BASES[0].z + 1 }, // base sits left-center of the opening view
    view: 'tactical',
    views: VIEWS,
  };

  // ---------- Cameras ----------
  const cams = {
    aerial: new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 600),
    tactical: new THREE.PerspectiveCamera(VIEWS.tactical.fov, 1, 1, 900),
    low: new THREE.PerspectiveCamera(VIEWS.low.fov, 1, 1, 900),
  };
  cams.aerial.up.set(0, 0, -1); // north (-z) up on screen
  world.camera = cams.tactical;
  let W = 1, H = 1, dpr = 1;

  // Keep the view mostly over the map: at most OFF of the visible ground span may hang past an edge.
  // Extents are measured from the real camera (perspective views see a trapezoid), translation-invariant.
  const OFF = 0.3;
  function placeCamera(cam, v, t) {
    if (world.view === 'aerial') {
      const a = W / H;
      cam.left = -v.zoom * a; cam.right = v.zoom * a; cam.top = v.zoom; cam.bottom = -v.zoom;
      cam.position.set(t.x, 300, t.z);
    } else {
      const p = THREE.MathUtils.degToRad(v.pitch);
      cam.aspect = W / H;
      cam.position.set(t.x, Math.sin(p) * v.zoom, t.z + Math.cos(p) * v.zoom);
    }
    cam.lookAt(t.x, 0, t.z);
    if (scene.fog) { // keep fog off the playfield in every view; only the far out-of-bounds ground fades
      if (world.view === 'aerial') { scene.fog.near = 700; scene.fog.far = 1200; }
      else { scene.fog.near = v.zoom * 2.4; scene.fog.far = v.zoom * 6 + 120; }
    }
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }
  function clampTarget(cam, v) {
    const t = world.camTarget, hw = world.map.w / 2, hh = world.map.h / 2;
    placeCamera(cam, v, t);
    const L = world.groundAt(0, H * 0.5), R = world.groundAt(W, H * 0.5);
    // perspective views: measure the far edge a little below the top so the stretched horizon band
    // doesn't dominate the span (the low view sees ~130u deep at max zoom).
    const ty = world.view === 'low' ? H * 0.22 : world.view === 'tactical' ? H * 0.08 : 0;
    const T = world.groundAt(W * 0.5, ty) || world.groundAt(W * 0.5, H * 0.3), B = world.groundAt(W * 0.5, H);
    if (!L || !R || !T || !B) return;
    const eL = t.x - L.x, eR = R.x - t.x, eT = t.z - T.z, eB = B.z - t.z;
    const clamp1 = (c, lo, hi) => (lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, c)));
    const sx = (eL + eR) * OFF, sz = (eT + eB) * OFF;
    t.x = clamp1(t.x, -hw + eL - sx, hw - eR + sx);
    t.z = clamp1(t.z, -hh + eT - sz, hh - eB + sz);
  }
  let mapKey = '';
  function updateCamera() {
    const mk = world.map.w + 'x' + world.map.h;
    if (mk !== mapKey) { // zoom-out limits scale with the map (v1 160x100 → v2 512x320)
      mapKey = mk; const k = Math.max(1, world.map.w / 160);
      VIEWS.aerial.max = Math.max(48, world.map.h * 0.5 + 4); VIEWS.tactical.max = 100 * Math.min(k, 1.6); VIEWS.low.max = 46 * Math.min(k, 1.3);
      for (const n in VIEWS) VIEWS[n].zoom = Math.min(VIEWS[n].zoom, VIEWS[n].max);
      for (const c of Object.values(cams)) if (c.isPerspectiveCamera) c.far = Math.max(900, world.map.w * 2.2); else c.far = 600;
    }
    const v = VIEWS[world.view], cam = cams[world.view];
    clampTarget(cam, v);
    placeCamera(cam, v, world.camTarget);
  }
  world.setView = (name) => {
    if (!cams[name]) return;
    world.view = name; world.camera = cams[name];
    updateCamera();
    world.bus.dispatchEvent(new CustomEvent('view', { detail: { name } }));
  };
  world.cycleView = () => {
    const order = ['aerial', 'tactical', 'low'];
    world.setView(order[(order.indexOf(world.view) + 1) % 3]);
  };
  world.zoomBy = (f) => {
    const v = VIEWS[world.view];
    v.zoom = Math.max(v.min, Math.min(v.max, v.zoom * f));
    updateCamera();
  };
  world.jumpTo = (x, z) => { world.camTarget.x = x; world.camTarget.z = z; updateCamera(); };

  const _v = new THREE.Vector3();
  world.project = (x, y, z) => {
    _v.set(x, y, z).project(world.camera);
    return { x: (_v.x + 1) / 2 * W, y: (1 - _v.y) / 2 * H, visible: _v.z < 1 && _v.z > -1 };
  };

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  function setRay(sx, sy) {
    ndc.set(sx / W * 2 - 1, -(sy / H) * 2 + 1);
    raycaster.setFromCamera(ndc, world.camera);
  }
  world.groundAt = (sx, sy) => {
    setRay(sx, sy);
    const p = new THREE.Vector3();
    return raycaster.ray.intersectPlane(groundPlane, p) ? { x: p.x, z: p.z } : null;
  };
  // Returns the top-of-view world rectangle corners on ground (for minimap viewport).
  world.viewCorners = () => [[0, 0], [W, 0], [W, H], [0, H]].map(([x, y]) => world.groundAt(x, y) || world.groundAt(x, H * 0.35) || { x: 0, z: 0 });

  function resize() {
    const vv = window.visualViewport;
    W = Math.max(1, Math.round(vv ? vv.width : window.innerWidth));
    H = Math.max(1, Math.round(vv ? vv.height : window.innerHeight));
    dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    renderer.setPixelRatio(dpr);
    renderer.setSize(W, H);
    overlay.width = Math.round(W * dpr); overlay.height = Math.round(H * dpr);
    overlay.style.width = W + 'px'; overlay.style.height = H + 'px';
    updateCamera();
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 200));
  window.visualViewport?.addEventListener('resize', resize);
  world.size = () => ({ w: W, h: H, dpr });

  let terrain = null;
  try {
    const tm = await terrainP;
    if (typeof tm.createTerrain === 'function') terrain = await tm.createTerrain(world);
  } catch (err) { terrain = null; if (!/Failed to fetch|Cannot find|404|Importing a module/i.test(err?.message || '')) console.warn('[engine] terrain.js failed, using legacy ground:', err?.message || err); }
  world.terrain = terrain;

  if (!terrain) { // ---------- Legacy ground + obstacles (v1) ----------
  // ---------- Ground ----------
  function groundCanvas() {
    const S = 512, c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d'), r = rng(7);
    g.fillStyle = '#c98f55'; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 2600; i++) { // mottling
      const x = r() * S, y = r() * S, s = 2 + r() * 14, l = r();
      g.fillStyle = l < 0.5 ? `rgba(150,92,48,${0.04 + r() * 0.07})` : `rgba(232,180,120,${0.04 + r() * 0.07})`;
      g.beginPath(); g.arc(x, y, s, 0, 7); g.fill();
    }
    for (let i = 0; i < 9000; i++) { // grit
      g.fillStyle = `rgba(${r() < 0.5 ? '90,55,30' : '245,210,160'},${0.08 + r() * 0.12})`;
      g.fillRect(r() * S, r() * S, 1.2, 1.2);
    }
    g.lineCap = 'round';
    for (let i = 0; i < 26; i++) { // cracks (drawn with wraparound for tiling)
      let x = r() * S, y = r() * S, a = r() * Math.PI * 2;
      const n = 6 + (r() * 12) | 0;
      g.strokeStyle = `rgba(105,62,32,${0.18 + r() * 0.22})`; g.lineWidth = 0.6 + r() * 1.2;
      for (let k = 0; k < n; k++) {
        const nx = x + Math.cos(a) * (6 + r() * 14), ny = y + Math.sin(a) * (6 + r() * 14);
        for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
          g.beginPath(); g.moveTo(x + ox, y + oy); g.lineTo(nx + ox, ny + oy); g.stroke();
        }
        x = nx; y = ny; a += (r() - 0.5) * 1.3;
      }
    }
    return c;
  }
  // Ground: one plane 3x the map, same texture everywhere; a shader patch darkens + desaturates
  // everything outside the playable rect so the edge reads as "out of bounds", not a cliff.
  const EXT = 3, TILE = { x: 6, z: 4 }; // texture repeats across the playable map
  const PH_TILE = { x: 12, z: 8 }; // rocky_terrain_02 PBR set: rocks read at tactical zoom
  function prepTex(t, tile = TILE, srgb = true) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(tile.x * EXT, tile.z * EXT);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    t.needsUpdate = true;
    return t;
  }
  const groundTex = prepTex(new THREE.CanvasTexture(groundCanvas()));
  const groundMat = new THREE.MeshStandardMaterial({ map: groundTex, roughness: 1, metalness: 0 });
  // average linear luminance of the ground texture, so the detail layers below are brightness-neutral
  const uAvg = { value: 0.35 };
  // rgb = desert hue normalised to luminance 1, w = target average linear albedo
  const uTint = { value: new THREE.Vector4(1, 1, 1, 0.35) };
  const setTint = (hex, albedo) => {
    const c = new THREE.Color(hex), l = c.r * 0.299 + c.g * 0.587 + c.b * 0.114;
    uTint.value.set(c.r / l, c.g / l, c.b / l, albedo);
  };
  setTint(0xd4824a, 0.27);
  function measureTex(img) {
    try {
      const c = document.createElement('canvas'); c.width = c.height = 32;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0, 32, 32);
      const d = g.getImageData(0, 0, 32, 32).data; let sum = 0;
      const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      for (let i = 0; i < d.length; i += 4) sum += (lin(d[i]) + lin(d[i + 1]) + lin(d[i + 2])) / 3;
      uAvg.value = Math.max(0.05, sum / (d.length / 4));
    } catch { /* keep default */ }
  }
  measureTex(groundTex.image);
  groundMat.onBeforeCompile = (sh) => {
    sh.uniforms.uMapHalf = { value: new THREE.Vector2(world.map.w / 2, world.map.h / 2) };
    sh.uniforms.uAvg = uAvg; sh.uniforms.uTint = uTint;
    sh.vertexShader = 'varying vec3 vGW;\n' + sh.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\n  vGW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = 'varying vec3 vGW;\nuniform vec2 uMapHalf;\nuniform float uAvg;\nuniform vec4 uTint;\n' + sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
  { // detail breakup: the same texture at two rotated, larger scales multiplied in hides the 6x4 tiling
    vec2 uvA = mat2(0.8, -0.6, 0.6, 0.8) * vMapUv * 0.31 + vec2(0.37, 0.11);
    vec2 uvB = mat2(0.6, 0.8, -0.8, 0.6) * vMapUv * 0.087 + vec2(0.71, 0.53);
    float la = dot(texture2D(map, uvA).rgb, vec3(0.3333));
    float lb = dot(texture2D(map, uvB, 1.5).rgb, vec3(0.3333));
    float k = clamp(mix(1.0, la / uAvg, 0.55) * mix(1.0, lb / uAvg, 0.9), 0.55, 1.5);
    diffuseColor.rgb *= k;
    // desert grade: pull the (grey-brown) texture toward the warm palette at constant luminance, then
    // normalise its average albedo to uTint.w so any ground texture lands at the same brightness
    float gl = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
    diffuseColor.rgb = mix(diffuseColor.rgb, gl * uTint.rgb, 0.7) * (uTint.w / uAvg);
  }
  {
    vec2 q = max(abs(vGW.xz) - uMapHalf, 0.0);
    float d = length(q);
    float k = smoothstep(0.0, 6.0, d) * 0.6 + smoothstep(6.0, 80.0, d) * 0.4;
    float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(lum) * vec3(0.95, 0.9, 0.86), k * 0.8) * (1.0 - k * 0.6);
    float rim = (1.0 - smoothstep(0.0, 1.6, d)) * step(0.001, d);
    diffuseColor.rgb *= 1.0 - rim * 0.25;
  }`);
  };
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(world.map.w * EXT, world.map.h * EXT), groundMat);
  ground.rotation.x = -Math.PI / 2; ground.name = 'ground'; ground.receiveShadow = true;
  scene.add(ground);
  { // playable boundary: thin dark dashed rectangle on the ground
    const w = world.map.w, h = world.map.h, th = 0.45, dash = 3, gap = 2.2, pos = [];
    const quad = (x0, z0, x1, z1) => pos.push(x0, 0, z0, x0, 0, z1, x1, 0, z1, x0, 0, z0, x1, 0, z1, x1, 0, z0);
    for (const [ax, az, bx, bz] of [[-w / 2, -h / 2, w / 2, -h / 2], [w / 2, -h / 2, w / 2, h / 2], [w / 2, h / 2, -w / 2, h / 2], [-w / 2, h / 2, -w / 2, -h / 2]]) {
      const len = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / len, uz = (bz - az) / len;
      for (let s = 0; s < len; s += dash + gap) {
        const e = Math.min(len, s + dash);
        const x0 = ax + ux * s, z0 = az + uz * s, x1 = ax + ux * e, z1 = az + uz * e;
        if (ux) quad(Math.min(x0, x1), z0 - th / 2, Math.max(x0, x1), z0 + th / 2);
        else quad(x0 - th / 2, Math.min(z0, z1), x0 + th / 2, Math.max(z0, z1));
      }
    }
    const bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const border = new THREE.Mesh(bg, new THREE.MeshBasicMaterial({ color: 0x24180f, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }));
    border.position.y = 0.04; border.renderOrder = 1; border.name = 'mapBorder'; scene.add(border);
  }
  world.ground = ground;
  world.setGroundTexture = (url) => new THREE.TextureLoader().load(url, (t) => {
    prepTex(t); measureTex(t.image); groundMat.map = t; groundMat.needsUpdate = true;
  }, undefined, () => console.warn('[engine] ground texture failed to load, keeping procedural:', url));
  // Ground = Poly Haven rocky_terrain_02 (diff + GL normal + ARM: R=AO, G=roughness; metalness skipped),
  // warm-tinted toward the desert palette. Falls back to assets/ground.jpg, then to the procedural canvas.
  {
    const L = new THREE.TextureLoader(), base = 'assets/ph/rocky_terrain_02/';
    const load = (f) => new Promise((res, rej) => L.load(base + f, res, undefined, rej));
    Promise.all([load('diff.jpg'), load('nor_gl.jpg'), load('arm.jpg')]).then(([d, n, a]) => {
      prepTex(d, PH_TILE); prepTex(n, PH_TILE, false); prepTex(a, PH_TILE, false);
      measureTex(d.image);
      groundMat.map = d;
      if (QUALITY !== 'low') {
        groundMat.normalMap = n; groundMat.normalScale.set(1, 1);
        groundMat.aoMap = a; groundMat.aoMapIntensity = 0.8; groundMat.roughnessMap = a; groundMat.roughness = 1;
      }
      groundMat.needsUpdate = true;
    }).catch(() => { console.warn('[engine] PBR ground failed, using ground.jpg'); world.setGroundTexture('assets/ground.jpg'); });
  }

  // ---------- Obstacles ----------
  const rockMat = new THREE.MeshLambertMaterial({ color: 0x8a8580, flatShading: true });
  const rockMat2 = new THREE.MeshLambertMaterial({ color: 0x6f6a66, flatShading: true });
  {
    const r = rng(1337), A = BASES[0], B = BASES[1];
    const laneDist = (x, z) => { // distance to base-to-base segment
      const dx = B.x - A.x, dz = B.z - A.z, t = Math.max(0, Math.min(1, ((x - A.x) * dx + (z - A.z) * dz) / (dx * dx + dz * dz)));
      return Math.hypot(x - (A.x + dx * t), z - (A.z + dz * t));
    };
    let tries = 0;
    while (world.obstacles.length < 14 && tries++ < 2000) {
      const rad = 2.5 + r() * 3.2;
      const x = (r() - 0.5) * (world.map.w - 16), z = (r() - 0.5) * (world.map.h - 12);
      if (BASES.some(b => Math.hypot(x - b.x, z - b.z) < 30 + rad)) continue;
      if (laneDist(x, z) < 12 + rad) continue;
      if (world.obstacles.some(o => Math.hypot(x - o.x, z - o.z) < o.r + rad + 5)) continue;
      world.obstacles.push({ x, z, r: rad });
      const grp = new THREE.Group();
      const main = new THREE.Mesh(new THREE.DodecahedronGeometry(rad, 0), r() < 0.5 ? rockMat : rockMat2);
      main.scale.set(1, 0.55 + r() * 0.5, 0.85 + r() * 0.3); main.rotation.set(r(), r() * 6, r());
      grp.add(main);
      for (let k = 0; k < 2; k++) {
        const sm = new THREE.Mesh(new THREE.ConeGeometry(rad * (0.3 + r() * 0.25), rad * (0.6 + r() * 0.8), 5), rockMat2);
        const a = r() * 6.28; sm.position.set(Math.cos(a) * rad * 0.8, rad * 0.25, Math.sin(a) * rad * 0.8);
        sm.rotation.set((r() - 0.5) * 0.5, r() * 6, (r() - 0.5) * 0.5); grp.add(sm);
      }
      const mdl = models?.makeModel?.(THREE, 'rock', -1); // GRAPHICS-B themed rock (unit radius)
      if (mdl) { grp.clear(); mdl.scale.setScalar(rad); mdl.rotation.y = Math.random() * 6.28; grp.add(mdl); trackEnv(mdl); }
      grp.position.set(x, 0, z); grp.userData.kind = 'rock';
      grp.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      scene.add(grp);
    }
  }

  } // end legacy ground + obstacles

  // ---------- Meshes ----------
  const matCache = new Map();
  function mat(color, opts = {}) {
    const key = color + JSON.stringify(opts);
    if (!matCache.has(key)) matCache.set(key, new THREE.MeshLambertMaterial({ color, flatShading: true, ...opts }));
    return matCache.get(key);
  }
  const geoCache = new Map();
  const geo = (key, make) => (geoCache.has(key) ? geoCache.get(key) : (geoCache.set(key, make()), geoCache.get(key)));
  function box(w, h, d, m, x = 0, y = 0, z = 0) {
    const o = new THREE.Mesh(geo(`b${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d)), m); o.position.set(x, y, z); return o;
  }
  function cyl(rt, rb, h, seg, m, x = 0, y = 0, z = 0) {
    const o = new THREE.Mesh(geo(`c${rt},${rb},${h},${seg}`, () => new THREE.CylinderGeometry(rt, rb, h, seg)), m); o.position.set(x, y, z); return o;
  }
  const shade = (hex, f) => new THREE.Color(hex).multiplyScalar(f).getHex();
  const SLATE = 0x6c7682, DARK = 0x2a2f36, METAL = 0x9aa3ad, LIGHTSLATE = 0x98a1ab;
  const PLATE = mat(0x33383f), LAMP = mat(0xffd27a, { emissive: 0x8a5a00 }), HAZ = mat(0xd9a521);
  // Base plate: slightly larger than the footprint, chamfered slab so buildings sit on the ground.
  // hx/hz are half extents; pass hz==null for a hex plate of radius hx.
  function plate(hx, hz, ox = 0) {
    if (hz == null) return cyl(hx, hx + 0.4, 0.3, 6, PLATE, 0, 0.15, 0);
    return box(hx * 2, 0.3, hz * 2, PLATE, ox, 0.15, 0);
  }

  const makePrimitive = (kind, team = -1) => {
    const tc = world.colors[team] ?? 0xbbbbbb;
    const T = mat(tc), Td = mat(shade(tc, 0.6)), S = mat(SLATE), D = mat(DARK), M = mat(METAL), L = mat(LIGHTSLATE);
    const LIGHT = mat(tc, { emissive: tc, emissiveIntensity: 0.7 }), GLOW = mat(0x39d8ff, { emissive: 0x1aa0cc });
    const g = new THREE.Group();
    switch (kind) {
      case 'warden': {
        const capG = geo('cap', () => new THREE.CapsuleGeometry(0.36, 0.7, 3, 8));
        for (const [ox, oz] of [[0.55, 0], [-0.35, 0.5], [-0.35, -0.5]]) {
          const s = new THREE.Group();
          const body = new THREE.Mesh(capG, T); body.position.y = 0.6; s.add(body);
          s.add(box(0.18, 0.14, 0.42, D, 0.24, 1.0, 0)); // visor
          { const t = cyl(0.08, 0.08, 0.8, 6, D, -0.05, 0.85, 0.32); t.rotation.z = Math.PI / 2; s.add(t); } // rocket tube
          s.position.set(ox, 0, oz); g.add(s);
        }
        break;
      }
      case 'raider': {
        const wedge = new THREE.Mesh(geo('wedge', () => {
          const sh = new THREE.Shape(); sh.moveTo(-1.5, 0); sh.lineTo(1.6, 0); sh.lineTo(1.6, 0.25); sh.lineTo(-1.2, 0.8); sh.lineTo(-1.5, 0.8);
          const gg = new THREE.ExtrudeGeometry(sh, { depth: 1.6, bevelEnabled: false }); gg.translate(0, 0, -0.8); return gg;
        }), T);
        wedge.position.y = 0.45; g.add(wedge);
        for (const [x, z] of [[1, 0.9], [1, -0.9], [-1, 0.9], [-1, -0.9]]) g.add(cyl(0.42, 0.42, 0.35, 10, D, x, 0.42, z)).rotation.x = Math.PI / 2;
        const bar = new THREE.Group();
        bar.add(box(0.12, 0.8, 0.12, M, 0, 0.4, 0.6), box(0.12, 0.8, 0.12, M, 0, 0.4, -0.6), box(0.12, 0.12, 1.32, M, 0, 0.8, 0));
        bar.position.set(-0.6, 1.1, 0); g.add(bar);
        g.add(box(0.6, 0.12, 0.12, D, 0.3, 1.5, 0)); // MG
        break;
      }
      case 'tank': {
        g.add(box(3.6, 0.9, 2.6, T, 0, 0.75, 0));
        g.add(box(3.9, 0.7, 0.6, D, 0, 0.4, 1.25), box(3.9, 0.7, 0.6, D, 0, 0.4, -1.25));
        const tur = new THREE.Group(); tur.position.y = 1.2;
        tur.add(cyl(0.95, 1.1, 0.7, 10, Td, 0, 0.35, 0));
        const barrel = cyl(0.17, 0.2, 2.6, 8, M, 1.9, 0.4, 0); barrel.rotation.z = Math.PI / 2; tur.add(barrel);
        g.add(tur); g.userData.turret = tur;
        break;
      }
      case 'harvester': {
        g.add(box(3.4, 0.5, 2.2, D, 0, 0.45, 0));
        g.add(box(1.2, 1.3, 2.0, T, 1.2, 1.3, 0));
        g.add(box(0.2, 0.5, 1.6, mat(0x9fe8ff, { emissive: 0x1b4d5c }), 1.85, 1.5, 0));
        const hop = box(2.0, 1.2, 2.1, Td, -0.6, 1.3, 0); g.add(hop);
        g.add(box(1.7, 0.2, 1.8, mat(0x45e0ff, { emissive: 0x0f6b86 }), -0.6, 1.85, 0));
        break;
      }
      case 'cc': {
        g.add(plate(9.6));
        g.add(cyl(8, 8.4, 1.4, 6, S, 0, 0.7, 0));                 // foundation hex
        g.add(cyl(6.2, 7.2, 3.0, 6, L, 0, 2.9, 0));               // main hex (structure)
        g.add(cyl(7.25, 7.25, 0.7, 6, T, 0, 3.0, 0));             // team band (panel)
        g.add(cyl(4.2, 5.2, 2.0, 6, S, 0, 5.4, 0));               // upper tier
        g.add(cyl(4.25, 4.25, 0.35, 6, Td, 0, 6.1, 0));
        for (let i = 0; i < 6; i++) {                             // ring of 6 pylons on the foundation corners
          const a = i / 6 * Math.PI * 2 + Math.PI / 6, rx = Math.cos(a) * 7.4, rz = Math.sin(a) * 7.4;
          g.add(box(0.8, 2.6, 0.8, D, rx, 2.7, rz));
          g.add(box(0.95, 0.35, 0.95, T, rx, 4.1, rz));
          g.add(box(0.4, 0.3, 0.4, LIGHT, rx, 4.4, rz));
        }
        g.add(cyl(0.45, 0.95, 6.2, 6, M, 0, 9.5, 0));             // central spire
        g.add(cyl(1.1, 1.1, 0.35, 6, T, 0, 8.2, 0));
        g.add(cyl(0.18, 0.18, 2.2, 6, D, 0, 13.6, 0));            // dish mast
        const dish = new THREE.Mesh(geo('dish', () => new THREE.SphereGeometry(1.7, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2.6)), mat(0xd8dde3, { side: THREE.DoubleSide }));
        dish.position.set(0.3, 14.9, 0); dish.rotation.set(Math.PI * 0.82, 0, 0.5); g.add(dish);
        g.add(cyl(1.2, 1.2, 0.4, 6, GLOW, 0, 6.5, 0));
        break;
      }
      case 'barracks': {
        g.add(plate(5.9, 4));
        g.add(box(8, 3.4, 6.4, L, 0, 1.9, 0));                    // main hall
        for (const z of [3.22, -3.22]) { g.add(box(5.4, 1.3, 0.1, T, -0.9, 2.3, z)); for (const x of [-2.8, -0.9, 1.0]) g.add(box(0.9, 0.5, 0.12, D, x, 2.3, z)); } // team side panels + windows
        for (const [z, r] of [[1.6, 0.5], [-1.6, -0.5]]) {    // gabled roof: 2 angled slabs
          const slab = box(8.6, 0.3, 3.9, S, 0, 4.35, z); slab.rotation.x = r; g.add(slab);
        }
        g.add(box(8.7, 0.3, 0.45, T, 0, 5.2, 0));                 // ridge cap (team trim)
        const gable = new THREE.Mesh(geo('gable', () => {             // triangular attic under the slabs
          const sh = new THREE.Shape(); sh.moveTo(-3.2, 0); sh.lineTo(3.2, 0); sh.lineTo(0, 1.6); sh.lineTo(-3.2, 0);
          const gg = new THREE.ExtrudeGeometry(sh, { depth: 7.8, bevelEnabled: false }); gg.translate(0, 0, -3.9); gg.rotateY(Math.PI / 2); return gg;
        }), L);
        gable.position.y = 3.6; g.add(gable);
        g.add(box(0.3, 2.5, 2.6, D, 3.92, 1.45, 0));              // door recess (dark, set in)
        g.add(box(0.5, 2.9, 0.35, M, 4.05, 1.65, 1.5), box(0.5, 2.9, 0.35, M, 4.05, 1.65, -1.5));
        g.add(box(0.55, 0.45, 3.4, T, 4.08, 3.2, 0));             // team lintel
        g.add(box(0.2, 0.25, 2.2, LAMP, 4.2, 2.85, 0));
        for (const [x, z, h] of [[-2.6, 1.9, 3.4], [-3.2, -1.7, 2.4]]) { // 2 antennas
          g.add(cyl(0.07, 0.1, h, 5, M, x, 4.4 + h / 2, z));
          g.add(box(0.22, 0.22, 0.22, LIGHT, x, 4.45 + h, z));
        }
        break;
      }
      case 'factory': {
        g.add(plate(6.4, 5.4, 0.6));
        g.add(box(10, 4.2, 7.6, L, 0, 2.35, 0));                  // main shed
        g.add(box(10.1, 0.55, 7.7, T, 0, 3.9, 0));                // team band
        g.add(box(10.3, 0.4, 7.9, S, 0, 4.65, 0));                // roof
        for (const x of [-3.2, -1.2, 0.8]) {                      // 3 roof vents
          g.add(cyl(0.55, 0.65, 1.3, 8, D, x, 5.5, -1.6));
          g.add(cyl(0.8, 0.8, 0.18, 8, M, x, 6.25, -1.6));
        }
        g.add(box(5.5, 0.1, 0.12, M, -1.2, 4.9, 1.8));
        g.add(box(0.55, 3.6, 4.8, D, 4.8, 1.9, 0));               // rolling door recess
        for (let i = 0; i < 6; i++) g.add(box(0.12, 0.12, 4.4, M, 5.08, 0.6 + i * 0.52, 0)); // door slats
        g.add(box(0.6, 0.45, 5.4, T, 5.05, 3.95, 0));             // team header over door
        for (const z of [2.7, -2.7]) g.add(box(0.5, 4.0, 0.5, HAZ, 5.0, 2.0, z));
        // side crane: mast on the +z side, boom out over the door, cable + hook
        g.add(box(0.7, 7.6, 0.7, M, -2.5, 3.8, 4.6));
        g.add(box(9.6, 0.5, 0.55, HAZ, 1.8, 7.5, 4.6));
        g.add(box(1.3, 0.9, 1.0, S, -3.4, 7.5, 4.6));             // counterweight
        g.add(cyl(0.05, 0.05, 2.6, 4, D, 5.6, 6.0, 4.6));
        g.add(box(0.5, 0.35, 0.5, D, 5.6, 4.6, 4.6));
        break;
      }
      case 'turret_mg': {
        g.add(cyl(2.0, 2.1, 0.22, 8, PLATE, 0, 0.11, 0));
        g.add(cyl(1.5, 1.6, 1.2, 8, S, 0, 0.6, 0));
        const tur = new THREE.Group(); tur.position.y = 1.2;
        tur.add(cyl(0.9, 1.0, 0.7, 8, T, 0, 0.35, 0));
        for (const z of [0.28, -0.28]) { const b = cyl(0.1, 0.1, 1.8, 6, D, 1.2, 0.45, z); b.rotation.z = Math.PI / 2; tur.add(b); }
        g.add(tur); g.userData.turret = tur;
        break;
      }
      case 'turret_cannon': {
        g.add(cyl(2.0, 2.1, 0.22, 8, PLATE, 0, 0.11, 0));
        g.add(cyl(1.4, 1.6, 2.6, 8, S, 0, 1.3, 0));
        const tur = new THREE.Group(); tur.position.y = 2.6;
        tur.add(cyl(1.0, 1.2, 0.9, 8, T, 0, 0.45, 0));
        const b = cyl(0.2, 0.24, 3.2, 8, M, 2, 0.5, 0); b.rotation.z = Math.PI / 2; tur.add(b);
        g.add(tur); g.userData.turret = tur;
        break;
      }
      case 'artillery': {
        g.add(box(4.2, 0.22, 4.2, PLATE, 0, 0.11, 0));
        g.add(box(3.4, 0.8, 3.4, S, 0, 0.4, 0));
        const tur = new THREE.Group(); tur.position.y = 0.8;
        tur.add(cyl(1.2, 1.4, 0.8, 8, T, 0, 0.4, 0));
        const piv = new THREE.Group(); piv.position.y = 0.9; piv.rotation.z = 0.7;
        const b = cyl(0.28, 0.34, 3.8, 8, M, 1.7, 0, 0); b.rotation.z = Math.PI / 2; piv.add(b);
        tur.add(piv); g.add(tur); g.userData.turret = tur;
        break;
      }
      case 'wall': {
        g.add(box(4, 2, 1.5, mat(0x7a838d), 0, 1, 0));
        g.add(box(4.02, 0.25, 1.6, S, 0, 2.05, 0));               // slate cap
        g.add(box(3.2, 0.3, 1.54, T, 0, 1.45, 0));                // team stripe on both faces (panel)
        break;
      }
      case 'gate': {
        g.add(box(1.2, 4, 2, S, 0, 2, 2), box(1.2, 4, 2, S, 0, 2, -2));
        g.add(box(0.5, 3.2, 2.6, mat(tc, { emissive: tc, emissiveIntensity: 0.9, transparent: true, opacity: 0.8 }), 0, 1.8, 0));
        g.add(box(1.4, 0.4, 6, S, 0, 4.2, 0), box(1.42, 0.2, 3.2, T, 0, 4.2, 0));
        break;
      }
      case 'crystal': {
        const cm = mat(0x4fe6ff, { emissive: 0x168fb0, emissiveIntensity: 0.9 });
        const og = geo('oct', () => new THREE.OctahedronGeometry(1, 0));
        const r = rng((Math.random() * 1e9) | 0), n = 5 + ((r() * 3) | 0);
        for (let i = 0; i < n; i++) {
          const o = new THREE.Mesh(og, cm), a = (i / n) * 6.28 + r(), d = i ? 0.6 + r() * 0.8 : 0;
          const s = i ? 0.45 + r() * 0.4 : 0.9;
          o.scale.set(s * 0.6, s * (1.6 + r()), s * 0.6);
          o.position.set(Math.cos(a) * d, s * 1.3, Math.sin(a) * d);
          o.rotation.set((r() - 0.5) * 0.6, r() * 6, (r() - 0.5) * 0.6);
          g.add(o);
        }
        break;
      }
      default:
        g.add(box(1.5, 1.5, 1.5, T, 0, 0.75, 0));
    }
    g.userData.kind = kind;
    g.userData.height = HEIGHT[kind] ?? 2;
    return g;
  };
  const HEIGHT = { warden: 1.6, raider: 1.9, tank: 2.3, harvester: 2.4, cc: 12, barracks: 5.6, factory: 7.2, turret_mg: 2.2, turret_cannon: 3.6, artillery: 2.6, wall: 2.2, gate: 4.6, crystal: 3 };
  world.entityHeight = (e) => e.mesh?.userData?.height ?? HEIGHT[e.kind] ?? 2;

  // ---------- Contact shadows (soft radial blob under every unit; grounds them even with shadows off) ----------
  const blobTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(0,0,0,0.85)'); gr.addColorStop(0.45, 'rgba(0,0,0,0.5)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const blobMat = new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, opacity: 0.7,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const blobGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  function blob(r, x = 0, z = 0, sx = 1) {
    const m = new THREE.Mesh(blobGeo, blobMat);
    m.scale.set(r * 2 * sx, 1, r * 2); m.position.set(x, 0.035, z); m.renderOrder = 1;
    m.name = 'contactShadow'; m.userData.noShadow = true; m.raycast = () => {};
    return m;
  }
  world.contactShadow = blob;
  const UNIT_BLOB = { warden: [1.3, 1], raider: [1.5, 1.3], tank: [2.0, 1.25], harvester: [1.8, 1.25] };
  const RECEIVERS = new Set(['cc', 'barracks', 'factory', 'turret_mg', 'turret_cannon', 'artillery', 'wall', 'gate']);
  function decorate(g, kind) {
    g.traverse((o) => {
      if (!o.isMesh || o.userData.noShadow) return;
      const m = o.material;
      if (m && (m.transparent || (m.emissiveIntensity > 0.5 && kind === 'crystal'))) return;
      o.castShadow = true;
      if (RECEIVERS.has(kind)) o.receiveShadow = true;
    });
    if (UNIT_BLOB[kind] && !g.userData.squad && !g.getObjectByName('contactShadow')) g.add(blob(UNIT_BLOB[kind][0], 0, 0, UNIT_BLOB[kind][1]));
    return g;
  }

  // ---------- Animated warden squads (js/characters.js) ----------
  let chars = null;
  try { chars = await charsP; world.characters = { clips: chars.clipNames(), height: chars.SOLDIER_HEIGHT }; }
  catch (err) { console.warn('[engine] soldier.glb not loaded, using primitive wardens:', err?.message || err); chars = null; }
  const squads = new Set();
  const SQUAD_POS = [[0.7, 0], [-0.5, 0.72], [-0.5, -0.72]];
  function playSquad(sq, name, fade = 0.2) {
    sq.clip = name;
    sq.soldiers.forEach((s, i) => s.play(name, fade, { offset: sq.offsets[i] + Math.random() * 0.15 }));
  }
  function makeSquad(team) {
    const g = new THREE.Group(), inner = new THREE.Group();
    inner.name = 'squad'; g.add(inner);
    const sq = { group: g, inner, soldiers: [], offsets: [], clip: null, forced: null, dying: 0, last: null, speed: 0, seen: false };
    for (const [x, z] of SQUAD_POS) {
      const s = chars.makeSoldier(team, { faction: world.factions?.[team], leader: sq.soldiers.length === 0 }); // front soldier leads (horns on Clans)
      s.root.position.set(x, 0, z); s.root.rotation.y = (Math.random() - 0.5) * 0.3;
      s.delay = Math.random() * 0.35;
      inner.add(s.root, blob(0.5, x, z));
      sq.soldiers.push(s); sq.offsets.push(Math.random());
    }
    playSquad(sq, 'idle', 0);
    g.userData.squad = sq;
    g.userData.anim = { play: (name) => { sq.forced = name; if (sq.clip !== name) playSquad(sq, name); }, release: () => { sq.forced = null; } };
    g.userData.height = chars.SOLDIER_HEIGHT + 0.15;
    squads.add(sq);
    return g;
  }

  world.makeMesh = (kind, team = -1) => {
    let g = null;
    // Integrator: every faction's basic infantry renders as the animated soldier squad (roster kinds included).
    if ((kind === 'warden' || /_(trooper|brute|acolyte|skirmisher|ranger|infantry)$/.test(kind)) && chars) {
      try { g = makeSquad(team); g.scale.setScalar(1.5); /* integrator: readable next to vehicles on a phone */ } catch (err) { console.warn('[engine] squad build failed, primitive fallback:', err?.message); g = null; }
    }
    if (!g && models) {
      try { g = models.makeModel(THREE, kind, team, world.factions?.[team]) || null; } catch (err) { console.warn('[engine] makeModel failed', kind, err?.message); g = null; }
    }
    if (!g) g = makePrimitive(kind, team);
    g.userData.kind = kind;
    trackEnv(g);
    g.userData.height ??= HEIGHT[kind] ?? 2;
    return decorate(g, kind);
  };

  // A dead warden: sim has already pulled its mesh from the scene; put it back at the last position,
  // play 'die' once (each soldier slightly staggered), fade from 4s and drop it at 6s.
  world.bus.addEventListener('died', (ev) => {
    const e = ev.detail?.entity, sq = e?.mesh?.userData?.squad;
    if (!sq || sq.dying) return;
    const g = sq.group;
    if (Number.isFinite(e.x)) g.position.set(e.x, 0, e.z);
    if (Number.isFinite(e.rot)) g.rotation.y = e.rot;
    g.userData.entity = null;
    if (!g.parent) scene.add(g);
    sq.dying = 1e-4; sq.forced = 'die'; sq.inner.visible = true;
  });
  const DIE_FADE = 4, DIE_END = 6;
  function startFade(sq) {
    sq.fadeMats = [];
    sq.group.traverse((o) => {
      if (!o.isMesh) return;
      const m = o.material.clone();
      m.onBeforeCompile = o.material.onBeforeCompile;
      m.transparent = true; m.depthWrite = o.name !== 'contactShadow' ? true : false;
      m.userData.baseOpacity = o.material.opacity;
      o.material = m; o.castShadow = false; sq.fadeMats.push(m);
    });
  }

  const _frustum = new THREE.Frustum(), _pm = new THREE.Matrix4(), _sph = new THREE.Sphere(new THREE.Vector3(), 2.6);
  function updateSquads(dt) {
    if (!squads.size) return;
    const cam = world.camera;
    _pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pm);
    for (const sq of squads) {
      const g = sq.group, p = g.position;
      if (sq.dying) {
        sq.dying += dt;
        for (const s of sq.soldiers) if (s.current !== 'die' && sq.dying >= s.delay) { s.play('die', 0.15); s.actions.die.timeScale = 1; }
        if (sq.dying > DIE_FADE && !sq.fadeMats) startFade(sq);
        if (sq.fadeMats) {
          const f = Math.max(0, 1 - (sq.dying - DIE_FADE) / (DIE_END - DIE_FADE));
          for (const m of sq.fadeMats) m.opacity = m.userData.baseOpacity * f;
        }
        if (sq.dying >= DIE_END) {
          g.parent?.remove(g); squads.delete(sq);
          for (const m of sq.fadeMats || []) m.dispose();
          for (const s of sq.soldiers) s.mixer.stopAllAction();
          continue;
        }
      } else if (!g.parent) { // not yet added by sim, or removed without a died event
        if (sq.seen) { squads.delete(sq); for (const s of sq.soldiers) s.mixer.stopAllAction(); }
        continue;
      } else {
        sq.seen = true;
        const e = g.userData.entity;
        if (sq.last && dt > 0) {
          const v = Math.hypot(p.x - sq.last.x, p.z - sq.last.z) / dt;
          sq.speed += (Math.min(v, 30) - sq.speed) * Math.min(1, dt * 8);
        }
        sq.last = sq.last || {}; sq.last.x = p.x; sq.last.z = p.z;
        let want = 'idle';
        if (sq.forced) want = sq.forced;
        else if (sq.speed > 0.5 || e?.state === 'move') want = 'walk';
        else if (e?.state === 'attack' && e.target) want = 'fire';
        if (want !== sq.clip) playSquad(sq, want);
        for (const s of sq.soldiers) {
          const a = s.actions[sq.clip];
          if (!a) continue;
          if (sq.clip === 'walk') a.timeScale = sq.forced ? 1 : Math.max(0.9, Math.min(2.4, sq.speed / chars.WALK_SPEED));
          else if (sq.clip === 'fire') a.timeScale = sq.forced ? 1 : Math.max(0.7, Math.min(1.6, a.getClip().duration / (e?.fireRate || 1.1)));
          else a.timeScale = 1;
        }
      }
      _sph.center.set(p.x, 0.9, p.z);
      const vis = _frustum.intersectsSphere(_sph);
      sq.inner.visible = vis;
      if (vis) for (const s of sq.soldiers) s.mixer.update(dt);
    }
  }
  world.squadCount = () => squads.size;

  // ---------- Shadow frustum: fit the sun's ortho camera to the visible ground, recentred on camTarget ----------
  const _lp = new THREE.Vector3();
  let shadowFit = '';
  function fitShadow() {
    if (!SHADOW) return;
    const t = world.camTarget;
    sun.target.position.set(t.x, 0, t.z);
    sun.position.set(t.x + SUN_DIR.x * 150, SUN_DIR.y * 150, t.z + SUN_DIR.z * 150);
    sun.updateMatrixWorld(); sun.target.updateMatrixWorld();
    const sc = sun.shadow.camera;
    sc.position.copy(sun.position); sc.lookAt(sun.target.position); sc.updateMatrixWorld();
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const c of world.viewCorners()) for (const y of [0, 6]) {
      _lp.set(c.x, y, c.z).applyMatrix4(sc.matrixWorldInverse);
      x0 = Math.min(x0, _lp.x); x1 = Math.max(x1, _lp.x); y0 = Math.min(y0, _lp.y); y1 = Math.max(y1, _lp.y);
    }
    const MAXH = world.view === 'aerial' ? 170 : 80, q = 4; // clamp so the map keeps resolution; quantise to avoid resizing every pan
    const cl = (v) => Math.max(-MAXH, Math.min(MAXH, v));
    x0 = Math.floor(cl(x0 - 4) / q) * q; x1 = Math.ceil(cl(x1 + 4) / q) * q;
    y0 = Math.floor(cl(y0 - 4) / q) * q; y1 = Math.ceil(cl(y1 + 6) / q) * q;
    const key = x0 + ',' + x1 + ',' + y0 + ',' + y1;
    if (key !== shadowFit) {
      shadowFit = key;
      sc.left = x0; sc.right = x1; sc.bottom = y0; sc.top = y1; sc.updateProjectionMatrix();
    }
  }

  // ---------- Input ----------
  const input = world.input;
  const pending = { tap: null, command: null };
  const seen = { tap: null, drag: null, command: null };
  const pointers = new Map();
  let gesture = null; // 'pending' | 'drag' | 'pan' | 'multi' | 'none'
  let multi = null, lastTap = { t: 0, ent: null };
  const isUnit = (e) => e.cls === 'inf' || e.cls === 'veh';
  const alive = (e) => e && e.state !== 'dead' && !(e.hp <= 0) && world.entities.includes(e);

  function pickEntity(sx, sy, gp) {
    setRay(sx, sy);
    const meshes = [], byMesh = new Map();
    for (const e of world.entities) if (e.mesh) { meshes.push(e.mesh); byMesh.set(e.mesh, e); }
    const hits = raycaster.intersectObjects(meshes, true);
    for (const h of hits) {
      let o = h.object;
      while (o) { if (o.userData?.entity) return o.userData.entity; if (byMesh.has(o)) return byMesh.get(o); o = o.parent; }
    }
    if (!gp) return null; // fat-finger fallback: nearest entity within radius + slop
    let best = null, bd = Infinity;
    const slop = world.view === 'aerial' ? VIEWS.aerial.zoom * 0.05 : 2;
    for (const e of world.entities) {
      const d = Math.hypot(e.x - gp.x, e.z - gp.z) - (e.r || 1);
      if (d < slop && d < bd) { bd = d; best = e; }
    }
    return best;
  }

  function handleTap(sx, sy) {
    const gp = world.groundAt(sx, sy);
    if (!gp) return;
    const hit = pickEntity(sx, sy, gp);
    const now = performance.now();
    const tap = { x: gp.x, z: gp.z, hit, sx, sy };
    if (hit && lastTap.ent === hit && now - lastTap.t < 350) tap.double = true;
    lastTap = { t: now, ent: hit };
    pending.tap = tap;
    const sel = input.selected;
    const selUnits = [...sel].filter(isUnit);
    if (hit && hit.team === 0) {
      sel.clear();
      if (tap.double && isUnit(hit)) {
        for (const e of world.entities) if (e.team === 0 && e.kind === hit.kind && alive(e)) sel.add(e);
      } else sel.add(hit);
    } else if (hit && hit.team === 1) {
      if (selUnits.length) pending.command = { type: 'attack', x: hit.x, z: hit.z, target: hit };
      else { sel.clear(); }
    } else if (selUnits.length) {
      pending.command = { type: 'move', x: gp.x, z: gp.z, target: hit || null };
    } else sel.clear();
    world.bus.dispatchEvent(new CustomEvent('select', { detail: { selected: sel } }));
  }

  function boxSelect(d) {
    const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1), z0 = Math.min(d.z0, d.z1), z1 = Math.max(d.z0, d.z1);
    // Use screen-space box for perspective views so the box matches what was drawn.
    const s0 = d.s0, s1 = d.s1;
    const sx0 = Math.min(s0.x, s1.x), sx1 = Math.max(s0.x, s1.x), sy0 = Math.min(s0.y, s1.y), sy1 = Math.max(s0.y, s1.y);
    const picked = [];
    for (const e of world.entities) {
      if (e.team !== 0 || !isUnit(e) || !alive(e)) continue;
      const p = world.project(e.x, 0, e.z);
      if (p.x >= sx0 && p.x <= sx1 && p.y >= sy0 && p.y <= sy1) picked.push(e);
      else if (world.view === 'aerial' && e.x >= x0 && e.x <= x1 && e.z >= z0 && e.z <= z1) picked.push(e);
    }
    if (picked.length) { input.selected.clear(); picked.forEach(e => input.selected.add(e)); }
    world.bus.dispatchEvent(new CustomEvent('select', { detail: { selected: input.selected } }));
  }

  function pan(fromX, fromY, toX, toY) {
    const a = world.groundAt(fromX, fromY), b = world.groundAt(toX, toY);
    if (!a || !b) return;
    world.camTarget.x += a.x - b.x; world.camTarget.z += a.z - b.z;
    updateCamera();
  }
  function local(e) { const r = overlay.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function multiState() {
    const ps = [...pointers.values()];
    const cx = (ps[0].x + ps[1].x) / 2, cy = (ps[0].y + ps[1].y) / 2;
    return { cx, cy, dist: Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y) };
  }

  overlay.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { overlay.setPointerCapture(e.pointerId); } catch {}
    const p = local(e);
    pointers.set(e.pointerId, { ...p, sx: p.x, sy: p.y, t: performance.now() });
    if (pointers.size === 2) {
      gesture = 'multi'; multi = multiState();
      if (input.drag && !input.drag.done) input.drag = null;
    } else if (pointers.size === 1) {
      gesture = (e.pointerType === 'mouse' && (e.button === 2 || e.button === 1)) ? 'pan' : 'pending';
    }
  }, { passive: false });

  overlay.addEventListener('pointermove', (e) => {
    const pt = pointers.get(e.pointerId);
    if (!pt) return;
    e.preventDefault();
    const p = local(e), px = pt.x, py = pt.y;
    pt.x = p.x; pt.y = p.y;
    if (gesture === 'multi' && pointers.size >= 2) {
      const m = multiState();
      pan(multi.cx, multi.cy, m.cx, m.cy);
      if (multi.dist > 10 && m.dist > 10) world.zoomBy(multi.dist / m.dist);
      multi = m;
    } else if (gesture === 'pan') {
      pan(px, py, p.x, p.y);
    } else if (gesture === 'pending' && Math.hypot(p.x - pt.sx, p.y - pt.sy) >= 10) {
      // Integrator (user request): a quick one-finger drag scrolls the map; press-and-hold (≥350ms) then drag = box select.
      gesture = (performance.now() - pt.t >= 350) ? 'drag' : 'pan';
      if (gesture === 'pan') pan(pt.sx, pt.sy, p.x, p.y);
    }
    if (gesture === 'drag') {
      const a = world.groundAt(pt.sx, pt.sy), b = world.groundAt(p.x, p.y);
      if (a && b) input.drag = { x0: a.x, z0: a.z, x1: b.x, z1: b.z, done: false, s0: { x: pt.sx, y: pt.sy }, s1: { x: p.x, y: p.y } };
    }
  }, { passive: false });

  function up(e) {
    const pt = pointers.get(e.pointerId);
    if (!pt) return;
    e.preventDefault();
    pointers.delete(e.pointerId);
    if (gesture === 'multi') { if (pointers.size === 0) gesture = null; else gesture = 'none'; return; }
    if (pointers.size) return;
    if (gesture === 'pending' && e.type === 'pointerup' && performance.now() - pt.t < 300) handleTap(pt.x, pt.y);
    else if (gesture === 'drag' && input.drag) { input.drag.done = true; boxSelect(input.drag); }
    gesture = null;
  }
  overlay.addEventListener('pointerup', up, { passive: false });
  overlay.addEventListener('pointercancel', up, { passive: false });
  overlay.addEventListener('contextmenu', (e) => e.preventDefault());
  overlay.addEventListener('wheel', (e) => { e.preventDefault(); world.zoomBy(Math.exp(e.deltaY * 0.0015)); }, { passive: false });
  for (const ev of ['gesturestart', 'gesturechange']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });

  const keys = new Set();
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === '1') world.setView('aerial'); else if (k === '2') world.setView('tactical'); else if (k === '3') world.setView('low');
    else keys.add(k);
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => keys.clear());

  // ---------- Overlay ----------
  const hex = (n) => '#' + n.toString(16).padStart(6, '0');
  function ringPath(x, z, r) {
    octx.beginPath();
    for (let i = 0; i <= 24; i++) {
      const a = i / 24 * Math.PI * 2, p = world.project(x + Math.cos(a) * r, 0.05, z + Math.sin(a) * r);
      i ? octx.lineTo(p.x, p.y) : octx.moveTo(p.x, p.y);
    }
  }
  function drawOverlay() {
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, overlay.width, overlay.height);
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sel = input.selected;
    for (const e of world.entities) {
      if ((e.team < 0 && !sel.has(e)) || e.hidden) continue; // TERRAIN: fogged enemies get no ring
      const selected = sel.has(e);
      const c = world.colors[e.team] ?? 0x39d8ff;
      if (!selected && !(e.cls === 'inf' || e.cls === 'veh')) continue;
      const p = world.project(e.x, 0, e.z);
      if (!p.visible || p.x < -60 || p.y < -60 || p.x > W + 60 || p.y > H + 60) continue;
      ringPath(e.x, e.z, (e.r || 1.2) * 1.15);
      octx.lineWidth = selected ? 2.2 : 1.2;
      octx.strokeStyle = selected ? '#9ff0ff' : hex(c) + '88';
      if (selected) { octx.shadowColor = hex(c); octx.shadowBlur = 6; }
      octx.stroke(); octx.shadowBlur = 0;
    }
    for (const e of world.entities) {
      if (!(e.hpMax > 0) || e.team < 0 || e.hidden) continue; // TERRAIN: no health bar for fogged enemies
      const selected = sel.has(e);
      if (!(e.hp < e.hpMax) && !selected) continue;
      const aer = world.view === 'aerial';
      const top = world.project(e.x, world.entityHeight(e) + 0.6, aer ? e.z - (e.r || 1) * 1.1 : e.z);
      if (!top.visible || top.x < -60 || top.y < -60 || top.x > W + 60 || top.y > H + 60) continue;
      const edge = world.project(e.x + (e.r || 1), world.entityHeight(e) + 0.6, aer ? e.z - (e.r || 1) * 1.1 : e.z);
      const bw = Math.max(18, Math.min(90, Math.abs(edge.x - top.x) * 2.2)), bh = bw > 50 ? 5 : 4;
      const f = Math.max(0, Math.min(1, e.hp / e.hpMax));
      const x = top.x - bw / 2, y = top.y - bh - 2;
      octx.fillStyle = 'rgba(5,10,15,0.75)'; octx.fillRect(x - 1, y - 1, bw + 2, bh + 2);
      octx.fillStyle = f > 0.6 ? '#46e27a' : f > 0.3 ? '#f2c94c' : '#ff4d4d';
      octx.fillRect(x, y, bw * f, bh);
      if (e.team === 1) { octx.fillStyle = '#e23a3a'; octx.fillRect(x, y + bh - 1, bw * f, 1); }
    }
    const d = input.drag;
    if (d && !d.done && d.s0) {
      const x = Math.min(d.s0.x, d.s1.x), y = Math.min(d.s0.y, d.s1.y), w = Math.abs(d.s1.x - d.s0.x), h = Math.abs(d.s1.y - d.s0.y);
      octx.fillStyle = 'rgba(57,216,255,0.12)'; octx.fillRect(x, y, w, h);
      octx.strokeStyle = '#39d8ff'; octx.lineWidth = 1.5; octx.setLineDash([6, 4]); octx.strokeRect(x, y, w, h); octx.setLineDash([]);
    }
  }

  // ---------- Loop ----------
  const callbacks = [];
  world.onFrame = (fn) => { callbacks.push(fn); return () => { const i = callbacks.indexOf(fn); if (i >= 0) callbacks.splice(i, 1); }; };
  let last = performance.now();
  const bootT = performance.now();
  function frame(now) {
    const realDt = Math.max(0, (now - last) / 1000); last = now;
    // clear inputs consumed last frame, then apply new ones
    if (input.tap && input.tap === seen.tap) input.tap = null;
    if (input.command && input.command === seen.command) input.command = null;
    if (input.drag && input.drag.done && input.drag === seen.drag) input.drag = null;
    if (pending.tap) { input.tap = pending.tap; pending.tap = null; }
    if (pending.command) { input.command = pending.command; pending.command = null; }
    for (const e of [...input.selected]) if (!alive(e)) input.selected.delete(e);

    if (keys.size) {
      const sp = (world.view === 'aerial' ? VIEWS.aerial.zoom : VIEWS[world.view].zoom * 0.6) * 1.2 * Math.min(realDt, 0.05);
      if (keys.has('w') || keys.has('arrowup')) world.camTarget.z -= sp;
      if (keys.has('s') || keys.has('arrowdown')) world.camTarget.z += sp;
      if (keys.has('a') || keys.has('arrowleft')) world.camTarget.x -= sp;
      if (keys.has('d') || keys.has('arrowright')) world.camTarget.x += sp;
      updateCamera();
    }

    world.clock.dt = Math.min(realDt, 0.25) * world.clock.speed; // sim substeps internally; slow frames don't slow the game
    world.clock.t += world.clock.dt;
    for (const fn of callbacks) {
      try { fn(world.clock.dt); } catch (err) { console.error('[engine] frame callback error', err); }
    }
    seen.tap = input.tap; seen.command = input.command; seen.drag = input.drag;
    updateCamera();
    // Startup: don't render until the other modules have wired up (or 5s). On slow GPUs (and headless
    // swiftshader) first frames upload/mip every texture and starve main.js's module imports.
    if (!world.sim && now - bootT < 5000) { requestAnimationFrame(frame); return; }
    try { updateSquads(world.clock.dt); } catch (err) { console.error('[engine] squad anim error', err); }
    try { terrain?.update?.(world.clock.dt); } catch (err) { console.error('[engine] terrain.update error', err); }
    try { models?.updateModels?.(world.clock.dt, world.clock.t); } catch (err) { console.error('[engine] updateModels error', err); }
    updateEnvNight();
    fitShadow();
    renderer.render(scene, world.camera);
    drawOverlay();
    requestAnimationFrame(frame);
  }

  resize();
  world.setView('tactical');
  if (world.ground) { trackEnv(world.ground); world.ground.receiveShadow = true; }
  // Integrator: base decor is placed at each team's real cc once the sim has spawned (main.js calls world.decorateBases()).
  world.decorateBases = () => { if (models?.decorateBase) for (const cc of world.entities.filter(e => e.kind === 'cc' && e.team >= 0)) {
    try { const d = models.decorateBase(THREE, scene, cc.team, cc.x, cc.z, world.factions?.[cc.team]); d?.traverse?.((o) => { if (o.isMesh && !o.material?.transparent) { o.castShadow = true; o.receiveShadow = true; } }); trackEnv(d); }
    catch (err) { console.warn('[engine] decorateBase failed', err?.message); }
  } };
  if (false) for (const [team, b] of BASES.entries()) {
    try { const d = models.decorateBase(THREE, scene, team, b.x, b.z, world.factions?.[team]); d?.traverse?.((o) => { if (o.isMesh && !o.material?.transparent) { o.castShadow = true; o.receiveShadow = true; } }); trackEnv(d); }
    catch (err) { console.warn('[engine] decorateBase failed', err?.message); }
  }

  // ---------- Demo (?demo=1): one mesh of every kind ----------
  if (new URLSearchParams(location.search).get('demo') === '1') {
    const kinds = [['cc', 0, 8], ['barracks', 0, 5], ['factory', 0, 5], ['warden', 0, 1.2], ['raider', 0, 1.6], ['tank', 0, 2.2],
      ['harvester', 0, 2], ['turret_mg', 0, 1.5], ['turret_cannon', 1, 1.5], ['artillery', 1, 1.5], ['wall', 1, 2], ['gate', 1, 2.5], ['crystal', -1, 2]];
    const cls = { warden: 'inf', raider: 'veh', tank: 'veh', harvester: 'veh', crystal: 'neutral' };
    kinds.forEach(([k, team, r], i) => {
      const col = i % 5, row = (i / 5) | 0;
      const x = -22 + col * 11 + (k === 'cc' ? -4 : 0), z = -10 + row * 13;
      const mesh = world.makeMesh(k, team); mesh.position.set(x, 0, z); mesh.rotation.y = -0.5;
      scene.add(mesh);
      const ent = { id: 'demo' + i, demo: true, kind: k, team, x, z, rot: 0.5, r, hp: 60 + i * 3, hpMax: 100, cls: cls[k] || 'bld',
        mesh, state: 'idle', target: null, dest: null, cooldown: 0, range: 0, dps: 0, speed: 0, carry: 0 };
      mesh.userData.entity = ent;
      world.entities.push(ent);
      if (k === 'tank' || k === 'warden') input.selected.add(ent);
    });
    world.jumpTo(-4, 4);
  }

  // ---------- Gallery (?gallery=1): 3 player + 3 enemy warden squads in front of the player base ----------
  // Not sim entities (pure scene props), so the sim never targets them. Cycles clips every 2s;
  // world.gallery.show(name) pins one clip (used by tools/gallery-shots.mjs).
  if (params.get('gallery') === '1') {
    const B = BASES[0], cx = B.x + 31, cz = B.z + 3;
    const lineup = [];
    for (let i = 0; i < 3; i++) for (const side of [0, 1]) { // rows: vanguard|volcanic, earth|storm, vanguard|volcanic
      const team = side + (i === 1 ? 2 : 0);
      const g = world.makeMesh('warden', team);
      g.position.set(cx + (side ? 5 : -5), 0, cz - 6 + i * 6);
      g.rotation.y = side ? Math.PI : 0;
      scene.add(g); lineup.push(g);
    }
    const order = ['idle', 'walk', 'fire', 'reload', 'melee', 'die'];
    let k = 0, pinned = null;
    const showAll = (n) => lineup.forEach((g) => g.userData.anim?.play(n));
    showAll(order[0]);
    const iv = setInterval(() => { if (!pinned) showAll(order[k = (k + 1) % order.length]); }, 2000);
    world.gallery = { lineup, show: (n) => { pinned = n; showAll(n); }, cycle: () => { pinned = null; }, stop: () => clearInterval(iv) };
    world.jumpTo(cx - 9, cz);
  }

  requestAnimationFrame(frame);
  return world;
}
