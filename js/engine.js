// Vanguard engine: scene, 3 cameras, render loop, input + selection, ground, obstacles, meshes, overlay.
// TODO.md (engine):
//  - Models face local +X. If sim uses rot = atan2(dz, dx), set mesh.rotation.y = -rot.
//  - Tank/turret aim: rotate mesh.userData.turret.rotation.y (local, same +X convention).
//  - world.lights {hemi, sun} exposed for fx day/night tinting.
import * as THREE from 'three';

const VIEWS = {
  aerial:   { zoom: 36, min: 16, max: 56 },             // ortho half-height
  tactical: { pitch: 68, fov: 50, zoom: 70, min: 35, max: 150 },
  low:      { pitch: 40, fov: 55, zoom: 48, min: 22, max: 90 },
};
const BASES = [{ x: -55, z: 25 }, { x: 55, z: -25 }];

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

export async function createEngine() {
  const glCanvas = document.getElementById('gl');
  const overlay = document.getElementById('overlay');
  for (const c of [glCanvas, overlay]) c.style.touchAction = 'none';
  const octx = overlay.getContext('2d');

  const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, powerPreference: 'high-performance' });
  renderer.shadowMap.enabled = false;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x2a1e15);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9c6a3e);
  scene.fog = new THREE.Fog(0x9c6a3e, 200, 500);

  const hemi = new THREE.HemisphereLight(0xfff0d8, 0x6b4a2b, 1.1);
  const sun = new THREE.DirectionalLight(0xfff2e0, 1.7);
  sun.position.set(-60, 120, 40);
  scene.add(hemi, sun);

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
    camTarget: { x: BASES[0].x, z: BASES[0].z },
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

  function clampTarget() {
    const t = world.camTarget, hw = world.map.w / 2, hh = world.map.h / 2;
    // keep most of the screen over the map: allow up to ~55% of the half-view off-map
    const v = VIEWS[world.view], a = W / H;
    const vh = world.view === 'aerial' ? v.zoom : v.zoom * Math.tan(THREE.MathUtils.degToRad(v.fov / 2));
    const mx = Math.min(hw, vh * a * 0.45), mz = Math.min(hh, vh * 0.45);
    t.x = Math.max(-hw + mx, Math.min(hw - mx, t.x));
    t.z = Math.max(-hh + mz, Math.min(hh - mz, t.z));
  }
  function updateCamera() {
    clampTarget();
    const t = world.camTarget, v = VIEWS[world.view], cam = cams[world.view];
    if (world.view === 'aerial') {
      const a = W / H;
      cam.left = -v.zoom * a; cam.right = v.zoom * a; cam.top = v.zoom; cam.bottom = -v.zoom;
      cam.position.set(t.x, 300, t.z);
      cam.lookAt(t.x, 0, t.z);
    } else {
      const p = THREE.MathUtils.degToRad(v.pitch);
      cam.aspect = W / H;
      cam.position.set(t.x, Math.sin(p) * v.zoom, t.z + Math.cos(p) * v.zoom);
      cam.lookAt(t.x, 0, t.z);
    }
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
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
    dpr = Math.min(window.devicePixelRatio || 1, 2);
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
  const groundTex = new THREE.CanvasTexture(groundCanvas());
  function prepTex(t) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(8, 5);
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    return t;
  }
  prepTex(groundTex);
  const groundMat = new THREE.MeshLambertMaterial({ map: groundTex });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(world.map.w, world.map.h), groundMat);
  ground.rotation.x = -Math.PI / 2; ground.name = 'ground';
  scene.add(ground);
  const outerTex = groundTex.clone(); outerTex.repeat.set(45, 45); outerTex.needsUpdate = true;
  const outer = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), new THREE.MeshLambertMaterial({ map: outerTex, color: 0x9a8070 }));
  outer.rotation.x = -Math.PI / 2; outer.position.y = -0.05; scene.add(outer);
  { // map border
    const bm = new THREE.MeshBasicMaterial({ color: 0x4a2e18, transparent: true, opacity: 0.55 }), w = world.map.w, h = world.map.h, th = 0.8;
    for (const [bw, bd, x, z] of [[w + th * 2, th, 0, -h / 2 - th / 2], [w + th * 2, th, 0, h / 2 + th / 2], [th, h, -w / 2 - th / 2, 0], [th, h, w / 2 + th / 2, 0]]) {
      const b = new THREE.Mesh(new THREE.PlaneGeometry(bw, bd), bm); b.rotation.x = -Math.PI / 2; b.position.set(x, 0.03, z); scene.add(b);
    }
  }
  world.ground = ground;
  world.setGroundTexture = (url) => new THREE.TextureLoader().load(url, (t) => {
    prepTex(t); groundMat.map = t; groundMat.needsUpdate = true;
  });

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
      grp.position.set(x, 0, z); grp.userData.kind = 'rock';
      scene.add(grp);
    }
  }

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
  const SLATE = 0x59626e, DARK = 0x2a2f36, METAL = 0x9aa3ad;

  world.makeMesh = (kind, team = -1) => {
    const tc = world.colors[team] ?? 0xbbbbbb;
    const T = mat(tc), Td = mat(shade(tc, 0.6)), S = mat(SLATE), D = mat(DARK), M = mat(METAL);
    const g = new THREE.Group();
    switch (kind) {
      case 'warden': {
        const capG = geo('cap', () => new THREE.CapsuleGeometry(0.36, 0.7, 3, 8));
        for (const [ox, oz] of [[0.55, 0], [-0.35, 0.5], [-0.35, -0.5]]) {
          const s = new THREE.Group();
          const body = new THREE.Mesh(capG, T); body.position.y = 0.6; s.add(body);
          s.add(box(0.18, 0.14, 0.42, D, 0.24, 1.0, 0)); // visor
          s.add(cyl(0.08, 0.08, 0.8, 6, D, -0.05, 0.85, 0.32)).rotation.z = Math.PI / 2; // rocket tube
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
        g.add(cyl(8, 8.4, 1.4, 6, S, 0, 0.7, 0));
        g.add(cyl(6.2, 7.4, 3.2, 6, T, 0, 3, 0));
        g.add(cyl(4.2, 5.2, 2.0, 6, Td, 0, 5.6, 0));
        g.add(cyl(0.25, 0.25, 3, 6, M, 2.2, 7.6, 1.2));
        const dish = new THREE.Mesh(geo('dish', () => new THREE.SphereGeometry(1.8, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2.6)), mat(0xd8dde3, { side: THREE.DoubleSide }));
        dish.position.set(2.2, 9.6, 1.2); dish.rotation.set(Math.PI * 0.85, 0, 0.4); g.add(dish);
        g.add(cyl(1.2, 1.2, 0.4, 6, mat(0x39d8ff, { emissive: 0x1aa0cc }), 0, 6.8, 0));
        break;
      }
      case 'barracks': {
        g.add(box(9, 0.6, 7.4, S, 0, 0.3, 0));
        g.add(box(8, 4, 6.4, T, 0, 2.6, 0));
        g.add(box(8.4, 0.5, 6.8, Td, 0, 4.85, 0));
        g.add(box(0.3, 2.6, 2.6, D, 4.1, 1.9, 0)); // door slab
        g.add(box(0.25, 0.4, 2.8, mat(0xffd27a, { emissive: 0x8a5a00 }), 4.15, 3.4, 0));
        break;
      }
      case 'factory': {
        g.add(box(10, 0.6, 8, S, 0, 0.3, 0));
        g.add(box(9.4, 4.4, 7, T, 0, 2.8, 0));
        g.add(box(9.6, 0.4, 7.2, Td, 0, 5.2, 0));
        g.add(box(3, 1.2, 3, D, -1.5, 6, 0)); // roof vent
        for (let i = 0; i < 3; i++) g.add(box(2.8, 0.15, 0.2, M, -1.5, 6.65, -1 + i));
        g.add(cyl(0.6, 0.7, 3, 8, S, 3, 6.6, 2.2));
        g.add(box(0.3, 3.2, 4.2, D, 4.75, 2.2, 0));
        break;
      }
      case 'turret_mg': {
        g.add(cyl(1.5, 1.6, 1.2, 8, S, 0, 0.6, 0));
        const tur = new THREE.Group(); tur.position.y = 1.2;
        tur.add(cyl(0.9, 1.0, 0.7, 8, T, 0, 0.35, 0));
        for (const z of [0.28, -0.28]) { const b = cyl(0.1, 0.1, 1.8, 6, D, 1.2, 0.45, z); b.rotation.z = Math.PI / 2; tur.add(b); }
        g.add(tur); g.userData.turret = tur;
        break;
      }
      case 'turret_cannon': {
        g.add(cyl(1.4, 1.6, 2.6, 8, S, 0, 1.3, 0));
        const tur = new THREE.Group(); tur.position.y = 2.6;
        tur.add(cyl(1.0, 1.2, 0.9, 8, T, 0, 0.45, 0));
        const b = cyl(0.2, 0.24, 3.2, 8, M, 2, 0.5, 0); b.rotation.z = Math.PI / 2; tur.add(b);
        g.add(tur); g.userData.turret = tur;
        break;
      }
      case 'artillery': {
        g.add(box(3.4, 0.8, 3.4, S, 0, 0.4, 0));
        const tur = new THREE.Group(); tur.position.y = 0.8;
        tur.add(cyl(1.2, 1.4, 0.8, 8, T, 0, 0.4, 0));
        const piv = new THREE.Group(); piv.position.y = 0.9; piv.rotation.z = 0.7;
        const b = cyl(0.28, 0.34, 3.8, 8, M, 1.7, 0, 0); b.rotation.z = Math.PI / 2; piv.add(b);
        tur.add(piv); g.add(tur); g.userData.turret = tur;
        break;
      }
      case 'wall': {
        g.add(box(4, 2, 1.5, mat(0x5b6470), 0, 1, 0));
        g.add(box(4.02, 0.3, 1.52, T, 0, 1.55, 0));
        break;
      }
      case 'gate': {
        g.add(box(1.2, 4, 2, S, 0, 2, 2), box(1.2, 4, 2, S, 0, 2, -2));
        g.add(box(0.5, 3.2, 2.6, mat(tc, { emissive: tc, emissiveIntensity: 0.9, transparent: true, opacity: 0.8 }), 0, 1.8, 0));
        g.add(box(1.4, 0.4, 6, Td, 0, 4.2, 0));
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
  const HEIGHT = { warden: 1.6, raider: 1.9, tank: 2.3, harvester: 2.4, cc: 10, barracks: 5.4, factory: 7, turret_mg: 2.2, turret_cannon: 3.6, artillery: 2.6, wall: 2.2, gate: 4.6, crystal: 3 };
  world.entityHeight = (e) => e.mesh?.userData?.height ?? HEIGHT[e.kind] ?? 2;

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
      gesture = 'drag';
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
      if (e.team < 0 && !sel.has(e)) continue;
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
      if (!(e.hpMax > 0) || e.team < 0) continue;
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

    world.clock.dt = Math.min(realDt, 0.05) * world.clock.speed;
    world.clock.t += world.clock.dt;
    for (const fn of callbacks) {
      try { fn(world.clock.dt); } catch (err) { console.error('[engine] frame callback error', err); }
    }
    seen.tap = input.tap; seen.command = input.command; seen.drag = input.drag;
    updateCamera();
    renderer.render(scene, world.camera);
    drawOverlay();
    requestAnimationFrame(frame);
  }

  resize();
  world.setView('tactical');

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

  requestAnimationFrame(frame);
  return world;
}
